'use client';

import { useEffect, useMemo } from 'react';
import {
  ApolloClient,
  ApolloProvider,
  HttpLink,
  InMemoryCache,
  split,
} from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import { NhostProvider } from '@nhost/nextjs';
import { nhost } from '@/lib/nhost';
import { OrgProvider } from '@/components/OrgContext';

/**
 * The Apollo client is wired by hand rather than through a helper, because
 * every permission rule in this app resolves the caller from
 * X-Hasura-User-Id — a request that goes out without the token is not a
 * degraded request, it is an anonymous one, and it silently returns nothing.
 *
 * Both transports read the token at call time (not at client-construction
 * time), so a session restored a moment after mount, or an access token
 * refreshed mid-session, is picked up without rebuilding anything.
 */
function makeClient() {
  const httpUrl = nhost.graphql.getUrl();

  const httpLink = new HttpLink({ uri: httpUrl });

  const authLink = setContext(async (_operation, { headers }) => {
    // wait for a session restored from storage before the first query fires
    await nhost.auth.isAuthenticatedAsync();
    const token = nhost.auth.getAccessToken();
    return {
      headers: {
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  });

  // subscriptions carry the token in the connection payload instead of a header
  const wsLink =
    typeof window === 'undefined'
      ? null
      : new GraphQLWsLink(
          createClient({
            url: httpUrl.replace(/^http/, 'ws'),
            lazy: true,
            retryAttempts: Infinity,
            connectionParams: async () => {
              await nhost.auth.isAuthenticatedAsync();
              const token = nhost.auth.getAccessToken();
              return token
                ? { headers: { Authorization: `Bearer ${token}` } }
                : {};
            },
          })
        );

  const link = wsLink
    ? split(
        ({ query }) => {
          const def = getMainDefinition(query);
          return (
            def.kind === 'OperationDefinition' && def.operation === 'subscription'
          );
        },
        wsLink,
        authLink.concat(httpLink)
      )
    : authLink.concat(httpLink);

  return new ApolloClient({
    link,
    cache: new InMemoryCache(),
    defaultOptions: { watchQuery: { fetchPolicy: 'cache-and-network' } },
  });
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const client = useMemo(makeClient, []);

  // The cache is keyed by row id, not by who fetched it, so without this a
  // signed-out user's rows stay readable to whoever signs in next on the same
  // browser — the org and role would render from stale data even though every
  // server response is correctly scoped. Wipe on any auth transition.
  useEffect(() => {
    const unsubscribe = nhost.auth.onAuthStateChanged((event) => {
      if (event === 'SIGNED_OUT') {
        client.clearStore().catch(() => {});
      } else {
        // refetch everything active against the new session
        client.resetStore().catch(() => {});
      }
    });
    return () => {
      unsubscribe();
    };
  }, [client]);

  return (
    <NhostProvider nhost={nhost}>
      <ApolloProvider client={client}>
        <OrgProvider>{children}</OrgProvider>
      </ApolloProvider>
    </NhostProvider>
  );
}
