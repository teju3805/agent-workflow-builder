'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useAuthenticationStatus } from '@nhost/nextjs';
import { CREATE_WORKFLOW, INSERT_WATCHED_RECORD, ORG_WORKFLOWS } from '@/lib/graphql';
import { useOrg } from '@/components/OrgContext';
import QuotaBar from '@/components/QuotaBar';
import TopBar from '@/components/TopBar';
import SignIn from '@/components/SignIn';

export default function Home() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const { current, canEdit, role, memberships, loading } = useOrg();
  const [name, setName] = useState('');
  const [ticket, setTicket] = useState('Checkout is down for all customers');

  const { data, refetch } = useQuery(ORG_WORKFLOWS, {
    variables: { orgId: current?.org_id },
    skip: !current,
    fetchPolicy: 'cache-and-network',
  });

  const [createWorkflow, { loading: creating }] = useMutation(CREATE_WORKFLOW);
  const [insertRecord, { loading: inserting }] = useMutation(INSERT_WATCHED_RECORD);

  if (isLoading) return <div className="shell muted">Loading…</div>;
  if (!isAuthenticated) return <SignIn />;

  return (
    <>
      <TopBar />
      <div className="shell">
        {!loading && memberships.length === 0 && (
          <div className="card notice">
            <h2>No organization yet</h2>
            <p className="sub">
              Ask an owner to add your user id to their organization, then reload.
            </p>
          </div>
        )}

        {current && (
          <>
            <QuotaBar />

            <div className="card">
              <h2>Workflows in {current.organization.name}</h2>
              <p className="sub">
                You are {role} here. {role === 'viewer' && 'Viewers can read runs but not start them.'}
              </p>

              {(data?.workflows ?? []).length === 0 && (
                <p className="empty">Nothing built yet. Create a workflow to get started.</p>
              )}

              {(data?.workflows ?? []).map((wf: any) => {
                const last = wf.runs?.[0];
                return (
                  <div key={wf.id} className="row"
                       style={{ justifyContent: 'space-between', padding: '10px 0',
                                borderTop: '1px solid var(--line)' }}>
                    <div>
                      <Link href={`/workflows/${wf.id}`} style={{ fontWeight: 600 }}>{wf.name}</Link>
                      <div className="stat muted">
                        {wf.steps.length} steps · triggers:{' '}
                        {wf.triggers.map((t: any) => t.type).join(', ') || 'manual only'}
                      </div>
                    </div>
                    <div className="row">
                      {last ? (
                        <Link href={`/runs/${last.id}`} className={`chip s-${last.status}`}>
                          {last.status}
                        </Link>
                      ) : (
                        <span className="chip s-idle">never run</span>
                      )}
                    </div>
                  </div>
                );
              })}

              {canEdit && (
                <div className="row" style={{ marginTop: 16 }}>
                  <input
                    placeholder="New workflow name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ maxWidth: 320 }}
                  />
                  <button
                    className="primary"
                    disabled={!name.trim() || creating}
                    onClick={async () => {
                      await createWorkflow({ variables: { orgId: current.org_id, name } });
                      setName('');
                      refetch();
                    }}
                  >
                    Create workflow
                  </button>
                </div>
              )}
            </div>

            {canEdit && (
              <div className="card">
                <h2>Fire a database event</h2>
                <p className="sub">
                  Writing a row here starts every workflow in this org with a matching
                  database trigger — no button on the workflow itself.
                </p>
                <div className="row">
                  <input value={ticket} onChange={(e) => setTicket(e.target.value)} style={{ maxWidth: 420 }} />
                  <button
                    disabled={inserting}
                    onClick={() =>
                      insertRecord({
                        variables: {
                          orgId: current.org_id,
                          source: 'support_ticket',
                          payload: { subject: ticket, received_at: new Date().toISOString() },
                        },
                      })
                    }
                  >
                    Insert support ticket
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
