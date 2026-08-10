import type { Request, Response } from 'express';
import { adminGql } from '../_lib/gql';
import { assertInternal } from '../_lib/http';

/**
 * Event Trigger: notifications INSERT -> deliver to Slack.
 *
 * The notify step type only writes a row; delivery happens here. If Slack is
 * down, Hasura retries this trigger without holding up (or re-running) the
 * workflow, and the failure is recorded on the notification row.
 */
export default async function handler(req: Request, res: Response) {
  if (!assertInternal(req, res)) return;

  const row = req.body?.event?.data?.new;
  if (!row?.id) return res.status(400).json({ message: 'No row in event payload' });
  if (row.status !== 'queued') return res.json({ skipped: true });

  const webhook = row.target || process.env.SLACK_WEBHOOK_URL || '';

  try {
    if (!webhook) {
      // no channel configured — record it instead of failing the workflow
      await patch(row.id, { status: 'skipped', error: 'No Slack webhook configured' });
      return res.json({ delivered: false, reason: 'no-webhook' });
    }

    const slack = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: row.message }),
    });

    if (!slack.ok) throw new Error(`Slack responded ${slack.status}`);

    await patch(row.id, { status: 'sent', sent_at: new Date().toISOString(), error: null });
    return res.json({ delivered: true });
  } catch (err: any) {
    await patch(row.id, { status: 'failed', error: String(err?.message ?? err) });
    return res.status(500).json({ message: String(err?.message ?? err) });
  }
}

async function patch(id: string, set: Record<string, unknown>) {
  await adminGql(
    `mutation N($id: uuid!, $set: notifications_set_input!) {
       update_notifications_by_pk(pk_columns: {id: $id}, _set: $set) { id }
     }`,
    { id, set }
  );
}
