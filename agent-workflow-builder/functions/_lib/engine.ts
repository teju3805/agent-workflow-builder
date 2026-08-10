import { adminGql } from './gql';
import {
  RunContext,
  evaluateCondition,
  runDbWrite,
  runHttpRequest,
  runLlmCall,
  runNotify,
} from './steps';

const MAX_ATTEMPTS = 2; // one retry on top of the first attempt

type StepRunRow = {
  id: string;
  position: number;
  type: string;
  name: string;
  status: string;
  output: any;
  attempt_count: number;
  step: { config: any } | null;
};

type RunRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  status: string;
  input: any;
  started_at: string | null;
  step_runs: StepRunRow[];
};

const RUN_QUERY = `
  query Run($id: uuid!) {
    workflow_runs_by_pk(id: $id) {
      id org_id workflow_id status input started_at
      step_runs(order_by: {position: asc}) {
        id position type name status output attempt_count
        step { config }
      }
    }
  }`;

async function patchStepRun(id: string, set: Record<string, unknown>) {
  await adminGql(
    `mutation PatchStep($id: uuid!, $set: step_runs_set_input!) {
       update_step_runs_by_pk(pk_columns: {id: $id}, _set: $set) { id }
     }`,
    { id, set }
  );
}

async function patchRun(id: string, set: Record<string, unknown>) {
  await adminGql(
    `mutation PatchRun($id: uuid!, $set: workflow_runs_set_input!) {
       update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: $set) { id }
     }`,
    { id, set }
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs (or resumes) a workflow run.
 *
 * Safe to call more than once: it always picks up at the first step_run that
 * is not in a terminal state, so a Hasura Event Trigger retry or a resume
 * after approval re-enters cleanly instead of re-running finished steps.
 *
 * Returns as soon as it hits an approval_gate — the run is left `paused`
 * and only approveStep can move it on.
 */
export async function executeRun(runId: string): Promise<{ status: string }> {
  const data = await adminGql<{ workflow_runs_by_pk: RunRow }>(RUN_QUERY, { id: runId });
  const run = data.workflow_runs_by_pk;
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status === 'succeeded' || run.status === 'failed') return { status: run.status };

  await patchRun(run.id, {
    status: 'running',
    ...(run.started_at ? {} : { started_at: new Date().toISOString() }),
  });

  // rebuild the context from steps that already finished (matters on resume)
  const ctx: RunContext = {
    runId: run.id,
    orgId: run.org_id,
    workflowId: run.workflow_id,
    input: run.input ?? {},
    steps: {},
    prev: null,
  };
  for (const sr of run.step_runs) {
    if (sr.status === 'succeeded') {
      ctx.steps[sr.name] = sr.output;
      ctx.steps[`#${sr.position}`] = sr.output;
      ctx.prev = sr.output;
    }
  }

  const pending = run.step_runs.filter(
    (s) => s.status === 'pending' || s.status === 'running' || s.status === 'awaiting_approval'
  );

  let skipUntil: number | null = null;

  for (const sr of pending) {
    // a branch told us to jump over this step
    if (skipUntil !== null && sr.position < skipUntil) {
      await patchStepRun(sr.id, {
        status: 'skipped',
        finished_at: new Date().toISOString(),
        output: { skipped_by_branch: true },
      });
      continue;
    }
    skipUntil = null;

    const config = sr.step?.config ?? {};

    /* ---------------- approval_gate: stop the world ---------------- */
    if (sr.type === 'approval_gate') {
      if (sr.status !== 'awaiting_approval') {
        await patchStepRun(sr.id, {
          status: 'awaiting_approval',
          started_at: new Date().toISOString(),
          input: { awaiting: config.instructions ?? 'Approval required to continue' },
        });
      }
      await patchRun(run.id, { status: 'paused' });
      return { status: 'paused' };
    }

    /* ---------------- conditional_branch: no retry needed ---------- */
    if (sr.type === 'conditional_branch') {
      await patchStepRun(sr.id, { status: 'running', started_at: new Date().toISOString(), attempt_count: 1 });
      const decision = evaluateCondition(config, ctx);
      await patchStepRun(sr.id, {
        status: 'succeeded',
        output: decision,
        finished_at: new Date().toISOString(),
      });
      ctx.steps[sr.name] = decision;
      ctx.steps[`#${sr.position}`] = decision;
      ctx.prev = decision;

      if (!decision.matched) {
        // on_false: 'end_run' | 'skip_next' | {goto_position: n}
        const onFalse = config.on_false ?? 'skip_next';
        if (onFalse === 'end_run') {
          for (const rest of pending.filter((p) => p.position > sr.position)) {
            await patchStepRun(rest.id, {
              status: 'skipped',
              finished_at: new Date().toISOString(),
              output: { skipped_by_branch: true },
            });
          }
          break;
        }
        skipUntil =
          typeof onFalse === 'object' && onFalse?.goto_position != null
            ? Number(onFalse.goto_position)
            : sr.position + 2; // skip exactly the next step
      }
      continue;
    }

    /* ---------------- everything else: run with one retry ---------- */
    let attempt = sr.attempt_count ?? 0;
    let lastError: unknown = null;
    let succeeded = false;

    while (attempt < MAX_ATTEMPTS && !succeeded) {
      attempt += 1;
      await patchStepRun(sr.id, {
        status: 'running',
        attempt_count: attempt,
        started_at: new Date().toISOString(),
        input: config,
      });

      try {
        let output: unknown;
        switch (sr.type) {
          case 'llm_call':     output = await runLlmCall(config, ctx); break;
          case 'http_request': output = await runHttpRequest(config, ctx); break;
          case 'db_write':     output = await runDbWrite(config, ctx, sr.id); break;
          case 'notify':       output = await runNotify(config, ctx, sr.id); break;
          default:
            throw new Error(`Unknown step type: ${sr.type}`);
        }

        await patchStepRun(sr.id, {
          status: 'succeeded',
          output: output as any,
          error: null,
          finished_at: new Date().toISOString(),
        });
        ctx.steps[sr.name] = output;
        ctx.steps[`#${sr.position}`] = output;
        ctx.prev = output;
        succeeded = true;
      } catch (err: any) {
        lastError = err;
        await patchStepRun(sr.id, { error: String(err?.message ?? err) });
        if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt); // linear backoff
      }
    }

    if (!succeeded) {
      const message = String((lastError as any)?.message ?? lastError);
      await patchStepRun(sr.id, {
        status: 'failed',
        error: message,
        finished_at: new Date().toISOString(),
      });
      for (const rest of pending.filter((p) => p.position > sr.position)) {
        await patchStepRun(rest.id, { status: 'skipped', output: { skipped_after_failure: true } });
      }
      await patchRun(run.id, {
        status: 'failed',
        error: `Step "${sr.name}" failed after ${MAX_ATTEMPTS} attempts: ${message}`,
        finished_at: new Date().toISOString(),
      });
      return { status: 'failed' };
    }
  }

  await patchRun(run.id, {
    status: 'succeeded',
    output: (ctx.prev ?? {}) as any,
    finished_at: new Date().toISOString(),
  });
  return { status: 'succeeded' };
}
