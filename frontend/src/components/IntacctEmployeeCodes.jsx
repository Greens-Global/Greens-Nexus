// People > Sync Employee Codes From Intacct (Charmi, Oct 21 2026).
//
// A preview of every person's Nexus code next to their Intacct EMPLOYEEID,
// how they were matched (work email first, then exact name), and what Apply
// would do: Update / Keep / No Match / Conflict. HR ticks the rows to update;
// email matches are ticked by default. The nightly switch per company only
// ever applies work-email matches whose Nexus code is empty or was last set
// by this sync (routers/hr_intacct_codes.py) - everything else waits here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { formatDateTime } from '../lib/datetime';

export const ACTION_META = {
  update:   { label: 'Update',   bg: 'hsla(var(--color-blue),0.1)',    fg: 'hsl(var(--color-blue))' },
  keep:     { label: 'Keep',     bg: 'hsla(var(--color-green),0.1)',   fg: 'hsl(var(--color-green))' },
  no_match: { label: 'No Match', bg: 'var(--mist)',                    fg: 'var(--muted)' },
  conflict: { label: 'Conflict', bg: 'hsla(var(--color-red),0.1)',     fg: 'hsl(var(--color-red))' },
};
const MATCH_LABEL = { email: 'Work Email', name: 'Name', name_company: 'Name + Company' };
const FILTERS = ['all', 'update', 'keep', 'no_match', 'conflict'];

const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--card)' };
const td = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid var(--line)', verticalAlign: 'top' };
const sub = { display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 };

