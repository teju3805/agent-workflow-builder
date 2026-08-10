import type { Request, Response } from 'express';
import { adminGql } from '../_lib/gql';
import { createRun } from '../_lib/runs';
import { actionError } from '../_lib/http';

/**
 * Action: triggerWebhookRun(secret, payload) — role `public`.
 *
 * There is no session here, so the trigger secret is the only credential, and
 * it resolves the org by itself: an external caller can start exactly the one
 * workflow that secret belongs to and learns nothing else. The secret column is
 * not selectable by any client role, so it cannot be harvested through GraphQL.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const { secret, payload } = req.body?.input ?? {};
    if (!secret) return actionError(res, 400, 'secret is required', 'bad-request');

    const data = await adminGql<{ workflow_triggers: any[] }>(
      `query BySecret($secret: String!) {
         workflow_triggers(where: {webhook_secret: {_eq: $secret},
                                   type: {_eq: "webhook"},
                                   is_active: {_eq: true}}, limit: 1) {
           id workflow_id workflow { id is_active org_id }
         }
       }`,
      { secret }
    );

    const trigger = data.workflow_triggers[0];
    if (!trigger) return actionError(res, 404, 'Unknown webhook', 'not-found');

    const created = await createRun({
      workflowId: trigger.workflow_id,
      triggeredBy: null,
      triggerType: 'webhook',
      input: { source: 'webhook', payload: payload ?? {} },
    });

    if (!created.ok) {
      const status = created.code === 'quota_exhausted' ? 429 : 400;
      return res.status(status).json({ message: created.message, extensions: { code: created.code } });
    }

    return res.json({ run_id: created.run_id, accepted: true, message: 'Run queued' });
  } catch (err: any) {
    console.error('triggerWebhookRun', err);
    return actionError(res, 500, 'Could not accept the webhook', 'internal');
  }
}
