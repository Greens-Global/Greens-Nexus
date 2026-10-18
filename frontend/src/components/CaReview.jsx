// California Review (Neil, Oct 18 2026) - People > Time > Payroll, HR only.
// An automated check of every CA-rule employee's pay period against
// California rules (backend/ca_review.py, off the same timecard engine):
// meal breaks and waivers, the signing question, 7th-day and double time,
// over-16-hour days, split shifts, reporting time, the state minimum wage,
// and manual time with no reason. Each flag says why in one line; HR opens
// the Time Sheet and Resolves it with a note (or Reopens it). A resolved flag
// opens again by itself when the facts behind it change.
import { useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, ArrowRight, Scale, SlidersHorizontal } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { Spinner, ErrorBanner } from './AsyncState';
import { StatusLabel } from './StatusLabel';
import { Modal } from '../tasks/components';
import { dialog } from '../ui/dialog';

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export default function CaReview({ onOpenTimecard, toastOk, toastErr }) {
  const [anchor, setAnchor] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stepLocked, setStepLocked] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const run = useCallback(async (at = anchor) => {
    setLoading(true); setError(''); setStepLocked(false);
    try {
      const r = await api.caReview(at);
      setData(r); setAnchor(r?.period?.start || at);
    } catch (e) {
      if (isStepUpRequired(e)) setStepLocked(true);
      else setError(e?.message || 'The California Review could not run.');
    } finally { setLoading(false); }
  }, [anchor]);

  async function resolve(f) {
    const note = await dialog.prompt(`How was this handled? ${f.reason}`,
      { title: 'Resolve Flag', confirmText: 'Resolve', required: true, multiline: true });
    if (!note) return;
    setBusyKey(f.email + f.key);
    try {
      await api.caReviewResolve({ email: f.email, periodStart: f.periodStart, key: f.key, note });
      toastOk?.('Flag resolved.');
      await run(anchor);
    } catch (e) { toastErr?.(e?.message || 'Could not resolve the flag.'); }
    setBusyKey('');
  }
  async function reopen(f) {
    setBusyKey(f.email + f.key);
    try {
      await api.caReviewReopen({ email: f.email, periodStart: f.periodStart, key: f.key });
      toastOk?.('Flag reopened.');
      await run(anchor);
    } catch (e) { toastErr?.(e?.message || 'Could not reopen the flag.'); }
    setBusyKey('');
  }

  const P = data?.period;
  const rows = (data?.rows || []).filter(r => showResolved || r.status === 'open');
  const resolvedCount = (data?.rows || []).filter(r => r.status === 'resolved').length;

  return (
    <section data-testid="ca-review" style={{ border: '1px solid var(--wk-line2, var(--line))', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Scale size={16} style={{ color: 'var(--wk-brand)' }} />
        <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: 'var(--ink)' }}>California Review</h3>
        {data && (
          <StatusLabel size="sm" label={`${data.openCount} Open`} color={data.openCount ? '#b45309' : '#16a34a'} />
        )}
        {P && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--muted)' }}>
            <button type="button" className="secondary-btn" aria-label="Previous Period" disabled={loading} onClick={() => run(addDays(P.start, -14))} style={{ padding: '2px 6px' }}><ChevronLeft size={14} /></button>
            <span>{formatDate(P.start)} - {formatDate(P.end)}</span>
            <button type="button" className="secondary-btn" aria-label="Next Period" disabled={loading} onClick={() => run(addDays(P.end, 1))} style={{ padding: '2px 6px' }}><ChevronRight size={14} /></button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        {data && (
          <button type="button" className="secondary-btn" onClick={() => setSettingsOpen(true)}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><SlidersHorizontal size={13} /> Minimum Wage</button>
        )}
        <button type="button" className={data ? 'secondary-btn' : 'primary-btn'} disabled={loading} onClick={() => run(anchor)}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {loading ? <Spinner size={13} /> : (data ? <RefreshCw size={13} /> : <Scale size={13} />)}
          {data ? 'Refresh' : 'Run Review'}
        </button>
      </div>

      {!data && !loading && !error && !stepLocked && (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
          Check every time sheet of staff on the California overtime rule against California rules - meal breaks, 7th-day and double time, split shifts, reporting time, minimum wage and manual time. HR resolves each flag with a note.
        </p>
      )}
      {loading && !data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0 2px', fontSize: 12.5, color: 'var(--muted)' }}>
          <Spinner size="inline" /> Reading every California time sheet in your scope.
        </div>
      )}
      {error && <div style={{ marginTop: 10 }}><ErrorBanner message={error} onRetry={() => run(anchor)} /></div>}
      {stepLocked && <StepUpNeeded label="The California Review shows employees’ pay rates." onVerified={() => run(anchor)} />}

      {data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <span>{data.people} {data.people === 1 ? 'person' : 'people'} on the California rule checked.</span>
            {resolvedCount > 0 && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Show {resolvedCount} Resolved
              </label>
            )}
          </div>
          {!rows.length ? (
            <div style={{ padding: '14px 4px 6px', fontSize: 12.5, color: 'var(--muted)' }}>Nothing to look at for this period.</div>
          ) : (
            <div role="table" aria-label="California Review Flags" style={{ maxHeight: 420, overflowY: 'auto', marginTop: 6 }}>
              <div role="row" style={{ display: 'flex', gap: 12, padding: '8px 4px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>
                <span role="columnheader" style={{ flex: '0 0 170px' }}>Name</span>
                <span role="columnheader" style={{ flex: '0 0 90px' }}>Day</span>
                <span role="columnheader" style={{ flex: 1 }}>Reason</span>
                <span role="columnheader" style={{ flex: '0 0 230px', textAlign: 'right' }}>Actions</span>
              </div>
              {rows.map(f => (
                <div role="row" key={f.email + f.key} data-flag={f.key}
                  style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', padding: '9px 4px', borderBottom: '1px solid var(--line)' }}>
                  <div role="cell" style={{ flex: '0 0 170px', minWidth: 0, fontSize: 13, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                  <div role="cell" style={{ flex: '0 0 90px', fontSize: 12.5 }}>{formatDate(f.date)}</div>
                  <div role="cell" style={{ flex: 1, minWidth: 200, fontSize: 12.5, lineHeight: 1.4 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: '#b45309', marginRight: 6, textTransform: 'uppercase', letterSpacing: '.03em' }}>{f.ruleLabel}</span>
                    {f.reason}
                    {f.changedSinceResolved && <div style={{ fontSize: 11.5, color: '#b45309' }}>Resolved before, but the facts changed since.</div>}
                    {f.status === 'resolved' && f.resolution && (
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Resolved {formatDateTime(f.resolution.at)}: {f.resolution.note}</div>
                    )}
                  </div>
                  <div role="cell" style={{ flex: '0 0 230px', display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button type="button" className="secondary-btn" onClick={() => onOpenTimecard?.(f.email, f.periodStart, 'hourly')}
                      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Open Time Sheet <ArrowRight size={12} /></button>
                    {f.status === 'open'
                      ? <button type="button" className="primary-btn" disabled={busyKey === f.email + f.key} onClick={() => resolve(f)} style={{ fontSize: 12 }}>Resolve</button>
                      : <button type="button" className="secondary-btn" disabled={busyKey === f.email + f.key} onClick={() => reopen(f)} style={{ fontSize: 12 }}>Reopen</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
            Checked {formatDateTime(data.generatedAt)}. Minimum wage ${Number(data.settings?.minWage || 0).toFixed(2)}/hr (California state - city and county minimums are not checked).
          </div>
        </>
      )}
      {settingsOpen && (
        <MinWageSettings current={data?.settings?.minWage} onClose={() => setSettingsOpen(false)} toastOk={toastOk} toastErr={toastErr}
          onSaved={() => { setSettingsOpen(false); run(anchor); }} />
      )}
    </section>
  );
}

function MinWageSettings({ current, onClose, onSaved, toastOk, toastErr }) {
  const [v, setV] = useState(current ?? 16.9);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.caReviewSaveSettings({ minWage: Number(v) }); toastOk?.('Minimum wage saved.'); onSaved?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not save the minimum wage.'); }
    setBusy(false);
  }
  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  );
  return (
    <Modal title="California Minimum Wage" onClose={onClose} footer={footer}>
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          The California state minimum wage the review checks pay rates against ($16.90/hr in 2026). City and county minimums are not checked.
        </p>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--ink)', maxWidth: 240 }}>
          Minimum Wage ($/hr)
          <input className="form-input" type="number" min={0.01} step={0.01} aria-label="Minimum Wage" value={v}
            onChange={e => setV(e.target.value)} style={{ fontSize: 13 }} />
        </label>
      </div>
    </Modal>
  );
}
