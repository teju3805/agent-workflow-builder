import { gql } from '@apollo/client';

/* ---------------------------------------------------------------- queries */

/** Everything the workflows screen needs: steps, triggers, latest run status. */
export const ORG_WORKFLOWS = gql`
  query OrgWorkflows($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { updated_at: desc }) {
      id
      name
      description
      is_active
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
      }
      triggers {
        id
        type
        config
        is_active
        next_run_at
      }
      runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
  }
`;

// Filtered to the caller on purpose: org_members is readable by every member
// of the org, so an unfiltered query returns colleagues' rows too and the app
// would read somebody else's role as its own.
export const MY_ORGS = gql`
  query MyOrgs($userId: uuid!) {
    org_members(where: { user_id: { _eq: $userId } }, order_by: { created_at: asc }) {
      id
      role
      org_id
      organization {
        id
        name
      }
    }
  }
`;

/** The aggregation, straight off the Postgres view. */
export const ORG_USAGE = gql`
  query OrgUsage($orgId: uuid!) {
    org_usage_current_month(where: { org_id: { _eq: $orgId } }) {
      org_id
      quota_limit
      quota_used
      quota_remaining
      runs_this_month
      succeeded_this_month
      failed_this_month
      avg_run_seconds
    }
  }
`;

export const WORKFLOW_DETAIL = gql`
  query WorkflowDetail($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      description
      org_id
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
      }
      triggers {
        id
        type
        config
        is_active
      }
      runs(order_by: { created_at: desc }, limit: 10) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
  }
`;

/* -------------------------------------------------------------- mutations */

export const SAVE_WORKFLOW = gql`
  mutation SaveWorkflow(
    $workflowId: uuid!
    $name: String!
    $description: String
    $steps: [workflow_steps_insert_input!]!
    $triggers: [workflow_triggers_insert_input!]!
  ) {
    update_workflows_by_pk(
      pk_columns: { id: $workflowId }
      _set: { name: $name, description: $description }
    ) {
      id
    }
    delete_workflow_steps(where: { workflow_id: { _eq: $workflowId } }) {
      affected_rows
    }
    delete_workflow_triggers(where: { workflow_id: { _eq: $workflowId } }) {
      affected_rows
    }
    insert_workflow_steps(objects: $steps) {
      affected_rows
    }
    insert_workflow_triggers(objects: $triggers) {
      affected_rows
    }
  }
`;

export const CREATE_WORKFLOW = gql`
  mutation CreateWorkflow($orgId: uuid!, $name: String!) {
    insert_workflows_one(object: { org_id: $orgId, name: $name }) {
      id
    }
  }
`;

export const TRIGGER_RUN = gql`
  mutation TriggerRun($workflowId: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflowId, input: $input) {
      run_id
      status
      message
    }
  }
`;

export const APPROVE_STEP = gql`
  mutation ApproveStep($stepRunId: uuid!, $decision: String, $note: String) {
    approveStep(step_run_id: $stepRunId, decision: $decision, note: $note) {
      step_run_id
      run_id
      status
      message
    }
  }
`;

export const INSERT_WATCHED_RECORD = gql`
  mutation InsertWatchedRecord($orgId: uuid!, $source: String!, $payload: jsonb!) {
    insert_watched_records_one(object: { org_id: $orgId, source: $source, payload: $payload }) {
      id
    }
  }
`;

/* ---------------------------------------------------------- subscriptions */

/** Live per-step progress, including the paused/awaiting-approval state. */
export const STEP_RUNS_LIVE = gql`
  subscription StepRuns($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { position: asc }) {
      id
      position
      name
      type
      status
      output
      error
      attempt_count
      approved_by
      approved_at
      started_at
      finished_at
    }
  }
`;

export const RUN_LIVE = gql`
  subscription RunLive($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      error
      trigger_type
      started_at
      finished_at
      workflow {
        id
        name
        org_id
      }
    }
  }
`;

export const RUNS_FOR_WORKFLOW_LIVE = gql`
  subscription RunsForWorkflow($workflowId: uuid!) {
    workflow_runs(
      where: { workflow_id: { _eq: $workflowId } }
      order_by: { created_at: desc }
      limit: 8
    ) {
      id
      status
      trigger_type
      created_at
      finished_at
    }
  }
`;
