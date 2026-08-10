import type { Request, Response } from 'express';
import { adminGql, getOrgRole } from '../_lib/gql';
import { actionError, sessionUserId } from '../_lib/http';

/**
 * Query Action: getWebhookUrl(trigger_id) — owner only.
 *
 * webhook_secret is hidden from every client role, so this is the only way to
 * read it, and an editor asking gets the same 404 an outsider gets.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const userId = sessionUserId(req);
    if (!userId) return actionError(res, 401, 'Not signed in', 'unauthenticated');

    const { trigger_id } = req.body?.input ?? {};
    const data = await adminGql<{ workflow_triggers_by_pk: any }>(
      `query T($id: uuid!) {
         workflow_triggers_by_pk(id: $id) {
           id type webhook_secret workflow { org_id }
         }
       }`,
      { id: trigger_id }
    );

    const trigger = data.workflow_triggers_by_pk;
    const role = trigger ? await getOrgRole(userId, trigger.workflow.org_id) : null;
    if (!trigger || !role || role !== 'owner')
      return actionError(res, 404, 'Trigger not found', 'not-found');

    const base = process.env.NHOST_GRAPHQL_URL || 'http://localhost:1337/v1/graphql';
    return res.json({
      url: `${base} :: mutation { triggerWebhookRun(secret: "${trigger.webhook_secret}", payload: {}) { run_id accepted } }`,
    });
  } catch (err: any) {
    console.error('getWebhookUrl', err);
    return actionError(res, 500, 'Could not read the trigger', 'internal');
  }
}