function Chip({ action }) {
  const m = ACTION_META[action] || ACTION_META.no_match;
  return <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

export default function IntacctEmployeeCodes({ onClose, onApplied, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState({});        // employeeId -> intacctCode
  const [filter, setFilter] = useState('all');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const [settings, setSettings] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const out = await api.intacctCodesPreview();
      setData(out);
      // Email matches are the confident ones - ticked by default.
      setPicked(Object.fromEntries((out.rows || []).filter(r => r.action === 'update' && r.matchBy === 'email').map(r => [r.employeeId, r.intacctCode])));
    } catch (e) {
      setError(e?.message || 'Could not read Intacct. Nothing was changed.');
    } finally {
      setLoading(false);
    }
  }, []);
  const loadSettings = useCallback(async () => {
    try { setSettings(await api.intacctCodesSettings()); } catch { setSettings({ companies: [], lastRun: {} }); }
  }, []);
  useEffect(() => { load(); loadSettings(); }, [load, loadSettings]);

  const rows = useMemo(() => (data?.rows || []).filter(r => filter === 'all' || r.action === filter), [data, filter]);
  const updatable = useMemo(() => (data?.rows || []).filter(r => r.action === 'update'), [data]);
  const count = Object.keys(picked).length;

  const toggle = (r) => setPicked(p => {
    const next = { ...p };
    if (next[r.employeeId]) delete next[r.employeeId]; else next[r.employeeId] = r.intacctCode;
    return next;
  });
  const pickAll = (on) => setPicked(on ? Object.fromEntries(updatable.map(r => [r.employeeId, r.intacctCode])) : {});

  const apply = async () => {
    if (!count) return;
    setApplying(true);
    try {
      const out = await api.intacctCodesApply(Object.entries(picked).map(([employeeId, code]) => ({ employeeId, code })));
      setResult(out);
      if (out.applied?.length) {
        toastOk?.(`Updated ${out.applied.length} employee code${out.applied.length === 1 ? '' : 's'} from Intacct.`);
        onApplied?.();
      }
      if (out.skipped?.length) toastErr?.(`${out.skipped.length} row${out.skipped.length === 1 ? ' was' : 's were'} not changed - see the list below.`);
      await load();
    } catch (e) {
      toastErr?.(e?.message || 'Could not apply the codes. Nothing was changed.');
    } finally {
      setApplying(false);
    }
  };

  const setNightly = async (c, on) => {
    try {
      await api.setIntacctCodesNightly(c.id, on);
      setSettings(s => ({ ...s, companies: s.companies.map(x => x.id === c.id ? { ...x, nightly: on } : x) }));
      toastOk?.(`Nightly sync ${on ? 'on' : 'off'} for ${c.name}.`);
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the setting.');
    }
  };

  const last = settings?.lastRun || {};
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, width: '100%', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{count} selected</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="secondary-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" onClick={apply} disabled={!count || applying || loading}>
          {applying ? 'Applying...' : `Apply ${count || ''}`.trim()}
        </button>
      </div>
    </div>
  );

  return (
    <Modal title="Sync Employee Codes From Intacct" onClose={onClose} footer={footer} minHeight="60vh">
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' }}>
        Matched by work email first, then by exact name (and company when two people share a name). Nothing changes until you apply it, and every change is recorded in the audit log.
      </p>

      {data?.source === 'ledger' && (
        <div style={{ background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 12 }}>
          <strong>Source: {data.sourceLabel || 'Ledger codes, names only'}.</strong> Nexus is not connected to Intacct on this server, so only the employee codes on the ledger are shown and people are matched by name. Check each row before applying.
        </div>
      )}
      {data && data.source !== 'ledger' && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          Source: {data.sourceLabel || 'Intacct (direct)'} - work email, name, status and location read from Intacct.
        </div>
      )}

      {loading && !data && <SkeletonBlocks count={3} height={56} />}
      {error && <div style={{ marginBottom: 12 }}><ErrorBanner message={error} onRetry={load} /></div>}

      {data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <div className="scroll-tabs" role="tablist" aria-label="Filter rows" style={{ display: 'flex', gap: 4 }}>
              {FILTERS.map(f => {
                const n = f === 'all' ? (data.rows || []).length : (data.counts?.[f] || 0);
                return (
                  <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                    style={{ padding: '5px 12px', borderRadius: 20, border: '1px solid var(--line)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap',
                      background: filter === f ? 'var(--ink)' : 'var(--card)', color: filter === f ? 'var(--card)' : 'var(--ink)' }}>
                    {f === 'all' ? 'All' : ACTION_META[f].label} {n}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="secondary-btn" onClick={() => pickAll(count < updatable.length)} disabled={!updatable.length}>
                {count < updatable.length ? 'Select All Updates' : 'Clear Selection'}
              </button>
              <button className="secondary-btn" onClick={load} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
          </div>

          <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'auto', maxHeight: '42vh' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Inter,sans-serif' }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 34 }} aria-label="Select" />
                  <th style={th}>Nexus Person</th>
                  <th style={th}>Current Code</th>
                  <th style={th}>Intacct Code</th>
                  <th style={th}>Match By</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} style={{ ...td, color: 'var(--muted)', textAlign: 'center', padding: 24 }}>No people in this view.</td></tr>
                )}
                {rows.map(r => (
                  <tr key={r.employeeId}>
                    <td style={td}>
                      {r.action === 'update' && (
                        <input type="checkbox" aria-label={`Update ${r.name}`} checked={!!picked[r.employeeId]} onChange={() => toggle(r)} />
                      )}
                    </td>
                    <td style={td}>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      <span style={sub}>{[r.workEmail, r.companyName].filter(Boolean).join(' - ')}</span>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace,monospace' }}>{r.currentCode || <span style={{ color: 'var(--muted)' }}>None</span>}</td>
                    <td style={td}>
                      {r.intacctCode ? (
                        <>
                          <span style={{ fontFamily: 'ui-monospace,monospace' }}>{r.intacctCode}</span>
                          <span style={sub}>{[r.intacctName, r.intacctStatus, r.intacctLocation].filter(Boolean).join(' - ')}</span>
                        </>
                      ) : <span style={{ color: 'var(--muted)' }}>-</span>}
                    </td>
                    <td style={td}>{MATCH_LABEL[r.matchBy] || '-'}</td>
                    <td style={td}>
                      <Chip action={r.action} />
                      {r.action === 'update' && r.replacesNexusCode && <span style={sub}>Replaces {r.currentCode}, set in Nexus</span>}
                      {r.reason && r.action !== 'update' && <span style={sub}>{r.reason}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result?.skipped?.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12.5 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Not Changed</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)' }}>
                {result.skipped.map(s => <li key={s.employeeId}>{s.name || s.employeeId}: {s.reason}</li>)}
              </ul>
            </div>
          )}

          {data.notInNexus?.length > 0 && (
            <details style={{ marginTop: 12, fontSize: 13 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>In Intacct, Not Matched in Nexus ({data.notInNexus.length})</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--muted)' }}>
                {data.notInNexus.map(n => <li key={n.employeeId}>{n.employeeId} - {[n.name, n.email, n.status].filter(Boolean).join(' - ')}</li>)}
              </ul>
            </details>
          )}
        </>
      )}

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Automatic Nightly Sync</div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px' }}>
          Once a night, for the companies switched on: fills or updates codes only for work email matches whose Nexus code is empty or was set by this sync. Everything else stays here for HR to review.
        </p>
        {!settings && <SkeletonBlocks count={1} height={36} />}
        {settings && settings.companies.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No companies set up yet.</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
          {settings?.companies.map(c => (
            <label key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!c.nightly} onChange={e => setNightly(c, e.target.checked)} /> {c.name}
            </label>
          ))}
        </div>
        {last.at && (
          <div style={{ fontSize: 12, color: last.ok ? 'var(--muted)' : 'hsl(var(--color-red))', marginTop: 8 }}>
            Last run {formatDateTime(last.at)}: {last.ok
              ? `${last.applied || 0} updated, ${last.review || 0} waiting for review`
              : `nothing changed - ${last.error || 'Intacct could not be read'}`}
          </div>
        )}
      </div>
    </Modal>
  );
}
