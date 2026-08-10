DROP VIEW IF EXISTS org_usage_current_month;
DROP FUNCTION IF EXISTS reserve_org_quota(uuid, integer);
DROP FUNCTION IF EXISTS release_org_quota(uuid, integer);
DROP TABLE IF EXISTS quota_reservations, watched_records, notifications, step_outputs, step_runs,
                     workflow_runs, workflow_triggers, workflow_steps,
                     workflows, org_members, organizations CASCADE;
DROP DOMAIN IF EXISTS step_run_status, run_status, trigger_type, step_type, org_role;
DROP FUNCTION IF EXISTS set_updated_at();
