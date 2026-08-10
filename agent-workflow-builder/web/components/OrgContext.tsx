'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@apollo/client';
import { useAuthenticationStatus } from '@nhost/nextjs';
import { MY_ORGS } from '@/lib/graphql';

export type OrgRole = 'owner' | 'editor' | 'viewer';
export type Membership = { org_id: string; role: OrgRole; organization: { id: string; name: string } };

type OrgCtx = {
  memberships: Membership[];
  current: Membership | null;
  setOrg: (orgId: string) => void;
  loading: boolean;
  /** role in the *currently selected* org — never a global claim */
  role: OrgRole | null;
  canEdit: boolean;
  canRun: boolean;
  isOwner: boolean;
};

const Ctx = createContext<OrgCtx>({
  memberships: [], current: null, setOrg: () => {}, loading: true,
  role: null, canEdit: false, canRun: false, isOwner: false,
});

export const useOrg = () => useContext(Ctx);

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthenticationStatus();
  const { data, loading } = useQuery(MY_ORGS, { skip: !isAuthenticated });
  const [orgId, setOrgId] = useState<string | null>(null);

  const memberships: Membership[] = data?.org_members ?? [];

  useEffect(() => {
    if (!memberships.length) return;
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('orgId') : null;
    const valid = memberships.find((m) => m.org_id === saved);
    setOrgId(valid?.org_id ?? memberships[0].org_id);
  }, [data]);

  const value = useMemo<OrgCtx>(() => {
    const current = memberships.find((m) => m.org_id === orgId) ?? null;
    const role = current?.role ?? null;
    return {
      memberships,
      current,
      loading,
      role,
      canEdit: role === 'owner' || role === 'editor',
      canRun: role === 'owner' || role === 'editor',
      isOwner: role === 'owner',
      setOrg: (id: string) => {
        setOrgId(id);
        if (typeof window !== 'undefined') window.localStorage.setItem('orgId', id);
      },
    };
  }, [memberships, orgId, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
