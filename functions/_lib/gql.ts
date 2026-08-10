/**
 * Admin-secret GraphQL client.
 *
 * Handlers run with admin rights on purpose: a mid-execution engine has to
 * write rows the caller themself is not allowed to write (run status, step
 * output, quota). That means every handler must re-derive the caller's
 * identity from the Hasura session variables and check it explicitly —
 * nothing here is protected by row permissions.
 */

const GRAPHQL_URL =
  process.env.NHOST_GRAPHQL_URL ||
  process.env.HASURA_GRAPHQL_URL ||
  'http://localhost:1337/v1/graphql';

const ADMIN_SECRET =
  process.env.NHOST_ADMIN_SECRET ||
  process.env.HASURA_GRAPHQL_ADMIN_SECRET ||
  'nhost-admin-secret';

export class GqlError extends Error {
  constructor(message: string, public detail?: unknown) {
    super(message);
  }
}

export async function adminGql<T = any>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json: any = await res.json();
  if (json.errors) {
    throw new GqlError(json.errors[0]?.message ?? 'GraphQL error', json.errors);
  }
  return json.data as T;
}

/* ------------------------------------------------------------------ */
/* Authorization helpers — used by every handler                       */
/* ------------------------------------------------------------------ */

export type OrgRole = 'owner' | 'editor' | 'viewer';

/** Returns the caller's role in an org, or null if they are not a member. */
export async function getOrgRole(
  userId: string | null,
  orgId: string
): Promise<OrgRole | null> {
  if (!userId) return null;
  const data = await adminGql<{ org_members: { role: OrgRole }[] }>(
    `query Role($user: uuid!, $org: uuid!) {
       org_members(where: {user_id: {_eq: $user}, org_id: {_eq: $org}}, limit: 1) {
         role
       }
     }`,
    { user: userId, org: orgId }
  );
  return data.org_members[0]?.role ?? null;
}

/** Loads a workflow together with the org it belongs to. */
export async function getWorkflow(workflowId: string) {
  const data = await adminGql<{ workflows_by_pk: any }>(
    `query Wf($id: uuid!) {
       workflows_by_pk(id: $id) {
         id name org_id is_active
         organization { id name quota_limit quota_used }
         steps(order_by: {position: asc}) { id position type name config }
       }
     }`,
    { id: workflowId }
  );
  return data.workflows_by_pk;
}

/** Atomic reserve. Returns true only if a credit was actually taken. */
export async function reserveQuota(orgId: string, amount = 1): Promise<boolean> {
  const data = await adminGql<{ reserve_org_quota: { granted: boolean }[] }>(
    `mutation Reserve($org: uuid!, $amount: Int!) {
       reserve_org_quota(args: {p_org_id: $org, p_amount: $amount}) { granted }
     }`,
    { org: orgId, amount }
  );
  return Boolean(data.reserve_org_quota[0]?.granted);
}

export async function releaseQuota(orgId: string, amount = 1): Promise<void> {
  await adminGql(
    `mutation Release($org: uuid!, $amount: Int!) {
       release_org_quota(args: {p_org_id: $org, p_amount: $amount}) { id }
     }`,
    { org: orgId, amount }
  );
}
