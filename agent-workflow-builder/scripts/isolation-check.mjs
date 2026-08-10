#!/usr/bin/env node
/**
 * Cross-org isolation probe.
 *
 * Signs in as an Org B user and tries, with real Org A ids, to:
 *   1. read an Org A workflow          -> expect null
 *   2. read an Org A run               -> expect null
 *   3. read an Org A step_run          -> expect null
 *   4. trigger an Org A workflow       -> expect "Workflow not found"
 *   5. approve an Org A gate           -> expect "Step not found"
 *   6. insert a step into an Org A wf  -> expect permission error
 *
 * Usage:
 *   node scripts/isolation-check.mjs \
 *     --backend https://<subdomain>.nhost.run \
 *     --email owner-b@example.com --password ... \
 *     --workflow <org A workflow id> --run <org A run id> --step-run <org A step_run id>
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const backend = (args.backend ?? 'http://localhost:1337').replace(/\/$/, '');
const AUTH = `${backend}/v1/auth/signin/email-password`;
const GQL = `${backend}/v1/graphql`;

const signIn = await fetch(AUTH, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: args.email, password: args.password }),
}).then((r) => r.json());

const token = signIn?.session?.accessToken;
if (!token) {
  console.error('Sign-in failed:', signIn);
  process.exit(1);
}

const gql = async (query, variables = {}) =>
  fetch(GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());

const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

let r = await gql(`query($id: uuid!){ workflows_by_pk(id:$id){ id name } }`, { id: args.workflow });
record('cannot read Org A workflow by id', r.data?.workflows_by_pk === null, JSON.stringify(r.data));

r = await gql(`query($id: uuid!){ workflow_runs_by_pk(id:$id){ id status } }`, { id: args.run });
record('cannot read Org A run by id', r.data?.workflow_runs_by_pk === null);

r = await gql(`query($id: uuid!){ step_runs_by_pk(id:$id){ id status } }`, { id: args['step-run'] });
record('cannot read Org A step_run by id', r.data?.step_runs_by_pk === null);

r = await gql(
  `mutation($id: uuid!){ triggerWorkflowRun(workflow_id:$id, input:{}){ run_id } }`,
  { id: args.workflow }
);
record('cannot trigger Org A workflow', !r.data?.triggerWorkflowRun?.run_id, r.errors?.[0]?.message);

r = await gql(
  `mutation($id: uuid!){ approveStep(step_run_id:$id){ status } }`,
  { id: args['step-run'] }
);
record('cannot approve Org A step', !r.data?.approveStep?.status, r.errors?.[0]?.message);

r = await gql(
  `mutation($id: uuid!){ insert_workflow_steps_one(object:{workflow_id:$id, position:99,
       type: llm_call, name:"injected", config:{}}){ id } }`,
  { id: args.workflow }
);
record('cannot add a step to an Org A workflow', !r.data?.insert_workflow_steps_one?.id,
       r.errors?.[0]?.message);

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} isolation checks passed`);
process.exit(failed ? 1 : 0);
