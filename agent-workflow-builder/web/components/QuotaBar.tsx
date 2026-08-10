'use client';

import { useQuery } from '@apollo/client';
import { ORG_USAGE } from '@/lib/graphql';
import { useOrg } from './OrgContext';

/** Reads the Postgres view through Hasura — one aggregated row per org. */
export default function QuotaBar() {
  const { current } = useOrg();
  const { data } = useQuery(ORG_USAGE, {
    variables: { orgId: current?.org_id },
    skip: !current,
    pollInterval: 5000,
  });

  const usage = data?.org_usage_current_month?.[0];
  if (!usage) return null;

  const pct = usage.quota_limit ? Math.min(100, (usage.quota_used / usage.quota_limit) * 100) : 0;
  const tone = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Runs used this month</h2>
        <span className="stat">
          {usage.quota_used} / {usage.quota_limit}
        </span>
      </div>
      <div className={`meter ${tone}`} style={{ margin: '10px 0' }}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="row stat muted" style={{ gap: 18 }}>
        <span>{usage.runs_this_month} started</span>
        <span>{usage.succeeded_this_month} succeeded</span>
        <span>{usage.failed_this_month} failed</span>
        <span>avg {usage.avg_run_seconds ?? '—'}s</span>
      </div>
      {pct >= 100 && (
        <p className="sub" style={{ marginTop: 10 }}>
          Quota reached. New runs are refused until the counter resets next month.
        </p>
      )}
    </div>
  );
}
