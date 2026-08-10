import type { Request, Response } from 'express';
import { adminGql, getOrgRole } from '../_lib/gql';
import { executeRun } from '../_lib/engine';
import { actionError, sessionUserId } from '../_lib/http';

/**
 * Action: approveStep(step_run_id, decision, note)
 *
 * This is the check that cannot be a row permission. Whether someone may clear
 * this gate depends on the state of the run at this instant (is the step still
 * awaiting approval?) and on the approver's role in the org that owns the run —
 * a decision taken mid-execution, not a row read. So the handler resolves the
 * run -> workflow -> org chain itself and re-checks the role before resuming.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const userId = sessionUserId(req);
    if (!userId) return actionError(res, 401, 'Not signed in', 'unauthenticated');

    const { step_run_id, decision, note } = req.body?.input ?? {};
    if (!step_run_id) return actionError(res, 400, 'step_run_id is required', 'bad-request');

    const data = await adminGql<{ step_runs_by_pk: any }>(
      `query Gate($id: uuid!) {
         step_runs_by_pk(id: $id) {
           id status type name
           workflow_run { id org_id status }
         }
       }`,
      { id: step_run_id }
    );

    const stepRun = data.step_runs_by_pk;
    const role = stepRun ? await getOrgRole(userId, stepRun.workflow_run.org_id) : null;

    // unknown id and other-org id are indistinguishable from the outside
    if (!stepRun || !role) return actionError(res, 404, 'Step not found', 'not-found');

    if (role === 'viewer')
      return actionError(res, 403, 'Only an owner or editor can approve this step', 'forbidden');

    if (stepRun.type !== 'approval_gate')
      return actionError(res, 400, 'This step is not an approval gate', 'bad-request');

    if (stepRun.status !== 'awaiting_approval')
      return actionError(res, 409, `Step is ${stepRun.status}, not awaiting approval`, 'conflict');

    const rejected = String(decision ?? 'approve').toLowerCase() === 'reject';

    await adminGql(
      `mutation Decide($id: uuid!, $set: step_runs_set_input!) {
         update_step_runs_by_pk(pk_columns: {id: $id}, _set: $set) { id }
       }`,
      {
        id: stepRun.id,
        set: {
          status: rejected ? 'failed' : 'succeeded',
          approved_by: userId,
          approved_at: new Date().toISOString(),
          output: { decision: rejected ? 'rejected' : 'approved', note: note ?? null, by: userId },
          error: rejected ? `Rejected by approver${note ? `: ${note}` : ''}` : null,
          finished_at: new Date().toISOString(),
        },
      }
    );

    if (rejected) {
      await adminGql(
        `mutation Stop($id: uuid!, $err: String!, $now: timestamptz!) {
           update_workflow_runs_by_pk(pk_columns: {id: $id},
             _set: {status: "failed", error: $err, finished_at: $now}) { id }
           update_step_runs(where: {workflow_run_id: {_eq: $id}, status: {_eq: "pending"}},
             _set: {status: "skipped"}) { affected_rows }
         }`,
        { id: stepRun.workflow_run.id, err: 'Approval rejected', now: new Date().toISOString() }
      );
      return res.json({
        step_run_id: stepRun.id,
        run_id: stepRun.workflow_run.id,
        status: 'rejected',
        message: 'Run stopped at the approval gate',
      });
    }

    // resume from the next unfinished step
    const result = await executeRun(stepRun.workflow_run.id);

    return res.json({
      step_run_id: stepRun.id,
      run_id: stepRun.workflow_run.id,
      status: result.status,
      message: 'Approved — run resumed',
    });
  } catch (err: any) {
    console.error('approveStep', err);
    return actionError(res, 500, 'Could not approve the step', 'internal');
  }
}
