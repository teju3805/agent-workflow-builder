# AI Agent Workflow Builder

A small n8n for chaining AI agent steps, on nhost (Postgres + Hasura + Auth + Functions)
with a Next.js frontend. Workflows belong to an organization, run step by step with live
progress over a GraphQL subscription, and pause on approval gates until someone with the
right role clears them.

**Live app:** https://agent-workflow-builder-plum.vercel.app

Demo accounts: `owner-a@example.com`, `editor-a@example.com`, `viewer-a@example.com` in
Org A — Northwind; `owner-b@example.com` in Org B — Contoso.

```
web/                Next.js 14 app (App Router)
functions/          nhost serverless functions
  _lib/             engine, step executors, admin GraphQL client, auth helpers
  actions/          Hasura Action handlers
  events/           Event Trigger handlers
  cron/             scheduled trigger handler
nhost/
  nhost.toml        platform config (config-as-code — see "Configuration")
  config.yaml       Hasura CLI config
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

## Configuration

`nhost/nhost.toml` is config-as-code: it configures the local environment **and** the cloud
project, and whatever is in git overwrites the cloud settings on every deploy. Editing
config in the nhost dashboard does not survive a push; edit this file instead.

Environment-specific values are referenced as `{{ secrets.NAME }}` — stored in `./.secrets`
locally (gitignored) and under **Settings → Secrets** in the dashboard for the cloud. See
`.secrets.example` for the list.

Two constraints worth knowing before editing it:

- nhost reserves the `NHOST_` and `HASURA_` prefixes for variables it injects itself, so
  user-defined variables here use a `WF_` prefix. Secret *names* are not restricted, which
  is why `WF_GRAPHQL_URL` can read the `NHOST_GRAPHQL_URL` secret.
- The three event-trigger URLs are one secret each, holding the complete URL. A wrong value
  there does not fail validation — it just leaves runs sitting at `pending` with no error
  anywhere.

## Setup

### 1. Backend

```bash
sudo curl -L https://raw.githubusercontent.com/nhost/cli/main/get.sh | bash
cp .secrets.example .secrets     # fill in the values
nhost up                         # from the repo root
```

Migrations and metadata under `nhost/` are applied automatically.

**If `LLM_API_KEY` is empty**, `llm_call` returns a stubbed completion after a deliberate
~900 ms delay and the output carries `"stubbed": true`, so nothing in a demo is mistaken
for a real model call. With a key (Groq free tier) it calls `llama-3.1-8b-instant` for real.

### 2. Frontend

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev                      # http://localhost:3000
```

For a deployed backend set `NEXT_PUBLIC_NHOST_SUBDOMAIN` and `NEXT_PUBLIC_NHOST_REGION`
from the nhost dashboard. Deploying `web/` to Vercel needs those two variables and a root
directory of `web` — nothing else; the app talks to nhost directly from the browser.

Cloud deployment, step by step: `DEPLOY.md`.

### 3. Demo data

Sign up the four users through the app **first** — the seed matches them by email, so the
accounts must exist. Then run `scripts/seed.sql` (nhost dashboard → Database → SQL Editor).

It creates both organizations, the memberships, Org A's *Support triage* workflow with all
five steps, and its three triggers. The last statement prints the webhook secret.

## Final Task walkthrough

1. **Two orgs.** Sign in as `owner-a@example.com`; the switcher shows Org A only. Org B's
   owner sees Org B only.
2. **Build.** Open *Support triage*: `llm_call` → `conditional_branch` → `http_request` →
   `approval_gate` → `db_write`. The branch reads the LLM's own output — a ticket the model
   calls ROUTINE ends the run there; URGENT continues to the HTTP call.
3. **Two ways to start.** Press **Run now**, or start it with no session at all:

   ```bash
   curl -X POST https://<subdomain>.hasura.<region>.nhost.run/v1/graphql \
     -H 'content-type: application/json' \
     -d '{"query":"mutation { triggerWebhookRun(secret: \"whk_...\", payload: {subject: \"Checkout is down for all customers\"}) { run_id accepted } }"}'
   ```

   No auth header — the secret is the credential, and it resolves the org by itself. A third
   path: the **Insert support ticket** button writes a `watched_records` row and an Event
   Trigger starts the run with nobody clicking Run.
4. **Pause.** The run stops at *Escalation approval*: run `paused`, step `awaiting_approval`,
   and the step rail visibly breaks. Approving as owner or editor resumes from the next step
   — the LLM is not called again. `viewer-a@` sees the gate but gets no buttons, and calling
   `approveStep` directly returns 403.
5. **Live.** All of it streams over the `step_runs` subscription. No refresh, no polling.
6. **Isolation.** Sign in as `owner-b@example.com` and paste an Org A run URL — "Not found".
   Then run the probe with real Org A ids:

   ```bash
   node scripts/isolation-check.mjs \
     --email owner-b@example.com --password '...' \
     --workflow <org-A-workflow-id> --run <org-A-run-id> --step-run <org-A-step-run-id>
   ```

   Six checks: read workflow, read run, read step_run, trigger, approve, insert a step. On
   nhost Cloud, auth and GraphQL sit on different hostnames — set the `AUTH` and `GQL`
   constants at the top of the script to your project's URLs first.

## Notes

- **Retries.** `llm_call` and `http_request` get one retry with a 1 s backoff; the attempt
  count is on the `step_runs` row and shown in the UI. A step that still fails marks the run
  `failed` and skips the rest.
- **Quota.** Reserved atomically before the run row is created, released if creation fails,
  so a run can never exist without a credit. Exhausted quota returns 429 from the Action.
  `inferFunctionPermissions` is off, so the quota functions stay admin-only and cannot be
  inferred into a client-callable mutation off `quota_reservations`' select permission.
- **The engine is re-entrant.** It always resumes at the first non-terminal step, so an
  Event Trigger retry or an approval resume never re-runs finished steps.
- **Client-side caveats, and why they are not security.** `org_members` is readable by every
  member of an org, so the client filters the membership query to the signed-in user — an
  unfiltered read returns colleagues' rows and the UI would render someone else's role. The
  Apollo cache is also cleared on every auth transition. Neither is load-bearing: the Action
  handlers re-derive membership and role server-side regardless of what the UI shows, which
  is the argument for enforcing in the handler rather than trusting the client.
- **Known gaps.** Saving a workflow rewrites its step list rather than diffing it, so step
  definitions are not versioned (runs keep their own `step_runs` copies, deliberately).
  Rejection stops a run rather than routing to an alternative branch. `notify` records
  `skipped` when no Slack webhook is configured rather than failing the run.
