import { useState, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ClipboardCheck, RefreshCw, SlidersHorizontal, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { FILTERS, SETTING_FIELDS, filterRows, issueLines } from '../lib/payrollReadiness';
import { isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { Spinner, ErrorBanner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { Modal } from '../tasks/components';

// Payroll Readiness (Neil, Oct 17 2026) - People > Time > Payroll. Before
// payroll runs: who is not ready (approval, signature, missing punches, open
// fixes, no pay rate), what changed a lot on the previous period or the
// schedule, and what looks unusual for the person. The server does every
// figure off the timecard engine (backend/payroll_readiness.py); this only
// shows it. The check runs on demand - it reads every time card in scope.

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const LINE_COLOR = { exception: '#b91c1c', note: 'var(--muted)', variance: '#b45309', anomaly: '#7c3aed' };
const LINE_TAG = { exception: 'Exception', note: 'Note', variance: 'Variance', anomaly: 'Anomaly' };

const chip = (label, n, color, active, onClick) => (
  <button type="button" onClick={onClick} aria-pressed={active}
    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 99, cursor: 'pointer',
      border: `1px solid ${active ? color : 'var(--line)'}`, background: active ? 'var(--wk-brand-tint)' : 'var(--card)',
      fontFamily: 'var(--wk-font)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
    <span style={{ fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{n}</span> {label}
  </button>
);

export default function PayrollReadiness({ onOpenTimecard, toastOk, toastErr }) {
  const [anchor, setAnchor] = useState('');          // '' = the last period that is over
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stepLocked, setStepLocked] = useState(false);
  const [filter, setFilter] = useState('all');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const run = useCallback(async (at = anchor, refresh = false) => {
    setLoading(true); setError(''); setStepLocked(false);
    try {
      const r = await api.payrollReadiness(at, refresh);
      setData(r); setAnchor(r?.period?.start || at);
    } catch (e) {
      if (isStepUpRequired(e)) setStepLocked(true);
      else setError(e?.message || 'The readiness check could not run.');
    } finally { setLoading(false); }
  }, [anchor]);

  const P = data?.period;
  const S = data?.summary;
  const rows = filterRows(data?.rows, filter);

  return (
    <section data-testid="payroll-readiness" style={{ border: '1px solid var(--wk-line2, var(--line))', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ClipboardCheck size={16} style={{ color: 'var(--wk-brand)' }} />
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: 'var(--ink)' }}>Payroll Readiness</h3>
        {P && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--muted)' }}>
            <button type="button" className="secondary-btn" aria-label="Previous Period" disabled={loading} onClick={() => run(addDays(P.start, -14))} style={{ padding: '2px 6px' }}><ChevronLeft size={14} /></button>
            <span>{formatDate(P.start)} - {formatDate(P.end)}</span>
            <button type="button" className="secondary-btn" aria-label="Next Period" disabled={loading} onClick={() => run(addDays(P.end, 1))} style={{ padding: '2px 6px' }}><ChevronRight size={14} /></button>
            <span title="Salaried people are checked on their month">Salaried: {formatDate(P.monthStart)} - {formatDate(P.monthEnd)}</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        {data && !data.payHidden && (
          <button type="button" className="secondary-btn" onClick={() => setSettingsOpen(true)}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><SlidersHorizontal size={13} /> Thresholds</button>
        )}
        <button type="button" className={data ? 'secondary-btn' : 'primary-btn'} disabled={loading} onClick={() => run(anchor, !!data)}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {loading ? <Spinner size={13} /> : (data ? <RefreshCw size={13} /> : <ClipboardCheck size={13} />)}
          {data ? 'Refresh' : 'Run Check'}
        </button>
      </div>

      {!data && !loading && !error && !stepLocked && (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
          Check who is not ready for payroll before you export - approvals, signatures, missing punches, open fixes and pay rates, plus big changes and unusual weeks.
        </p>
      )}
      {loading && !data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0 2px', fontSize: 12.5, color: 'var(--muted)' }}>
          <Spinner size="inline" /> Reading every time sheet in your scope - this can take a few seconds.
        </div>
      )}
      {error && <div style={{ marginTop: 10 }}><ErrorBanner message={error} onRetry={() => run(anchor, true)} /></div>}
      {stepLocked && <StepUpNeeded label="Payroll Readiness shows employees’ pay figures." onVerified={() => run(anchor)} />}

      {data && S && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {chip('Ready', S.ready, 'hsl(var(--color-green))', false, () => setFilter('all'))}
            {chip(S.notReady === 1 ? 'Needs Attention' : 'Need Attention', S.notReady, '#b91c1c', filter === 'exceptions', () => setFilter('exceptions'))}
            {chip('With Variance', S.withVariance, '#b45309', filter === 'variance', () => setFilter('variance'))}
            {chip('With Anomalies', S.withAnomalies, '#7c3aed', filter === 'anomalies', () => setFilter('anomalies'))}
          </div>
          <div className="scroll-tabs" role="tablist" aria-label="Filter" style={{ display: 'flex', gap: 2, marginTop: 10, borderBottom: '1px solid var(--line)' }}>
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                style={{ padding: '7px 12px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: 12.5,
                  fontWeight: filter === key ? 700 : 600, color: filter === key ? 'var(--wk-brand)' : 'var(--muted)', marginBottom: -1,
                  borderBottom: filter === key ? '2px solid var(--wk-brand)' : '2px solid transparent', whiteSpace: 'nowrap' }}>{label}</button>
            ))}
          </div>
          {!rows.length ? (
            <div style={{ padding: '16px 4px 6px', fontSize: 12.5, color: 'var(--muted)' }}>
              {filter === 'all' ? `Everyone in your scope is ready for this period (${S.people} ${S.people === 1 ? 'person' : 'people'} checked).` : 'Nobody matches this filter.'}
            </div>
          ) : (
            <div role="table" aria-label="People To Check" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <div role="row" style={{ display: 'flex', gap: 12, padding: '8px 4px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>
                <span role="columnheader" style={{ flex: '0 0 190px' }}>Name</span>
                <span role="columnheader" style={{ flex: 1 }}>What Is Wrong</span>
                <span role="columnheader" style={{ flex: '0 0 130px', textAlign: 'right' }}>Time Sheet</span>
              </div>
              {rows.map(r => (
                <div role="row" key={r.email} data-email={r.email}
                  style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', padding: '9px 4px', borderBottom: '1px solid var(--line)' }}>
                  <div role="cell" style={{ flex: '0 0 190px', minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[r.department, r.company, r.payType === 'fixed' ? 'Salaried' : ''].filter(Boolean).join(' · ')}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <StatusLabel size="sm" label={r.ready ? 'Ready' : 'Not Ready'} color={r.ready ? '#16a34a' : '#dc2626'} />
                    </div>
                  </div>
                  <ul role="cell" style={{ flex: 1, minWidth: 220, margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 3 }}>
                    {issueLines(r).map((l, i) => (
                      <li key={i} style={{ fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.4 }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, color: LINE_COLOR[l.kind], marginRight: 6, textTransform: 'uppercase', letterSpacing: '.03em' }}>{LINE_TAG[l.kind]}</span>
                        {l.text}
                      </li>
                    ))}
                  </ul>
                  <div role="cell" style={{ flex: '0 0 130px', textAlign: 'right' }}>
                    <button type="button" className="secondary-btn" onClick={() => onOpenTimecard?.(r.email, r.periodStart, r.payType)}
                      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Open Time Sheet <ArrowRight size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
            Checked {formatDateTime(data.generatedAt)}{data.payHidden ? ' - hours only, pay figures are HR’s.' : '.'}
          </div>
        </>
      )}

      {settingsOpen && (
        <ReadinessSettings onClose={() => setSettingsOpen(false)} toastOk={toastOk} toastErr={toastErr}
          onSaved={() => { if (data) run(anchor, true); }} />
      )}
    </section>
  );
}

// The thresholds themselves (Settings > Time & Pay > Payroll Readiness since
// Oct 23). `company` fixes the company - Settings' scope picker - and hides
// the select; on its own it offers the default (to whoever may edit it) and
// every company. The dialog below wraps it for the payroll screen.
export function ReadinessThresholds({ company: scoped, onSaved, toastOk, toastErr }) {
  const [company, setCompany] = useState(null);       // null = not loaded yet
  const [meta, setMeta] = useState(null);
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const load = useCallback(async (cid) => {
    setLoadErr('');
    try {
      const m = await api.payrollReadinessSettings(cid);
      setMeta(m); setVals(m.settings || {}); setCompany(m.company || '');
    } catch (e) { setLoadErr(e?.message || 'Could not load the thresholds.'); }
  }, []);
  // First load: the scoped company; else the default when this person may
  // edit it, else their first company.
  useEffect(() => {
    let live = true;
    api.payrollReadinessSettings(scoped || '').then(m => {
      if (!live) return;
      if (!scoped && !m.canEditDefault && (m.companies || []).length) { load(m.companies[0].id); return; }
      setMeta(m); setVals(m.settings || {}); setCompany(scoped || m.company || '');
    }).catch(e => { if (live) setLoadErr(e?.message || 'Could not load the thresholds.'); });
    return () => { live = false; };
  }, [load, scoped]);

  async function save(reset = false) {
    setBusy(true);
    try {
      const r = await api.payrollReadinessSaveSettings({ company, settings: vals, reset });
      setVals(r.settings || vals);
      setMeta(m => ({ ...m, override: r.override }));
      toastOk?.(reset ? 'Thresholds reset to the default.' : 'Thresholds saved.');
      onSaved?.();
    } catch (e) { toastErr?.(e?.message || 'Could not save the thresholds.'); }
    finally { setBusy(false); }
  }

  const canEdit = !!meta?.canEdit;
  if (loadErr) return <ErrorBanner message={loadErr} onRetry={() => load(company || '')} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
        A change is flagged when it is over the percent OR the hours. Each company can keep its own; a company with none uses the default.
      </p>
      {!scoped && (meta.companies || []).length > 0 && (
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
          Company
          <select className="form-input" value={company ?? ''} aria-label="Company" onChange={e => load(e.target.value)} style={{ fontSize: 13 }}>
            {meta.canEditDefault && <option value="">All Companies (Default)</option>}
            {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {company && <span style={{ fontWeight: 400 }}>{meta.override ? 'This company has its own thresholds.' : 'This company uses the default.'}</span>}
        </label>
      )}
      {scoped && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has its own thresholds.' : 'This company uses the default.'}</span>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {SETTING_FIELDS.map(([k, label, hint]) => {
          const [lo, hi] = meta.limits?.[k] || [1, 500];
          return (
            <label key={k} style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>
              {label}
              <input className="form-input" type="number" min={lo} max={hi} step={1} aria-label={label} disabled={!canEdit || busy}
                value={vals[k] ?? ''} onChange={e => setVals(v => ({ ...v, [k]: e.target.value === '' ? '' : Number(e.target.value) }))}
                style={{ fontSize: 13 }} />
              <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--muted)' }}>{hint}</span>
            </label>
          );
        })}
      </div>
      {!canEdit ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>Only HR can change these.</p>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</button>
          {company && meta.override && (
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(true)}>Use the Default</button>
          )}
        </div>
      )}
    </div>
  );
}

function ReadinessSettings({ onClose, onSaved, toastOk, toastErr }) {
  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
    </div>
  );
  return (
    <Modal title="Payroll Readiness Thresholds" onClose={onClose} footer={footer}>
      <ReadinessThresholds onSaved={onSaved} toastOk={toastOk} toastErr={toastErr} />
      <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--muted)' }}>Also under Settings &gt; Time &amp; Pay &gt; Payroll Readiness.</p>
    </Modal>
  );
}
