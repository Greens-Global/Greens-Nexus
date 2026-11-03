// Overdue per site (Construction plan phase 5, 11/03/2026): one quiet strip
// over the Tickets desk's Preventive queue and on a property's Preventive
// Maintenance tab - open and overdue preventive tickets per property and per
// company, from GET /maintenance/rollup (walled server-side). Red only for
// what is overdue (the house rule: color is for what someone must act on).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { StatusLabel } from '../components/StatusLabel';

const RED = '#dc2626';

export default function PreventiveRollup({ propertyId = '', onPick, data: given = null }) {
  const [data, setData] = useState(given);
  useEffect(() => {
    if (given) return undefined;
    let live = true;
    api.getMaintenanceRollup().then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [given]);
  if (!data) return null;
  const props = propertyId ? data.properties.filter((p) => p.propertyId === propertyId) : data.properties;
  if (!props.length) return null;
  const companies = propertyId ? [] : data.companies.filter((c) => c.open);
  return (
    <div role="region" aria-label="Preventive Maintenance by Site" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px', padding: '8px 16px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
      {!propertyId && <span style={{ fontWeight: 700 }}>By Site</span>}
      {props.slice(0, 8).map((p) => (
        <button key={p.propertyId} type="button" onClick={onPick ? () => onPick(p) : undefined} disabled={!onPick}
          title={p.overdue ? `Oldest overdue due ${formatDate(p.oldestOverdue)}` : p.nextDue ? `Next due ${formatDate(p.nextDue)}` : ''}
          style={{ all: 'unset', cursor: onPick ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {!propertyId && <span style={{ color: 'var(--ink)' }}>{p.propertyName}</span>}
          <span style={{ color: 'var(--muted)' }}>{p.open} Open</span>
          {p.overdue > 0 && <StatusLabel label={`${p.overdue} Overdue`} color={RED} size="sm" />}
          {propertyId && p.nextDue && <span style={{ color: 'var(--muted)' }}>· Next Due {formatDate(p.nextDue)}</span>}
        </button>
      ))}
      {props.length > 8 && <span style={{ color: 'var(--muted)' }}>+{props.length - 8} More</span>}
      {companies.length > 1 && (
        <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
          {companies.map((c) => `${c.companyName}: ${c.open} Open${c.overdue ? `, ${c.overdue} Overdue` : ''}`).join(' · ')}
        </span>
      )}
    </div>
  );
}
