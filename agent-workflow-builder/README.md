# AI Agent Workflow Builder

A small n8n for chaining AI agent steps, on nhost (Postgres + Hasura + Auth + Functions)
with a Next.js frontend. Workflows belong to an organization, run step by step with live
progress over a GraphQL subscription, and pause on approval gates until someone with the
right role clears them.

```
web/                Next.js 14 app (App Router)
functions/          nhost serverless functions
  _lib/             engine, step executors, admin GraphQL client, auth helpers
  actions/          Hasura Action handlers
  events/           Event Trigger handlers
  cron/             scheduled trigger handler
nhost/
  migrations/       schema, quota functions, usage view
  metadata/         tracked tables, relationships, both permission layers, actions
scripts/            seed data and a cross-org isolation probe
```

## What runs where

| Piece | Where it lives |
|---|---|
| Membership + role scoping (Layer 1) | Hasura row permissions, `nhost/metadata/databases/default/tables/tables.yaml` |
| Step-type gating (Layer 2) | Same file (`_or` blocks on `workflow_steps` / `workflow_triggers`) **and** re-checked in the Action handlers |
| Approval role check | `functions/actions/approve-step.ts` — a mid-execution decision, not a row read |
| Step execution, retry, branching | `functions/_lib/engine.ts` |
| Run start (manual) | Action `triggerWorkflowRun` |
| Run start (webhook) | Action `triggerWebhookRun`, role `public`, secret-authenticated |
| Run start (scheduled) | Hasura cron trigger → `functions/cron/scheduled-runs.ts` |
| Run start (database event) | Event Trigger on `watched_records` → `functions/events/watched-row.ts` |
| Actual execution of any run | Event Trigger on `workflow_runs` insert → `functions/events/run-executor.ts` |
| `notify` delivery | Event Trigger on `notifications` insert → `functions/events/notify.ts` |

## Setup

### 1. Backend

```bash
npm install -g nhost-cli        # or: brew install nhost/tap/nhost
cd nhost
nhost up                        # Postgres + Hasura + Auth + Functions on :1337
```

Migrations and metadata under `nhost/` are applied automatically. Console: <http://localhost:1337>.

Secrets — copy `.env.example` to `.env` in the repo root (nhost reads it for functions):

```
INTERNAL_WEBHOOK_SECRET=any-long-random-string
LLM_API_KEY=gsk_...              # Groq free tier; leave empty to use the disclosed stub
LLM_API_URL=https://api.groq.com/openai/v1/chat/completions
LLM_MODEL=llama-3.1-8b-instant
SLACK_WEBHOOK_URL=               # optional; notify records the miss instead of failing
NHOST_GRAPHQL_URL=http://localhost:1337/v1/graphql
NHOST_ADMIN_SECRET=nhost-admin-secret
```

Event Trigger webhook URLs come from env vars so the same metadata works locally and in
the cloud. Set these in the nhost dashboard (or `.env` locally):

```
NHOST_FUNCTIONS_URL_RUN_EXECUTOR=http://functions:3000/events/run-executor
NHOST_FUNCTIONS_URL_NOTIFY=http://functions:3000/events/notify
NHOST_FUNCTIONS_URL_WATCHED_ROW=http://functions:3000/events/watched-row
```

**If `LLM_API_KEY` is empty**, `llm_call` returns a stubbed completion after a deliberate
~900 ms delay, and the step output carries `"stubbed": true` so nothing in a demo is
mistaken for a real model call.

### 2. Frontend

```bash
cd web
cp .env.local.example .env.local     # local defaults already point at nhost up
npm install
npm run dev                          # http://localhost:3000
```

For a deployed backend set `NEXT_PUBLIC_NHOST_SUBDOMAIN` and `NEXT_PUBLIC_NHOST_REGION`
from the nhost dashboard. Deploying `web/` to Vercel needs those two variables and nothing
else — the app talks to nhost directly from the browser.

### 3. Demo data

Sign up four users through the app — `owner-a@`, `editor-a@`, `viewer-a@`, `owner-b@`
`example.com` — then run `scripts/seed.sql` (Hasura console → SQL, or
`nhost run sql --file scripts/seed.sql`). It creates both organizations, the memberships,
Org A's *Support triage* workflow with all five steps, and its three triggers. The last
statement prints the webhook secret.

## Final Task walkthrough

1. **Two orgs.** Sign in as `owner-a@example.com`; the switcher shows Org A only. Org B's
   owner sees Org B only.
2. **Build.** Open *Support triage*. Five steps: `llm_call` → `conditional_branch` →
   `http_request` → `approval_gate` → `db_write`. The branch reads the LLM's own output:
   a ticket the model calls ROUTINE ends the run there; URGENT continues to the HTTP call.
3. **Two ways to start.** Press **Run now**, or start it without touching the app:

   ```bash
   curl -X POST http://localhost:1337/v1/graphql \
     -H 'content-type: application/json' \
     -d '{"query":"mutation { triggerWebhookRun(secret: \"whk_...\", payload: {subject: \"Checkout is down for all customers\"}) { run_id accepted } }"}'
   ```

   No auth header — the secret is the credential. The third path is the **Insert support
   ticket** button on the home screen, which writes a `watched_records` row and lets the
   Event Trigger start the run.
4. **Pause.** The run stops at *Escalation approval*: run status `paused`, step status
   `awaiting_approval`, and the step rail visibly breaks. Approve as the owner or the
   editor and it resumes; `viewer-a@` sees the gate but gets no buttons, and calling
   `approveStep` directly returns 403.
5. **Live.** Everything above streams over the `step_runs` subscription. No refresh, no
   polling.
6. **Isolation.** Sign in as `owner-b@example.com` and paste an Org A run URL — "Not
   found". Then run the probe with real Org A ids:

   ```bash
   node scripts/isolation-check.mjs --backend http://localhost:1337 \
     --email owner-b@example.com --password '...' \
     --workflow <org-A-workflow-id> --run <org-A-run-id> --step-run <org-A-step-run-id>
   ```

   Six checks, all expected to pass: read workflow, read run, read step_run, trigger,
   approve, insert a step.

## Notes

- **Retries.** `llm_call` and `http_request` get one retry with a 1 s backoff; the attempt
  count is on the `step_runs` row and shown in the UI. A step that still fails marks the run
  `failed` and skips the rest.
- **Quota.** Reserved atomically before the run row is created and released if creation
  fails, so a run can never exist without a credit. Exhausted quota returns 429 from the
  Action.
- **The engine is re-entrant.** It always resumes at the first non-terminal step, so a
  Hasura Event Trigger retry or an approval resume never re-runs finished steps.
- **Known gaps.** Reordering steps rewrites the step list on save rather than diffing it, so
  a run in flight keeps its own `step_runs` copies (deliberate) but step history is not
  versioned. Rejection stops a run rather than routing to an alternative branch.
