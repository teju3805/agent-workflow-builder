import type { Request, Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { adminGql } from '../_lib/gql';
import { createRun } from '../_lib/runs';
import { assertInternal } from '../_lib/http';

/**
 * Hasura cron trigger, once a minute.
 *
 * Each scheduled workflow_trigger carries its own cron expression. We claim a
 * trigger by writing its next_run_at forward *before* creating the run, so a
 * duplicate cron delivery cannot start the same workflow twice.
 */
export default async function handler(req: Request, res: Response) {
  if (!assertInternal(req, res)) return;

  const now = new Date();
  const data = await adminGql<{ workflow_triggers: any[] }>(
    `query Due($now: timestamptz!) {
       workflow_triggers(where: {
         type: {_eq: "scheduled"},
         is_active: {_eq: true},
         _or: [{next_run_at: {_lte: $now}}, {next_run_at: {_is_null: true}}],
         workflow: {is_active: {_eq: true}}
       }) { id workflow_id config next_run_at }
     }`,
    { now: now.toISOString() }
  );

  const started: string[] = [];

  for (const trigger of data.workflow_triggers) {
    const expression = trigger.config?.cron ?? '*/5 * * * *';
    let next: string;
    try {
      next = CronExpressionParser.parse(expression, { currentDate: now }).next().toDate().toISOString();
    } catch {
      await adminGql(
        `mutation Bad($id: uuid!) {
           update_workflow_triggers_by_pk(pk_columns: {id: $id},
             _set: {is_active: false}) { id }
         }`,
        { id: trigger.id }
      );
      continue;
    }

    // claim first: only one caller wins this conditional update
    const claim = await adminGql<{ update_workflow_triggers: { affected_rows: number } }>(
      `mutation Claim($id: uuid!, $now: timestamptz!, $next: timestamptz!) {
         update_workflow_triggers(
           where: {id: {_eq: $id},
                   _or: [{next_run_at: {_lte: $now}}, {next_run_at: {_is_null: true}}]},
           _set: {next_run_at: $next}
         ) { affected_rows }
       }`,
      { id: trigger.id, now: now.toISOString(), next }
    );
    if (claim.update_workflow_triggers.affected_rows === 0) continue;

    // first tick only schedules; it does not fire immediately
    if (trigger.next_run_at === null) continue;

    const created = await createRun({
      workflowId: trigger.workflow_id,
      triggeredBy: null,
      triggerType: 'scheduled',
      input: { source: 'schedule', cron: expression, fired_at: now.toISOString() },
    });
    if (created.ok) started.push(created.run_id);
  }

  return res.json({ checked: data.workflow_triggers.length, started });
}
