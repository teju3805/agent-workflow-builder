'use client';

import { useMemo } from 'react';
import { ApolloProvider } from '@apollo/client';
import { createApolloClient } from '@nhost/apollo';
import { NhostProvider } from '@nhost/nextjs';
import { nhost } from '@/lib/nhost';
import { OrgProvider } from '@/components/OrgContext';

export default function Providers({ children }: { children: React.ReactNode }) {
  // One client for both transports: HTTP for queries/mutations, WebSocket for
  // subscriptions. It reads the session from nhost, so every operation — the
  // live step feed included — carries the signed-in user's JWT and lands on
  // the same row permissions.
  const client = useMemo(() => createApolloClient({ nhost }), []);

  return (
    <NhostProvider nhost={nhost}>
      <ApolloProvider client={client}>
        <OrgProvider>{children}</OrgProvider>
      </ApolloProvider>
    </NhostProvider>
  );
}
