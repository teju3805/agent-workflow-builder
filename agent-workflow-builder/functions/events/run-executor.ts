import type { Request, Response } from 'express';
import { executeRun } from '../_lib/engine';
import { assertInternal } from '../_lib/http';

/**
 * Event Trigger: workflow_runs INSERT -> execute the run.
 *
 * Execution is deliberately decoupled from whatever created the run. Manual,
 * webhook, scheduled and database-event paths all just insert a row; Hasura
 * delivers the event and this runs the engine. That keeps the Action response
 * fast (the client gets a run_id and subscribes immediately) and gives every
 * path the same retry semantics for free.
 */
export default async function handler(req: Request, res: Response) {
  if (!assertInternal(req, res)) return;

  const row = req.body?.event?.data?.new;
  if (!row?.id) return res.status(400).json({ message: 'No row in event payload' });
  if (row.status !== 'pending') return res.json({ skipped: true, reason: `status=${row.status}` });

  try {
    const result = await executeRun(row.id);
    return res.json({ run_id: row.id, status: result.status });
  } catch (err: any) {
    console.error('run-executor', err);
    // non-2xx makes Hasura retry per retry_conf
    return res.status(500).json({ message: String(err?.message ?? err) });
  }
}
