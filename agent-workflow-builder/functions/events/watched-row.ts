import type { Request, Response } from 'express';
import { adminGql } from '../_lib/gql';
import { createRun } from '../_lib/runs';
import { assertInternal } from '../_lib/http';

/**
 * Event Trigger: watched_records INSERT -> start every workflow in that org
 * whose database_event trigger watches this source.
 *
 * The org comes from the inserted row, and the trigger lookup is scoped to it,
 * so a row in Org B can never start an Org A workflow even if both orgs use
 * the same source name.
 */
export default async function handler(req: Request, res: Response) {
  if (!assertInternal(req, res)) return;

  const row = req.body?.event?.data?.new;
  if (!row?.id) return res.status(400).json({ message: 'No row in event payload' });

  const data = await adminGql<{ workflow_triggers: any[] }>(
    `query Matching($org: uuid!, $source: String!) {
       workflow_triggers(where: {
         type: {_eq: "database_event"},
         is_active: {_eq: true},
         config: {_contains: {source: $source}},
         workflow: {org_id: {_eq: $org}, is_active: {_eq: true}}
       }) { id workflow_id }
     }`,
    { org: row.org_id, source: row.source }
  );

  const started: string[] = [];
  const rejected: { workflow_id: string; reason: string }[] = [];

  for (const trigger of data.workflow_triggers) {
    const created = await createRun({
      workflowId: trigger.workflow_id,
      triggeredBy: row.created_by ?? null,
      triggerType: 'database_event',
      input: { source: row.source, record_id: row.id, payload: row.payload ?? {} },
    });
    if (created.ok) started.push(created.run_id);
    else rejected.push({ workflow_id: trigger.workflow_id, reason: created.code });
  }

  return res.json({ started, rejected });
}
