# Deploying

Backend first — the frontend needs the nhost subdomain, and nhost needs the Vercel URL, so
the order below breaks that loop with one extra push at the end.

## 1. nhost Cloud project

app.nhost.io → **New Project** → free plan, pick a region. Note the **subdomain** and
**region**; your URLs are:

```
GraphQL    https://<subdomain>.hasura.<region>.nhost.run/v1/graphql
Auth       https://<subdomain>.auth.<region>.nhost.run/v1
Functions  https://<subdomain>.functions.<region>.nhost.run/v1
```

Do **not** connect the repo yet — the first deploy resolves `{{ secrets.* }}` and fails if
they are missing.

## 2. Secrets (Settings → Secrets)

nhost pre-creates some of these; leave any that already exist alone.

| Name | Value |
|---|---|
| `HASURA_GRAPHQL_ADMIN_SECRET` | long random string |
| `HASURA_GRAPHQL_JWT_SECRET` | 64 random hex chars |
| `NHOST_WEBHOOK_SECRET` | long random string |
| `GRAFANA_ADMIN_PASSWORD` | long random string |
| `INTERNAL_WEBHOOK_SECRET` | long random string — shared by Hasura and the functions |
| `NHOST_GRAPHQL_URL` | `https://<subdomain>.hasura.<region>.nhost.run/v1/graphql` |
| `WF_EVENT_RUN_EXECUTOR_URL` | `https://<subdomain>.functions.<region>.nhost.run/v1/events/run-executor` |
| `WF_EVENT_NOTIFY_URL` | `https://<subdomain>.functions.<region>.nhost.run/v1/events/notify` |
| `WF_EVENT_WATCHED_ROW_URL` | `https://<subdomain>.functions.<region>.nhost.run/v1/events/watched-row` |
| `CLIENT_URL` | `http://localhost:3000` for now — replaced in step 5 |
| `LLM_API_KEY` | Groq key, or a single space for the stub |
| `SLACK_WEBHOOK_URL` | a single space is fine |

`WF_EVENT_RUN_EXECUTOR_URL` is the one that silently breaks everything: the Event Trigger
on `workflow_runs` is what actually executes every run, so a wrong value here leaves runs
at `pending` with no error in any log. Copy-paste it; don't type it.

## 3. Connect the repo

Settings → **Deployments** → **Connect to GitHub**. Repository, branch `main`, base
directory `./` (the base directory is the *parent* of the `nhost` folder). Turn
**Automatic Deploys** on and save.

If no deployment starts, force one: `git commit --allow-empty -m "Deploy" && git push`.

The deploy runs: project config → migrations → metadata → functions. Config is validated
against nhost's CUE schema and is strict — see "Config gotchas" below.

Verify when it goes green:

```bash
curl -i https://<subdomain>.functions.<region>.nhost.run/v1/events/run-executor
```

**401** is correct — the function is live and rejecting an unsigned caller. **404** means
the functions did not build.

Then check **Database → Table Editor** for the eleven tables, and the Hasura console's
**Settings → Metadata Status** for inconsistencies.

## 4. Vercel

vercel.com → **Add New → Project** → import the repo.

- **Root Directory: `web`** ← without it the build fails; the repo root has no package.json
- Environment variables:

```
NEXT_PUBLIC_NHOST_SUBDOMAIN = <subdomain>
NEXT_PUBLIC_NHOST_REGION    = <region>
```

Deploy, then take the **production** domain (the short one under Domains, not the
per-deployment URL, which changes on every push).

## 5. Point the backend at the frontend

Update the `CLIENT_URL` secret to the Vercel URL (no trailing slash) and redeploy the
backend. Until this is done, sign-up succeeds but no session is issued — auth only accepts
known origins.

## 6. Seed

Sign up the four demo users on the live app **first** — they will all show "No organization
yet", which is correct. Then dashboard → **Database → SQL Editor**, paste `scripts/seed.sql`,
run. It prints the webhook secret; keep it for the demo.

## Config gotchas

All of these fail the **Project Config** step with a CUE validation error naming the field:

- `jwtSecrets` is an array of tables: `[[hasura.jwtSecrets]]`, not `[hasura.jwtSecrets]`.
- Global environment variable names may not start with `NHOST_` or `HASURA_` — reserved for
  nhost's own injected variables. Secret names are unrestricted.
- `postgres.resources.storage.capacity` and `observability.grafana.adminPassword` have no
  defaults and must be set explicitly. Capacity can grow but never shrink.
- Don't pin `functions.node.version` — the allowed set moves, and the default is fine.

Two more that fail later, in **Migrations And Metadata**:

- `nhost/config.yaml` must exist (Hasura CLI config, separate from `nhost.toml`).
- Empty metadata stub files are worse than absent ones: `network.yaml` containing `[]` is
  rejected because Hasura expects a mapping. This repo omits the empty stubs entirely.

## Free-tier notes

- Free projects sleep after inactivity — open the dashboard a few minutes before recording
  so the first request isn't a cold start that looks like a hang.
- The cron trigger runs every minute. Scheduled triggers consume org quota, so leave them
  off the demo workflow unless you're showing them.
