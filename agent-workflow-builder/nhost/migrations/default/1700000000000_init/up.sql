-- =========================================================================
-- AI Agent Workflow Builder — schema
-- org -> members -> workflows -> steps/triggers ; workflow -> runs -> step_runs
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- controlled vocabularies -------------------------------------
-- Kept as text + CHECK rather than native Postgres enums: Hasura exposes these
-- as plain strings, so permissions, queries and inserts all use one syntax, and
-- adding a step type later is an ALTER CHECK instead of an enum migration dance.
CREATE DOMAIN org_role AS text
  CHECK (VALUE IN ('owner', 'editor', 'viewer'));
CREATE DOMAIN step_type AS text
  CHECK (VALUE IN ('llm_call', 'http_request', 'db_write',
                   'notify', 'conditional_branch', 'approval_gate'));
CREATE DOMAIN trigger_type AS text
  CHECK (VALUE IN ('manual', 'webhook', 'scheduled', 'database_event'));
CREATE DOMAIN run_status AS text
  CHECK (VALUE IN ('pending', 'running', 'paused', 'succeeded', 'failed'));
CREATE DOMAIN step_run_status AS text
  CHECK (VALUE IN ('pending', 'running', 'awaiting_approval',
                   'succeeded', 'failed', 'skipped'));

-- ---------- updated_at helper -------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- organizations ------------------------------------------------
CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  -- usage quota: N runs per calendar month
  quota_limit        integer NOT NULL DEFAULT 50 CHECK (quota_limit >= 0),
  quota_used         integer NOT NULL DEFAULT 0  CHECK (quota_used >= 0),
  quota_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- membership (the single source of truth for authorization) ----
CREATE TABLE org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role       org_role NOT NULL DEFAULT 'viewer',
  -- denormalised for display only; never used for authorization
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id);
CREATE INDEX org_members_org_idx  ON org_members (org_id);

-- ---------- workflows ----------------------------------------------------
CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_idx ON workflows (org_id);
CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- steps --------------------------------------------------------
CREATE TABLE workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  position    integer NOT NULL CHECK (position >= 0),
  type        step_type NOT NULL,
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- deferrable so a reorder can swap positions inside one transaction
ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_position_key UNIQUE (workflow_id, position)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX workflow_steps_workflow_idx ON workflow_steps (workflow_id, position);
CREATE TRIGGER workflow_steps_updated_at BEFORE UPDATE ON workflow_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- triggers -----------------------------------------------------
CREATE TABLE workflow_triggers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  type           trigger_type NOT NULL,
  -- webhook: {}  | scheduled: {"cron": "*/5 * * * *"} | database_event: {"source": "support_ticket"}
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- opaque inbound credential for webhook triggers; never exposed to viewers
  webhook_secret text UNIQUE,
  next_run_at    timestamptz,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_triggers_workflow_idx ON workflow_triggers (workflow_id);
CREATE INDEX workflow_triggers_due_idx ON workflow_triggers (type, is_active, next_run_at);

-- ---------- runs ---------------------------------------------------------
CREATE TABLE workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  -- denormalised org_id: lets every run/step_run permission and the quota
  -- counter resolve without a three-table join on every row check
  org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  status        run_status NOT NULL DEFAULT 'pending',
  trigger_type  trigger_type NOT NULL DEFAULT 'manual',
  triggered_by  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,
  output        jsonb,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX workflow_runs_org_idx ON workflow_runs (org_id, created_at DESC);
