'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useSubscription } from '@apollo/client';
import { useAuthenticationStatus } from '@nhost/nextjs';
import {
  RUNS_FOR_WORKFLOW_LIVE,
  SAVE_WORKFLOW,
  TRIGGER_RUN,
  WORKFLOW_DETAIL,
} from '@/lib/graphql';
import { useOrg } from '@/components/OrgContext';
import TopBar from '@/components/TopBar';
import SignIn from '@/components/SignIn';

type StepType =
  | 'llm_call' | 'http_request' | 'db_write'
  | 'notify' | 'conditional_branch' | 'approval_gate';

type Step = { id?: string; position: number; type: StepType; name: string; config: any };
type Trigger = { id?: string; type: 'manual' | 'webhook' | 'scheduled' | 'database_event'; config: any };

/** Sensible starting config per type, so a new step is runnable immediately. */
const DEFAULTS: Record<StepType, any> = {
  llm_call: {
    system: 'Classify the message. Answer with URGENT or ROUTINE and one sentence why.',
    prompt: 'Message: {{input.payload.subject}}',
    temperature: 0.2,
  },
  http_request: { method: 'GET', url: 'https://api.github.com/repos/hasura/graphql-engine' },
  db_write: { key: 'classification', value: { text: '{{steps.Classify.text}}' } },
  notify: { channel: 'slack', message: 'Workflow finished: {{prev.text}}' },
  conditional_branch: {
    left: '{{steps.Classify.text}}', operator: 'contains', right: 'URGENT', on_false: 'end_run',
  },
  approval_gate: { instructions: 'An owner or editor must approve before this goes out.' },
};

/** Only owners may add these — mirrors the Hasura permission exactly. */
const OWNER_ONLY: StepType[] = ['db_write', 'notify'];

