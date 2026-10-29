// People > Performance > Review Cycles, made simple (Neil, Oct 29 2026). A
// new cycle is three fields - name, company, due date - and starts at once
// with everyone at the company who is past probation (not contractors). HR
// follows it on one table - person, manager, stage, rating - shares the
// finished ones (one at a time or Share All Ready) and closes it. Reminders
// go out by themselves.
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Plus, Send } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField } from '../tasks/components';
import { StatusLabel } from '../components/StatusLabel';
import { SkeletonBlocks, LoadingState, ErrorBanner } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { ReviewModal, ReviewStage } from './Reviews';
import { ProgressBar } from './Goals';
import { RATINGS, card, cardHead, HD, LBL, muted, TAP } from './lib';

const CYCLE_STATUS = { draft: { label: 'Draft', color: '#64748b' }, active: { label: 'Open', color: '#2563eb' }, closed: { label: 'Closed', color: '#16a34a' } };
const field = { display: 'grid', gap: 5, minWidth: 0 };

function DateBox({ value, onChange, label, placeholder = 'Pick a day' }) {
  return (
    <div style={field}>
      <span style={LBL}>{label}</span>
      <span className="form-input" style={{ display: 'flex', alignItems: 'center' }}>
        <DateField value={value} onChange={onChange} placeholder={placeholder} style={{ width: '100%' }} />
      </span>
    </div>
  );
}

// The six months ending today - what the server uses when no period is sent.
function defaultPeriod() {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 6);
  start.setDate(start.getDate() + 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [iso(start), iso(end)];
}

