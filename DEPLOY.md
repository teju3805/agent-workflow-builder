# Deploying

Backend first — the frontend needs the nhost subdomain, and nhost needs the Vercel URL,
so the order below breaks that loop with one extra push at the end.

## 1. nhost Cloud project

app.nhost.io → **New Project** → free plan, pick a region (`ap-south-1` if you're in
India). Then **Settings → Git** → connect the GitHub repo, branch `main`, base
directory `/`.

nhost reads `nhost/nhost.toml`, applies `nhost/migrations`, applies `nhost/metadata`, and
builds `functions/` on every push to `main`. **Whatever is in the repo overwrites the
cloud settings** — so don't edit config in the dashboard and expect it to survive; edit
`nhost.toml` and push.

Note the **subdomain** and **region** from the project overview. Your URLs are:

```
GraphQL    https://<subdomain>.hasura.<region>.nhost.run/v1/graphql
Auth       https://<subdomain>.auth.<region>.nhost.run/v1
Functions  https://<subdomain>.functions.<region>.nhost.run/v1
```

## 2. Secrets (Settings → Secrets)

Config references these by name; the values never live in git.

| Name | Value |
|---|---|
| `HASURA_GRAPHQL_ADMIN_SECRET` | long random string |
| `HASURA_GRAPHQL_JWT_SECRET` | 64+ random hex chars |
| `NHOST_WEBHOOK_SECRET` | long random string |
| `INTERNAL_WEBHOOK_SECRET` | long random string |
| `NHOST_GRAPHQL_URL` | `https://<subdomain>.hasura.<region>.nhost.run/v1/graphql` |
| `NHOST_FUNCTIONS_URL` | `https://<subdomain>.functions.<region>.nhost.run/v1` |
| `CLIENT_URL` | `http://localhost:3000` for now — replaced in step 5 |
| `LLM_API_KEY` | Groq key, or empty for the disclosed stub |
| `SLACK_WEBHOOK_URL` | empty is fine |

`NHOST_FUNCTIONS_URL` is the one that silently breaks everything: the three Event Trigger
URLs are built from it, and the event trigger on `workflow_runs` is what actually executes
every run. Wrong value → runs sit at `pending` forever with no error anywhere.

Sanity check after the first deploy:

```bash
curl -i https://<subdomain>.functions.<region>.nhost.run/v1/events/run-executor
```

**401** is correct — the function is live and rejecting an unsigned caller. **404** means
the URL is wrong.

## 3. Vercel

vercel.com → **Add New → Project** → import the repo.

- **Root Directory: `web`** ← the setting people miss; without it the build fails
- Framework preset: Next.js (auto-detected)
- Environment variables:

```
NEXT_PUBLIC_NHOST_SUBDOMAIN = <subdomain>
NEXT_PUBLIC_NHOST_REGION    = <region>
```

Deploy. That URL is what you submit.

## 4. Point the backend at the frontend

Update the `CLIENT_URL` secret in the nhost dashboard to the Vercel URL, then redeploy the
backend (Deployments → redeploy, or push any commit). Until this is done, sign-up works
but the session is refused — auth only issues tokens to allowed origins.

## 5. Seed

On the deployed app, sign up all four users: `owner-a@example.com`, `editor-a@`,
`viewer-a@`, `owner-b@`. They'll all land on "No organization yet" — correct, they're not
members of anything yet.

Then dashboard → **Database → SQL Editor**, paste `scripts/seed.sql`, run. It prints the
webhook secret; keep it for the demo. Reload as `owner-a@` and Support triage is there.

## 6. Verify before recording

```bash
node scripts/isolation-check.mjs \
  --backend https://<subdomain>.<region>.nhost.run \
  --email owner-b@example.com --password '<password>' \
  --workflow <org-A-workflow-id> --run <org-A-run-id> --step-run <org-A-step-run-id>
```

On nhost Cloud, auth and GraphQL are on different hostnames than the local single port —
edit the `AUTH` and `GQL` constants at the top of the script to the two URLs from step 1
before running it.

Also check by hand: manual run finishes, webhook curl starts a run, the approval gate
pauses and resumes, and an Org A run URL opened as `owner-b@` says "Not found".

## Free-tier notes

- nhost free projects sleep after inactivity — open the dashboard a few minutes before
  recording so the first request isn't a cold start that looks like a hang.
- The cron trigger fires every minute; that's fine on free tier but it does count runs
  against the org quota if a scheduled trigger is attached. Leave scheduled triggers off
  the demo workflow unless you're showing them.