CREATE TRIGGER workflow_runs_updated_at BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- step runs (what the live subscription watches) ---------------
CREATE TABLE step_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  step_id         uuid REFERENCES workflow_steps (id) ON DELETE SET NULL,
  position        integer NOT NULL,
  type            step_type NOT NULL,
  name            text NOT NULL,
  status          step_run_status NOT NULL DEFAULT 'pending',
  input           jsonb,
  output          jsonb,
  error           text,
  attempt_count   integer NOT NULL DEFAULT 0,
  approved_by     uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approved_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, position)
);
CREATE INDEX step_runs_run_idx ON step_runs (workflow_run_id, position);
CREATE TRIGGER step_runs_updated_at BEFORE UPDATE ON step_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- db_write target ---------------------------------------------
CREATE TABLE step_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES workflow_runs (id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES step_runs (id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX step_outputs_org_idx ON step_outputs (org_id, created_at DESC);

-- ---------- notify outbox (drives the notify Event Trigger) --------------
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES workflow_runs (id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES step_runs (id) ON DELETE CASCADE,
  channel         text NOT NULL DEFAULT 'slack',
  target          text,
  message         text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org_idx ON notifications (org_id, created_at DESC);
CREATE TRIGGER notifications_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- watched table for the database Event Trigger -----------------
CREATE TABLE watched_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  source     text NOT NULL,                        -- e.g. 'support_ticket'
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watched_records_org_idx ON watched_records (org_id, created_at DESC);

-- =========================================================================
-- Quota: reserve-then-release. The check and the increment happen in a single
-- atomic UPDATE, so two concurrent runs can never both take the last credit.
-- Every decision is recorded, which also gives Hasura a trackable return type
-- (Hasura only tracks functions that return SETOF a tracked table).
-- =========================================================================
CREATE TABLE quota_reservations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  amount     integer NOT NULL DEFAULT 1,
  granted    boolean NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_reservations_org_idx ON quota_reservations (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION reserve_org_quota(p_org_id uuid, p_amount integer DEFAULT 1)
RETURNS SETOF quota_reservations
LANGUAGE plpgsql VOLATILE AS $$
DECLARE reserved boolean; rec quota_reservations;
BEGIN
  -- roll the counter over when a new calendar month has started
  UPDATE organizations
     SET quota_used = 0,
         quota_period_start = date_trunc('month', now())::date
   WHERE id = p_org_id
     AND quota_period_start < date_trunc('month', now())::date;

  UPDATE organizations
     SET quota_used = quota_used + p_amount
   WHERE id = p_org_id
     AND quota_used + p_amount <= quota_limit
  RETURNING true INTO reserved;

  INSERT INTO quota_reservations (org_id, amount, granted, reason)
  VALUES (p_org_id, p_amount, coalesce(reserved, false),
          CASE WHEN coalesce(reserved, false) THEN 'reserved' ELSE 'quota_exhausted' END)
  RETURNING * INTO rec;

  RETURN NEXT rec;
END;
$$;

-- Called when a run could not be created after its credit was reserved.
CREATE OR REPLACE FUNCTION release_org_quota(p_org_id uuid, p_amount integer DEFAULT 1)
RETURNS SETOF quota_reservations
LANGUAGE plpgsql VOLATILE AS $$
DECLARE rec quota_reservations;
BEGIN
  UPDATE organizations
     SET quota_used = greatest(quota_used - p_amount, 0)
   WHERE id = p_org_id;

  INSERT INTO quota_reservations (org_id, amount, granted, reason)
  VALUES (p_org_id, -p_amount, true, 'released')
  RETURNING * INTO rec;

  RETURN NEXT rec;
END;
$$;

-- =========================================================================
-- Aggregation exposed through Hasura: org usage for the current month.
-- =========================================================================
CREATE OR REPLACE VIEW org_usage_current_month AS
SELECT
  o.id                                   AS org_id,
  o.name                                 AS org_name,
  o.quota_limit,
  o.quota_used,
  greatest(o.quota_limit - o.quota_used, 0) AS quota_remaining,
  count(r.id)                            AS runs_this_month,
  count(r.id) FILTER (WHERE r.status = 'succeeded') AS succeeded_this_month,
  count(r.id) FILTER (WHERE r.status = 'failed')    AS failed_this_month,
  count(r.id) FILTER (WHERE r.status = 'paused')    AS paused_now,
  round(avg(extract(epoch FROM (r.finished_at - r.started_at)))
        FILTER (WHERE r.finished_at IS NOT NULL)::numeric, 2) AS avg_run_seconds
FROM organizations o
LEFT JOIN workflow_runs r
       ON r.org_id = o.id
      AND r.created_at >= date_trunc('month', now())
GROUP BY o.id, o.name, o.quota_limit, o.quota_used;
