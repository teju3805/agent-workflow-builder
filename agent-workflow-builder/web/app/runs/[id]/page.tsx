'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useSubscription } from '@apollo/client';
import { useAuthenticationStatus } from '@nhost/nextjs';
import { APPROVE_STEP, RUN_LIVE, STEP_RUNS_LIVE } from '@/lib/graphql';
import { useOrg } from '@/components/OrgContext';
import TopBar from '@/components/TopBar';
import SignIn from '@/components/SignIn';

/**
 * Everything on this screen comes from two subscriptions. Nothing polls and
 * nothing refetches after approval — the resumed run pushes its own updates.
 */
export default function RunView({ params }: { params: { id: string } }) {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { canRun, role } = useOrg();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: runData, loading: runLoading } = useSubscription(RUN_LIVE, {
    variables: { runId: params.id },
  });
  const { data: stepData } = useSubscription(STEP_RUNS_LIVE, {
    variables: { runId: params.id },
  });
  const [approve, { loading: approving }] = useMutation(APPROVE_STEP);

  if (isLoading) return <div className="shell muted">Loading…</div>;
  if (!isAuthenticated) return <SignIn />;

  const run = runData?.workflow_runs_by_pk;
  const steps = stepData?.step_runs ?? [];

  // A run in another org resolves to null through the same subscription —
  // the row filter removes it before it reaches the socket.
  if (!runLoading && !run)
    return (
      <>
        <TopBar />
        <div className="shell">
          <div className="card">
            <h1>Not found</h1>
            <p className="sub">
              This run does not exist, or it belongs to an organization you are not a member
              of. Pasting the id directly changes nothing.
            </p>
            <Link href="/">Back to workflows</Link>
          </div>
        </div>
      </>
    );

  const gate = steps.find((s: any) => s.status === 'awaiting_approval');

  const decide = async (decision: 'approve' | 'reject') => {
    setError(null);
    try {
      await approve({ variables: { stepRunId: gate.id, decision, note: note || null } });
      setNote('');
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
            <div>
              <h1>{run?.workflow?.name ?? 'Run'}</h1>
              <p className="sub" style={{ margin: 0 }}>
                <span className="stat">{params.id.slice(0, 8)}</span> · started by{' '}
                {run?.trigger_type} trigger
                {run?.started_at && ` · ${new Date(run.started_at).toLocaleTimeString()}`}
              </p>
            </div>
            <span className={`chip s-${run?.status ?? 'pending'}`}>{run?.status ?? 'pending'}</span>
          </div>
          {run?.error && <p className="err sub" style={{ marginTop: 12 }}>{run.error}</p>}
        </div>

        {gate && (
          <div className="card notice">
            <h2>Waiting on you</h2>
            <p className="sub">
              {gate.name} paused the run. {canRun
                ? 'Approve to continue, or reject to stop it here.'
                : `Viewers cannot approve — ask an owner or editor in this organization.`}
            </p>
            {canRun && (
              <>
                <label htmlFor="note">Note (optional)</label>
                <input id="note" value={note} onChange={(e) => setNote(e.target.value)}
                       placeholder="Why you are approving" style={{ maxWidth: 420 }} />
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="approve" onClick={() => decide('approve')} disabled={approving}>
                    {approving ? 'Sending…' : 'Approve and continue'}
                  </button>
                  <button className="danger" onClick={() => decide('reject')} disabled={approving}>
                    Reject
                  </button>
                </div>
              </>
            )}
            {!canRun && <span className="chip s-idle">{role}</span>}
            {error && <p className="err sub" style={{ marginTop: 10 }}>{error}</p>}
          </div>
        )}

        <div className="card">
          <h2>Steps</h2>
          <ul className="rail">
            {steps.map((s: any) => (
              <li key={s.id} className={s.status}>
                <span className="pip" />
                <div className="step-head">
                  <span className="step-name">{s.name}</span>
                  <span className="step-type">{s.type}</span>
                  <span className={`chip s-${s.status}`}>{s.status.replace('_', ' ')}</span>
                  {s.attempt_count > 1 && (
                    <span className="stat muted">attempt {s.attempt_count}</span>
                  )}
                  {s.approved_at && (
                    <span className="stat muted">
                      approved {new Date(s.approved_at).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {s.error && <div className="io err">{s.error}</div>}
                {s.output != null && s.status !== 'skipped' && (
                  <div className="io">{formatOutput(s.output)}</div>
                )}
              </li>
            ))}
          </ul>
          {steps.length === 0 && <p className="empty">Waiting for the first step…</p>}
        </div>

        <Link href={run?.workflow?.id ? `/workflows/${run.workflow.id}` : '/'}>
          Back to the workflow
        </Link>
      </div>
    </>
  );
}

function formatOutput(output: any) {
  if (typeof output?.text === 'string') return output.text;
  return JSON.stringify(output, null, 2);
}
