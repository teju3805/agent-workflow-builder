-- =========================================================================
-- Seed for the Final Task walkthrough.
--
-- Sign these four users up through the app first (any password), then run:
--   nhost run sql --file scripts/seed.sql        (local)
--   or paste into the Hasura console SQL tab      (cloud)
--
--   owner-a@example.com   -> Org A, owner
--   editor-a@example.com  -> Org A, editor
--   viewer-a@example.com  -> Org A, viewer
--   owner-b@example.com   -> Org B, owner
-- =========================================================================

DO $$
DECLARE
  org_a uuid;
  org_b uuid;
  u_owner_a uuid;
  u_editor_a uuid;
  u_viewer_a uuid;
  u_owner_b uuid;
  wf uuid;
BEGIN
  SELECT id INTO u_owner_a  FROM auth.users WHERE email = 'owner-a@example.com';
  SELECT id INTO u_editor_a FROM auth.users WHERE email = 'editor-a@example.com';
  SELECT id INTO u_viewer_a FROM auth.users WHERE email = 'viewer-a@example.com';
  SELECT id INTO u_owner_b  FROM auth.users WHERE email = 'owner-b@example.com';

  IF u_owner_a IS NULL OR u_owner_b IS NULL THEN
    RAISE EXCEPTION 'Sign the demo users up through the app before seeding';
  END IF;

  INSERT INTO organizations (name, quota_limit) VALUES ('Org A — Northwind', 50)
    RETURNING id INTO org_a;
  INSERT INTO organizations (name, quota_limit) VALUES ('Org B — Contoso', 50)
    RETURNING id INTO org_b;

  INSERT INTO org_members (org_id, user_id, role, email) VALUES
    (org_a, u_owner_a,  'owner',  'owner-a@example.com'),
    (org_a, u_editor_a, 'editor', 'editor-a@example.com'),
    (org_a, u_viewer_a, 'viewer', 'viewer-a@example.com'),
    (org_b, u_owner_b,  'owner',  'owner-b@example.com');

  -- ---- Org A's demo workflow -------------------------------------------
  INSERT INTO workflows (org_id, name, description, created_by)
  VALUES (org_a, 'Support triage',
          'Classify an incoming ticket, enrich it, gate the escalation, then record it.',
          u_owner_a)
  RETURNING id INTO wf;

  INSERT INTO workflow_steps (workflow_id, position, type, name, config) VALUES
    (wf, 0, 'llm_call', 'Classify', jsonb_build_object(
       'system', 'Classify the support ticket. Reply with URGENT or ROUTINE, then one sentence of reasoning.',
       'prompt', 'Ticket: {{input.payload.subject}}',
       'temperature', 0.1)),

    (wf, 1, 'conditional_branch', 'Branch', jsonb_build_object(
       'left', '{{steps.Classify.text}}',
       'operator', 'contains',
       'right', 'URGENT',
       'on_false', 'end_run')),          -- routine tickets stop here

    (wf, 2, 'http_request', 'Fetch status page', jsonb_build_object(
       'method', 'GET',
       'url', 'https://api.github.com/repos/hasura/graphql-engine',
       'timeout_ms', 15000)),

    (wf, 3, 'approval_gate', 'Escalation approval', jsonb_build_object(
       'instructions', 'An owner or editor must approve before this is escalated.')),

    (wf, 4, 'db_write', 'Record escalation', jsonb_build_object(
       'key', 'escalation',
       'value', jsonb_build_object(
          'classification', '{{steps.Classify.text}}',
          'repo_stars', '{{steps.Fetch status page.body.stargazers_count}}')));

  INSERT INTO workflow_triggers (workflow_id, type, config, webhook_secret) VALUES
    (wf, 'manual', '{}'::jsonb, NULL),
    (wf, 'webhook', '{}'::jsonb, 'whk_' || encode(gen_random_bytes(24), 'hex')),
    (wf, 'database_event', jsonb_build_object('source', 'support_ticket'), NULL);

  -- ---- Org B gets its own workflow, so isolation is visible both ways ---
  INSERT INTO workflows (org_id, name, description, created_by)
  VALUES (org_b, 'Contoso digest', 'Org B has its own, unrelated workflow.', u_owner_b);

  RAISE NOTICE 'Org A: %  Org B: %  Workflow: %', org_a, org_b, wf;
END $$;

-- The webhook secret is not readable through GraphQL by design. Read it once
-- here to use in the demo, or call the getWebhookUrl Action as an Org A owner.
SELECT w.name, t.type, t.webhook_secret
FROM workflow_triggers t
JOIN workflows w ON w.id = t.workflow_id
WHERE t.type = 'webhook';
