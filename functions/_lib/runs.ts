import { adminGql, getWorkflow, reserveQuota, releaseQuota } from './gql';

export type TriggerKind = 'manual' | 'webhook' | 'scheduled' | 'database_event';

export type CreateRunResult =
  | { ok: true; run_id: string }
  | { ok: false; code: 'not_found' | 'inactive' | 'no_steps' | 'quota_exhausted'; message: string };

/**
 * Creates the run and all of its step_runs in one nested insert.
 *
 * The step_runs rows exist before the first step executes, so a client that
 * subscribes right after the mutation returns sees the full step list in
 * `pending` and then watches each row flip — no gap, no refresh.
 *
 * Quota is reserved *before* the insert and released if the insert fails,
 * so a run can never exist without a credit behind it.
 */
export async function createRun(params: {
  workflowId: string;
  triggeredBy: string | null;
  triggerType: TriggerKind;
  input?: Record<string, unknown>;
}): Promise<CreateRunResult> {
  const wf = await getWorkflow(params.workflowId);
  if (!wf) return { ok: false, code: 'not_found', message: 'Workflow not found' };
  if (!wf.is_active)
    return { ok: false, code: 'inactive', message: 'Workflow is not active' };
  if (!wf.steps?.length)
    return { ok: false, code: 'no_steps', message: 'Workflow has no steps' };

  const granted = await reserveQuota(wf.org_id, 1);
  if (!granted) {
    return {
      ok: false,
      code: 'quota_exhausted',
      message: `Monthly run quota exhausted for ${wf.organization.name} (${wf.organization.quota_used}/${wf.organization.quota_limit})`,
    };
  }

  try {
    const data = await adminGql<{ insert_workflow_runs_one: { id: string } }>(
      `mutation CreateRun($run: workflow_runs_insert_input!) {
         insert_workflow_runs_one(object: $run) { id }
       }`,
      {
        run: {
          workflow_id: wf.id,
          org_id: wf.org_id,
          status: 'pending',
          trigger_type: params.triggerType,
          triggered_by: params.triggeredBy,
          input: params.input ?? {},
          step_runs: {
            data: wf.steps.map((s: any) => ({
              step_id: s.id,
              position: s.position,
              type: s.type,
              name: s.name,
              status: 'pending',
            })),
          },
        },
      }
    );
    return { ok: true, run_id: data.insert_workflow_runs_one.id };
  } catch (err) {
    await releaseQuota(wf.org_id, 1);
    throw err;
  }
}
