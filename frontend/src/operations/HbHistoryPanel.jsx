// Ops Budget > Hummingbird History (administrators / Operations Owner, Oct 21
// 2026): what the last Hummingbird export load put into Nexus, per site -
// the months rebuilt, units, leases, lease-months - plus the load log (files,
// who, when, warnings). Read-only: the export is loaded by an administrator
// with the command-line loader (python -m hb_load), never uploaded here.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import { monthText } from './opsBudgetFormat';

const LABEL = {
  avg_standard_rate: 'Standard rate', gpr: 'Gross potential rent', autopay_tenants: 'Tenants on autopay',
  reservations: 'Reservations', reservations_converted: 'Reservations converted', leads: 'Leads',
  website_visitors: 'Website visitors', new_reviews: 'Reviews', avg_review_rating: 'Review rating', tows: 'Tows',
};
const n = (v) => (v == null ? '-' : Number(v).toLocaleString('en-US'));

export default function HbHistoryPanel({ onClose }) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    api.getOpsHummingbird()
      .then((data) => { if (live) setState({ status: 'ready', data }); })
      .catch((err) => { console.error('Ops Budget: Hummingbird status failed', err); if (live) setState({ status: 'error', data: null }); });
    return () => { live = false; };
  }, [nonce]);
  const load = () => { setState({ status: 'loading', data: null }); setNonce((x) => x + 1); };
  const d = state.data;
  const last = d?.loads?.[0];

  return (
    <Modal title="Hummingbird History" onClose={onClose} minHeight="60vh"
      footer={<div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" className="secondary-btn" onClick={onClose}>Close</button></div>}>
      <div className="ob-up" data-testid="hb-panel">
        <p className="ops-note" style={{ margin: 0 }}>
          Month-by-month history from the Hummingbird export (09/12/2026), rebuilt from every lease, unit, invoice and
          payment. Before Cubby it is the source for every figure it has; the workbook fills the rest. No tenant names or
          contact details are kept.
        </p>
        {state.status === 'loading' && <LoadingState size="section" label="Loading Hummingbird history" minHeight={160} />}
        {state.status === 'error' && <ErrorBanner message="Couldn't load the Hummingbird history status." onRetry={load} />}
        {d && (
          <>
            {!last ? (
              <p className="ops-note" style={{ margin: 0 }}>
                Nothing loaded yet. An administrator runs <code>{d.command}</code> on a machine that holds the export.
              </p>
            ) : (
              <p className="ops-note" style={{ margin: 0 }} data-testid="hb-last-load">
                Last load {formatDateTime(last.startedAt)} by {last.by || 'an administrator'} ·{' '}
                <span className={last.status === 'ok' ? 'ob-up-ok' : 'ob-up-error'}>{last.status === 'ok' ? 'Loaded' : last.status === 'failed' ? 'Failed' : 'Running'}</span>
                {last.files?.length ? ` · ${last.files.length} files` : ''}
              </p>
            )}
            <div className="req-table-wrapper">
              <table className="req-table stack-table ob-up-table">
                <thead><tr><th>Site</th><th>On Hummingbird From</th><th>Months Rebuilt</th><th className="num">Units</th>
                  <th className="num">Leases</th><th className="num">Lease-Months</th><th className="num">Unit Types</th></tr></thead>
                <tbody>
                  {d.sites.length === 0 && <tr><td colSpan={7}>No sites loaded.</td></tr>}
                  {d.sites.map((s) => (
                    <tr key={s.id}>
                      <td data-th="Site">{s.shortName || s.name}{!s.facilityId && <span className="ops-note"> (not matched to a site)</span>}</td>
                      <td data-th="On Hummingbird From">{s.goLive ? formatDate(s.goLive) : '-'}</td>
                      <td data-th="Months Rebuilt">{s.first ? `${monthText(s.first)} - ${monthText(s.last)}` : '-'}</td>
                      <td data-th="Units" className="num">{n(s.units)}</td>
                      <td data-th="Leases" className="num">{n(s.leases)}</td>
                      <td data-th="Lease-Months" className="num">{n(s.leaseMonths)}</td>
                      <td data-th="Unit Types" className="num">{n(s.unitTypes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {last?.warnings?.length > 0 && (
              <div className="ob-up-list ob-up-warn">
                <h4>Warnings</h4>
                <ul>{last.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </div>
            )}
            <div className="ob-up-list ob-up-note">
              <h4>Not in Hummingbird&apos;s Export</h4>
              <p className="ops-note" style={{ margin: 0 }}>{d.notProvided.map((k) => LABEL[k] || k).join(', ')} - these come from the workbook for months before Cubby.</p>
            </div>
            {d.loads.length > 0 && (
              <>
                <h4 className="ob-up-h">Recent Loads</h4>
                <ul className="ob-up-loads">
                  {d.loads.map((l) => (
                    <li key={l.id}>
                      <span>{formatDateTime(l.startedAt)} · {l.by} · {l.status === 'ok' ? 'Loaded' : l.status === 'failed' ? 'Failed' : 'Running'}
                        {l.counts?.hb_leases ? ` · ${n(l.counts.hb_leases)} leases` : ''}{l.counts?.ops_metric_month ? ` · ${n(l.counts.ops_metric_month)} figures` : ''}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