export function CycleFormModal({ companies, company, onClose, onSaved, toastErr }) {
  const [p0, p1] = defaultPeriod();
  const [f, setF] = useState({ name: `${new Date().getFullYear()} Year-End Review`, company: company || companies?.[0]?.id || '', due: '',
    periodStart: p0, periodEnd: p1 });
  const [period, setPeriod] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (v) => setF(p => ({ ...p, [k]: v }));
  async function save() {
    if (!f.name.trim()) { setErr('Name the review.'); return; }
    if (!f.due) { setErr('Pick the due date.'); return; }
    setBusy(true); setErr('');
    try {
      const out = await api.perfCycleCreate({ company_id: f.company, name: f.name.trim(), due: f.due,
        ...(period ? { period_start: f.periodStart, period_end: f.periodEnd } : {}) });
      onSaved?.(out);
    } catch (e) { setErr(e?.message || 'Could not start the review.'); toastErr?.(e?.message || 'Could not start the review.'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="New Review Cycle" onClose={onClose}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Starting…' : 'Start Review'}</button>
      </>}>
      <div style={{ display: 'grid', gap: 14 }}>
        {err && <ErrorBanner message={err} />}
        <label style={field}>
          <span style={LBL}>Name</span>
          <input className="form-input" value={f.name} onChange={e => set('name')(e.target.value)} autoFocus style={{ fontSize: 16 }} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {(companies || []).length > 1 && (
            <label style={field}>
              <span style={LBL}>Company</span>
              <select className="form-input" value={f.company} onChange={e => set('company')(e.target.value)} style={{ fontSize: 16 }}>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <DateBox label="Due Date" value={f.due} onChange={set('due')} />
        </div>
        <div style={{ ...muted, fontSize: 12.5, lineHeight: 1.55 }}>
          Everyone at the company who is past probation is in it (not contractors). Self reviews are due a week before the due date.
          {' '}Review period: <strong>{formatDate(f.periodStart)} to {formatDate(f.periodEnd)}</strong>
          {!period && <> · <button type="button" onClick={() => setPeriod(true)}
            style={{ border: 'none', background: 'none', padding: 0, color: 'var(--wk-brand)', cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>Change</button></>}
        </div>
        {period && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <DateBox label="Period From" value={f.periodStart} onChange={set('periodStart')} />
            <DateBox label="Period To" value={f.periodEnd} onChange={set('periodEnd')} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function RatingLine({ ratings }) {
  if (!ratings) return null;
  const total = RATINGS.reduce((n, r) => n + (ratings[r.key] || 0), 0);
  if (!total) return null;
  return <div style={{ ...muted, fontSize: 12.5 }}>{RATINGS.map(r => `${r.label} ${ratings[r.key] || 0}`).join(' - ')}</div>;
}

function CycleModal({ cycleId, onClose, onChanged, toastOk, toastErr }) {
  const phone = useIsMobile('(max-width: 640px)');
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState('');
  const load = useCallback(() => api.perfCycle(cycleId).then(setC).catch(e => setErr(e?.message || 'Could not load the review.')), [cycleId]);
  useEffect(() => { load(); }, [load]);
  const act = async (p, ok) => {
    setBusy(true);
    try { const out = await p(); if (ok) toastOk?.(typeof ok === 'function' ? ok(out) : ok); await load(); onChanged?.(); return true; }
    catch (e) {
      if (e?.status === 409 && /Close anyway/.test(e?.message || '')) { setConfirmClose(e.message); return false; }
      toastErr?.(e?.message || 'Could not do that.'); return false;
    }
    finally { setBusy(false); }
  };
  const total = c?.counts?.total || 0;
  const done = c?.counts?.complete || 0;
  const ready = c?.counts?.ready || 0;
  return (
    <Modal title={c ? c.name : 'Review Cycle'} onClose={onClose} width="72vw"
      footer={c ? <>
        {c.status === 'active' && <button type="button" className="secondary-btn" disabled={busy} onClick={() => act(() => api.perfCycleClose(c.id), 'Closed.')}>Close Cycle</button>}
        <button type="button" className="primary-btn" onClick={onClose}>Done</button>
      </> : <button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !c ? <LoadingState size="section" label="Loading the review" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusLabel label={CYCLE_STATUS[c.status]?.label || c.status} color={CYCLE_STATUS[c.status]?.color} size="md" />
            <span style={muted}>{[c.periodStart ? `${formatDate(c.periodStart)} to ${formatDate(c.periodEnd)}` : '',
              c.selfDue ? `Self reviews due ${formatDate(c.selfDue)}` : '', c.due ? `Due ${formatDate(c.due)}` : ''].filter(Boolean).join(' · ')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 200px' }}><ProgressBar value={total ? Math.round((done / total) * 100) : 0} label="Acknowledged" /></span>
            <span style={muted}>{done} of {total} acknowledged{c.counts?.overdue ? ` · ${c.counts.overdue} overdue` : ''}</span>
            {c.status === 'active' && (
              <button type="button" className="primary-btn" disabled={busy || !ready} style={{ ...TAP, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={() => act(() => api.perfCycleShareAll(c.id), (out) => `Shared ${out.shared}.`)}>
                <Send size={14} /> Share All Ready{ready ? ` (${ready})` : ''}
              </button>
            )}
          </div>
          <RatingLine ratings={c.counts?.ratings} />
          {confirmClose && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 12, borderRadius: 12, background: 'var(--mist)' }}>
              <span style={{ flex: '1 1 240px', fontSize: 13 }}>{confirmClose} Unfinished reviews stay as they are and can no longer be changed.</span>
              <button type="button" className="secondary-btn" onClick={() => setConfirmClose('')}>Keep It Open</button>
              <button type="button" className="primary-btn" disabled={busy}
                onClick={async () => { if (await act(() => api.perfCycleClose(c.id, true), 'Closed.')) setConfirmClose(''); }}>Close Anyway</button>
            </div>
          )}
          <div role="table" aria-label="Reviews" style={{ display: 'grid' }}>
            {!phone && (
              <div role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.5fr) auto minmax(90px, auto)', gap: 12, padding: '6px 4px', ...LBL }}>
                <span role="columnheader">Person</span><span role="columnheader">Manager</span>
                <span role="columnheader">Stage</span><span role="columnheader">Rating</span>
              </div>
            )}
            {(c.reviews || []).map(r => (
              <button key={r.id} type="button" role="row" onClick={() => setOpen(r.id)}
                style={{ display: 'grid', gridTemplateColumns: phone ? '1fr auto' : 'minmax(0, 2fr) minmax(0, 1.5fr) auto minmax(90px, auto)', gap: 10,
                  alignItems: 'center', padding: '10px 4px', minHeight: 44, border: 'none', borderTop: '1px solid var(--line)', background: 'transparent',
                  textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
                <span role="cell" style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{r.employeeName}</span>
                  {phone && <span style={{ display: 'block', ...muted, fontSize: 12 }}>{r.managerName}{r.ratingLabel ? ` · ${r.ratingLabel}` : ''}</span>}
                </span>
                {!phone && <span role="cell" style={{ fontSize: 13 }}>{r.managerName}</span>}
                <span role="cell" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {r.overdue && <StatusLabel label="Overdue" color="#dc2626" size="sm" />}
                  <ReviewStage stage={r.stage} />
                </span>
                {!phone && <span role="cell" style={{ fontSize: 13 }}>{r.ratingLabel || <span style={muted}>-</span>}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {open && <ReviewModal reviewId={open} onClose={() => { setOpen(''); load(); onChanged?.(); }} toastOk={toastOk} toastErr={toastErr} />}
    </Modal>
  );
}

export default function ReviewCycles({ company, companies, toastOk, toastErr }) {
  const [cycles, setCycles] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState('');
  const load = useCallback(() => {
    if (!company) return;
    api.perfCycles(company).then(r => { setErr(''); setCycles(r); }).catch(e => setErr(e?.message || 'Could not load the review cycles.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  return (
    <section style={card} aria-label="Review Cycles">
      <div style={cardHead}>
        <span className="wkc-chip"><ClipboardCheck size={14} /></span>
        <span style={HD}>Review Cycles</span>
        <button type="button" className="secondary-btn" onClick={() => setForm(true)} disabled={!company}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', minHeight: 36 }}><Plus size={14} /> New Review Cycle</button>
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} /> : cycles === null ? <SkeletonBlocks count={2} height={52} /> : !cycles.length
        ? <div style={muted}>No reviews yet. Start one with a name and a due date - everyone who belongs in it is added.</div> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {cycles.map(c => {
              const total = c.counts?.total || 0;
              return (
                <button key={c.id} type="button" onClick={() => setOpen(c.id)}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '6px 12px', alignItems: 'center', width: '100%', textAlign: 'left',
                    padding: '11px 12px', minHeight: 44, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{c.name}</span>
                    <span style={{ display: 'block', ...muted, fontSize: 12 }}>
                      {`${c.counts?.complete || 0} of ${total} acknowledged`}
                      {c.counts?.ready ? ` · ${c.counts.ready} ready to share` : ''}
                      {c.counts?.overdue ? ` · ${c.counts.overdue} overdue` : ''}
                      {c.due ? ` · Due ${formatDate(c.due)}` : ''}
                    </span>
                  </span>
                  <StatusLabel label={CYCLE_STATUS[c.status]?.label || c.status} color={CYCLE_STATUS[c.status]?.color} size="sm" />
                  <span style={{ gridColumn: '1 / -1' }}><ProgressBar value={total ? Math.round(((c.counts?.complete || 0) / total) * 100) : 0} label={`${c.name} acknowledged`} /></span>
                </button>
              );
            })}
          </div>
        )}
      {form && <CycleFormModal companies={companies} company={company} onClose={() => setForm(false)} toastErr={toastErr}
        onSaved={(c) => { setForm(false); load(); setOpen(c.id); toastOk?.(`Started - ${c.counts?.total || 0} people are in it, and they have been told.`); }} />}
      {open && <CycleModal cycleId={open} onClose={() => setOpen('')} onChanged={load} toastOk={toastOk} toastErr={toastErr} />}
    </section>
  );
}
