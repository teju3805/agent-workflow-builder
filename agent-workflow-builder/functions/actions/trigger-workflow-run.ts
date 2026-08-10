import type { Request, Response } from 'express';
import { getOrgRole, getWorkflow } from '../_lib/gql';
import { createRun } from '../_lib/runs';
import { actionError, sessionUserId } from '../_lib/http';

/**
 * Action: triggerWorkflowRun(workflow_id, input)
 *
 * Order matters here:
 *   1. identity comes from session_variables, never from the input
 *   2. membership in the workflow's own org  -> cross-org isolation
 *   3. role must be owner or editor          -> viewers cannot start runs
 *   4. quota reserved atomically             -> no oversubscription
 *   5. run + step_runs created; the run_started Event Trigger executes it
 *
 * Steps 2 and 3 are why guessing a workflow_id from another org gets the same
 * "not found" answer a nonexistent id does — we never confirm existence to a
 * caller who has no membership.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const userId = sessionUserId(req);
    if (!userId) return actionError(res, 401, 'Not signed in', 'unauthenticated');

    const { workflow_id, input } = req.body?.input ?? {};
    if (!workflow_id) return actionError(res, 400, 'workflow_id is required', 'bad-request');

    const wf = await getWorkflow(workflow_id);
    const role = wf ? await getOrgRole(userId, wf.org_id) : null;

    // same response for "does not exist" and "not yours": no existence oracle
    if (!wf || !role) return actionError(res, 404, 'Workflow not found', 'not-found');

    if (role === 'viewer')
      return actionError(res, 403, 'Viewers cannot start runs', 'forbidden');

    const created = await createRun({
      workflowId: workflow_id,
      triggeredBy: userId,
      triggerType: 'manual',
      input: (input ?? {}) as Record<string, unknown>,
    });

    if (!created.ok) {
      const status = created.code === 'quota_exhausted' ? 429 : 400;
      return actionError(res, status, created.message, created.code);
    }

    return res.json({
      run_id: created.run_id,
      status: 'pending',
      message: 'Run queued — watch step_runs for live progress',
    });
  } catch (err: any) {
    console.error('triggerWorkflowRun', err);
    return actionError(res, 500, 'Could not start the run', 'internal');
  }
}