export default function WorkflowBuilder({ params }: { params: { id: string } }) {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { canEdit, canRun, isOwner, role } = useOrg();
  const router = useRouter();

  const { data, refetch } = useQuery(WORKFLOW_DETAIL, { variables: { id: params.id } });
  const { data: liveRuns } = useSubscription(RUNS_FOR_WORKFLOW_LIVE, {
    variables: { workflowId: params.id },
  });

  const [steps, setSteps] = useState<Step[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [save, { loading: saving }] = useMutation(SAVE_WORKFLOW);
  const [trigger, { loading: starting }] = useMutation(TRIGGER_RUN);

  const wf = data?.workflows_by_pk;

  useEffect(() => {
    if (!wf) return;
    setName(wf.name);
    setSteps(wf.steps.map((s: any) => ({ ...s })));
    setTriggers(wf.triggers.map((t: any) => ({ ...t })));
  }, [wf]);

  if (isLoading) return <div className="shell muted">Loading…</div>;
  if (!isAuthenticated) return <SignIn />;

  // A workflow in another org simply does not resolve — the row filter hides it.
  if (data && !wf)
    return (
      <>
        <TopBar />
        <div className="shell">
          <div className="card">
            <h1>Not found</h1>
            <p className="sub">
              This workflow does not exist, or it belongs to an organization you are not a
              member of. Both look the same from here — on purpose.
            </p>
            <Link href="/">Back to workflows</Link>
          </div>
        </div>
      </>
    );

  const move = (i: number, delta: number) => {
    const next = [...steps];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next.map((s, idx) => ({ ...s, position: idx })));
  };

  const addStep = (type: StepType) =>
    setSteps([
      ...steps,
      { position: steps.length, type, name: suggestName(type, steps), config: DEFAULTS[type] },
    ]);

  const onSave = async () => {
    setError(null);
    try {
      await save({
        variables: {
          workflowId: params.id,
          name,
          description: wf.description ?? null,
          steps: steps.map((s, i) => ({
            workflow_id: params.id, position: i, type: s.type, name: s.name, config: s.config,
          })),
          triggers: triggers.map((t) => ({
            workflow_id: params.id, type: t.type, config: t.config ?? {},
          })),
        },
      });
      refetch();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const onRun = async () => {
    setError(null);
    try {
      const res = await trigger({ variables: { workflowId: params.id, input: {} } });
      const runId = res.data?.triggerWorkflowRun?.run_id;
      if (runId) router.push(`/runs/${runId}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <>
      <TopBar />
      <div className="shell">
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="wfname">Workflow</label>
              <input id="wfname" value={name} disabled={!canEdit}
                     onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="row" style={{ alignSelf: 'flex-end' }}>
              {canEdit && (
                <button onClick={onSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              )}
              {/* hidden entirely for viewers; the Action refuses them anyway */}
              {canRun && (
                <button className="primary" onClick={onRun} disabled={starting}>
                  {starting ? 'Starting…' : 'Run now'}
                </button>
              )}
            </div>
          </div>
          {!canEdit && <p className="sub" style={{ marginTop: 10 }}>You are a {role} here — read only.</p>}
          {error && <p className="err sub" style={{ marginTop: 10 }}>{error}</p>}
        </div>

        <div className="card">
          <h2>Steps</h2>
          <p className="sub">They run top to bottom. A gate stops the run until someone approves it.</p>

          {steps.length === 0 && <p className="empty">No steps yet.</p>}

          {steps.map((step, i) => (
            <div key={i} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="row">
                  <span className="step-type">{String(i + 1).padStart(2, '0')}</span>
                  <input
                    value={step.name}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setSteps(steps.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)))
                    }
                    style={{ width: 220 }}
                  />
                  <span className="chip s-idle">{step.type}</span>
                </div>
                {canEdit && (
                  <div className="row">
                    <button onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button className="danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                )}
              </div>

              <label style={{ marginTop: 8 }}>Config</label>
              <textarea
                value={JSON.stringify(step.config, null, 2)}
                disabled={!canEdit}
                onChange={(e) => {
                  try {
                    const config = JSON.parse(e.target.value);
                    setSteps(steps.map((s, j) => (j === i ? { ...s, config } : s)));
                  } catch {
                    /* keep the last valid object while they type */
                  }
                }}
              />
            </div>
          ))}

          {canEdit && (
            <div className="row" style={{ marginTop: 14 }}>
              {(Object.keys(DEFAULTS) as StepType[]).map((type) => {
                const blocked = OWNER_ONLY.includes(type) && !isOwner;
                return (
                  <button
                    key={type}
                    onClick={() => addStep(type)}
                    disabled={blocked}
                    title={blocked ? 'Only an owner can add this step type' : undefined}
                  >
                    + {type}
                  </button>
                );
              })}
            </div>
          )}
          {!isOwner && canEdit && (
            <p className="sub" style={{ marginTop: 10 }}>
              db_write and notify are owner-only. The button is disabled here and the database
              refuses the insert too, so nothing depends on this UI being honest.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Triggers</h2>
          <div className="row">
            {(['manual', 'webhook', 'scheduled', 'database_event'] as const).map((type) => {
              const on = triggers.some((t) => t.type === type);
              const blocked = type === 'webhook' && !isOwner;
              return (
                <button
                  key={type}
                  disabled={!canEdit || blocked}
                  className={on ? 'primary' : ''}
                  title={blocked ? 'Only an owner can attach a webhook trigger' : undefined}
                  onClick={() =>
                    setTriggers(
                      on
                        ? triggers.filter((t) => t.type !== type)
                        : [...triggers, { type, config: defaultTriggerConfig(type) }]
                    )
                  }
                >
                  {on ? '✓ ' : '+ '}{type}
                </button>
              );
            })}
          </div>
          <p className="sub" style={{ marginTop: 10 }}>
            Scheduled runs every 5 minutes by default. A database trigger listens for
            support_ticket rows in this org.
          </p>
        </div>

        <div className="card">
          <h2>Recent runs</h2>
          {(liveRuns?.workflow_runs ?? wf?.runs ?? []).length === 0 && (
            <p className="empty">No runs yet.</p>
          )}
          {(liveRuns?.workflow_runs ?? wf?.runs ?? []).map((run: any) => (
            <div key={run.id} className="row"
                 style={{ justifyContent: 'space-between', padding: '8px 0',
                          borderTop: '1px solid var(--line)' }}>
              <Link href={`/runs/${run.id}`} className="stat">{run.id.slice(0, 8)}</Link>
              <span className="stat muted">{run.trigger_type}</span>
              <span className="stat muted">{new Date(run.created_at).toLocaleTimeString()}</span>
              <span className={`chip s-${run.status}`}>{run.status}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function suggestName(type: StepType, steps: Step[]) {
  const base = {
    llm_call: 'Classify',
    http_request: 'Fetch',
    db_write: 'Save',
    notify: 'Notify',
    conditional_branch: 'Branch',
    approval_gate: 'Approve',
  }[type];
  const taken = steps.filter((s) => s.name.startsWith(base)).length;
  return taken ? `${base}${taken + 1}` : base;
}

function defaultTriggerConfig(type: string) {
  if (type === 'scheduled') return { cron: '*/5 * * * *' };
  if (type === 'database_event') return { source: 'support_ticket' };
  return {};
}
