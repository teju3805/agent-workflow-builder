# Write-up

## Schema reasoning

The chain the whole system rests on is `organizations → org_members → workflows →
steps/triggers` and `workflows → workflow_runs → step_runs`. Every authorization rule in
the app is a walk up that chain to an `org_members` row, so the relationships are not
just modelling — they are the security surface.

Two deliberate choices:

**`workflow_runs` carries its own `org_id`.** It is derivable through `workflow_id`, but
denormalising it means a run's permission filter, the quota counter, and the usage view
resolve on one column instead of a join per row check. Runs are the highest-volume table
and the one clients subscribe to, so that join would be paid continuously.

**`step_runs` copies `type`, `name` and `position` off `workflow_steps`.** A run is a
record of what actually happened. If someone edits a workflow while a run is in flight —
or after it finished — the run's own history must not change under it, and the live
subscription must not have to join to a moving table.

Beyond that: config is `jsonb` because each step type wants a different shape and a
column-per-type schema would need a migration for every new node; `attempt_count`,
`error`, `approved_by` and `approved_at` live on `step_runs` so retries and approvals are
auditable per step rather than inferred from logs; `quota_reservations` records every
quota decision, which also gives Hasura a trackable return type for the reserve/release
functions (Hasura only tracks functions returning `SETOF` a tracked table).

The aggregation is the `org_usage_current_month` view — quota, run counts by outcome, and
average run duration for the month — tracked with a select permission scoped the same way
as everything else.

## The two permission layers, and why they are enforced differently

**One Hasura role.** All application traffic uses the Hasura role `user`. Owner / editor /
viewer are *not* Hasura roles, because they are per-organization: the same person can be an
owner in Org A and a viewer in Org B. A role in the JWT would be ambiguous the moment
someone belongs to two orgs, and worse, it would be a claim the client's own token asserts.
So the role is resolved per-row by joining to `org_members` with `X-Hasura-User-Id`.

**Layer 1 — org + role scoping (declarative, in Hasura).** Every permission filter ends at
`members: { user_id: { _eq: X-Hasura-User-Id } }`, reached through the row's own
relationships (`workflow → organization → members`, `step_run → workflow_run →
organization → members`). Reads require membership; writes additionally require
`role _in [owner, editor]`; membership management and deletes require `owner`. Because the
filter is part of the query Hasura compiles, an id from another org does not return a
forbidden error — it returns nothing, which is why guessing ids gives an attacker no signal.
`workflow_runs` and `step_runs` have **no** insert or update permission for any client role:
runs are created and advanced only by Action handlers, so a viewer cannot start a run by
writing the row directly and nobody can hand-edit a run's status mid-flight.

**Layer 2 — step-level gating (still declarative, but type-dependent).** Some step types
reach outside the sandbox, so the *required role depends on the row's type*. On
`workflow_steps` the check is an `_or`: `db_write` and `notify` require `owner`, everything
else accepts `owner` or `editor`. The same shape on `workflow_triggers` restricts `webhook`
triggers to owners, since a webhook trigger opens an unauthenticated inbound door.
`webhook_secret` is not selectable by any client role at all — owners read it through the
`getWebhookUrl` Action, so the credential cannot be harvested through a GraphQL query the
way a normal column can.

**Why the approval check cannot be a permission.** Clearing an approval gate is not a row
read or a row write — it is a decision about a run that is in a particular state right now.
It depends on the step still being `awaiting_approval` (not already approved, not failed),
on the step actually being an `approval_gate`, and on the approver's role in the org that
owns *that run*, and it has to resume execution as its effect. Hasura permissions can
express "who may update this row"; they cannot express "and then continue the workflow from
step 4". So `approveStep` runs with the admin secret and re-derives everything itself: user
id from `session_variables` (never from the input), run → org, `org_members` lookup, status
check, then the update and the resume. The same pattern guards `triggerWorkflowRun`:
membership, then role, then quota, then create. In both handlers an unknown id and an
other-org id return the identical "not found" — the handler never confirms existence to a
caller with no membership.

## Approval-gate pause and resume

Runs are executed by a single re-entrant engine (`functions/_lib/engine.ts`) that always
picks up at the first `step_run` not in a terminal state.

When it reaches an `approval_gate` it does not block a connection or hold a timer. It writes
the step to `awaiting_approval`, writes the run to `paused`, and returns. The process ends;
nothing is left running. The subscription pushes both changes and the UI shows the gate
breaking the step rail, with approve/reject buttons rendered only for owners and editors.

`approveStep` performs its checks, stamps `approved_by` / `approved_at` / the decision on the
step, and calls the same `executeRun` again. Because the engine skips terminal steps and
rebuilds its template context from the outputs of steps that already succeeded, the resumed
run continues at the next pending step with `{{steps.Classify.text}}` and friends still
resolving — no re-execution of the LLM call, no duplicate side effects. A rejection marks the
step failed, skips the remaining steps and fails the run.

Execution being decoupled from triggering is what makes this work uniformly: manual, webhook,
scheduled and database-event paths all just insert a `workflow_runs` row, and a Hasura Event
Trigger on that insert invokes the engine. Every path gets the same retry semantics, the
Action returns a `run_id` immediately so the client can subscribe before the first step
finishes, and a duplicate event delivery is harmless because the engine is re-entrant.
