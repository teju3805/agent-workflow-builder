'use client';

import { useSignOut, useUserEmail } from '@nhost/nextjs';
import { useOrg } from './OrgContext';

export default function TopBar() {
  const { memberships, current, setOrg, role } = useOrg();
  const { signOut } = useSignOut();
  const email = useUserEmail();

  return (
    <div className="topbar">
      <div className="brand">
        Workflow runner <span>agent steps, one org at a time</span>
      </div>

      {memberships.length > 0 && (
        <div className="row">
          <select
            aria-label="Organization"
            value={current?.org_id ?? ''}
            onChange={(e) => setOrg(e.target.value)}
            style={{ width: 'auto' }}
          >
            {memberships.map((m) => (
              <option key={m.org_id} value={m.org_id}>
                {m.organization.name}
              </option>
            ))}
          </select>
          <span className={`chip s-${role === 'viewer' ? 'idle' : 'running'}`}>{role}</span>
        </div>
      )}

      <span className="muted stat">{email}</span>
      <button onClick={() => signOut()}>Sign out</button>
    </div>
  );
}
