// Revenue Management: one tenant's rents (Oct 28 2026 call with Neil, B16).
// Opened from any tenant in ECRI Management. Every rate they have had with
// the day it changed (Hummingbird before the Cubby cutover, the rent changes
// Nexus put in Cubby, today's rent from Cubby), the current rate, whether
// each strategy would raise them now, any change still to come, the notes
// Cubby's staff wrote on the lease, and Nexus's own comments log - kept so
// the ECRI rules can read them later ("can't handle an increase").
// Server: routers/ops_revenue.py tenant-history / tenant-comments.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { useRole } from '../contexts/RoleContext';
import { formatDate, formatDateTime } from '../lib/datetime';
import { money } from './model';
import OpsGrid from './OpsGrid';

const cash = (c) => (c === null || c === undefined ? '-' : money(c, { exact: true }));
const signed = (c) => (c === null || c === undefined ? '' : `${c > 0 ? '+' : c < 0 ? '-' : ''}${cash(Math.abs(c))}`);
function stayWords(months) {
  if (months == null) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} ${y === 1 ? 'year' : 'years'}` : '', m || !y ? `${m} ${m === 1 ? 'month' : 'months'}` : ''].filter(Boolean).join(' ');
}

const HISTORY_COLS = [
  { key: 'date', label: 'Date', type: 'date', value: (e) => e.date, cell: (e) => (e.date ? formatDate(e.date) : '-') },
  { key: 'kind', label: 'What', value: (e) => e.kind, cell: (e) => e.kind },
  { key: 'rent', label: 'Rate', type: 'money', value: (e) => e.rent, cell: (e) => <strong>{cash(e.rent)}</strong> },
  { key: 'change', label: 'Change', type: 'money', value: (e) => e.change,
    cell: (e) => (e.change == null ? '-' : `${signed(e.change)}${e.changePct != null ? ` (${e.changePct > 0 ? '+' : ''}${e.changePct}%)` : ''}`) },
  { key: 'source', label: 'From', value: (e) => e.source, cell: (e) => e.source },
  { key: 'note', label: 'Note', value: (e) => e.note || '', cell: (e) => e.note || '' },
];

export default function TenantHistory({ facilityId, tenantKey, name, onClose, zIndex = 4300 }) {
  const [state, setState] = useState({ status: 'loading' });
  const [text, setText] = useState('');
  const [hold, setHold] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const role = useRole();
  const me = (role?.myEmail || '').toLowerCase();

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await api.opsTenantHistory(facilityId, tenantKey) });
    } catch (e) {
      setState({ status: 'error', error: e?.message || "Couldn't load this tenant's rents." });
    }
  }, [facilityId, tenantKey]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const out = await api.addOpsTenantComment({ facility_id: facilityId, key: tenantKey, text: text.trim(), hold });
      setState((s) => ({ ...s, data: { ...s.data, comments: out.comments } }));
      setText(''); setHold(false);
    } catch (e) {
      setErr(e?.message || "Couldn't save the comment.");
    } finally { setBusy(false); }
  };

  const d = state.data;
  const t = d?.tenant;
  const under = t?.street ? Math.round(((t.rent - t.street) / t.street) * 1000) / 10 : null;

  return (
    <Modal title={t ? `${t.tenant} - ${t.unit}` : (name || 'Tenant')} onClose={onClose} minHeight="70vh" zIndex={zIndex}>
      {state.status === 'loading' && <LoadingState size="section" label="Reading the rents" minHeight={240} />}
      {state.status === 'error' && <ErrorBanner message={state.error} onRetry={load} />}
      {d && t && (
        <div className="ops-th-sheet">
          <p className="ops-headline">
            <span>Current rate</span> <strong>{cash(t.rent)}</strong>
            <span className="ops-headline-sep"> - </span><span>standard rate</span> <strong>{cash(t.street)}</strong>
            {under != null && (
              <><span className="ops-headline-sep"> - </span>
                <strong style={under < 0 ? { color: 'var(--bad-fg)' } : undefined}>{`${under > 0 ? '+' : ''}${under.toFixed(1)}%`}</strong> <span>{under < 0 ? 'under' : 'over'} it</span></>
            )}
            <span className="ops-headline-sep"> - </span><span>{t.unitType}, {d.facility}</span>
            {t.moveIn && <><span className="ops-headline-sep"> - </span><span>moved in {formatDate(t.moveIn)}{t.monthsStayed != null ? `, ${stayWords(t.monthsStayed)}` : ''}</span></>}
            {t.balance > 0 && <><span className="ops-headline-sep"> - </span><strong style={{ color: 'var(--bad-fg)' }}>{cash(t.balance)} {t.pastDue ? 'past due' : 'owed'}</strong></>}
          </p>

          <section className="ops-rc">
            <h3 className="ops-rc-title">Coming Up</h3>
            {!d.upcoming.length ? <p className="ops-rc-empty">No rent change is scheduled.</p> : (
              <ul className="ops-rc-list">
                {d.upcoming.map((u, i) => (
                  <li key={i} className="ops-rc-row">
                    <div className="ops-rc-main">
                      <span className="ops-rc-name is-plain">{u.kind}{u.rent != null ? `: ${cash(u.rent)}` : ''}{u.change != null ? ` (${signed(u.change)})` : ''}</span>
                      <div className="ops-rc-about">{u.date ? `From ${formatDate(u.date)}` : 'Date not set yet'} - {u.source}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="ops-rc">
            <h3 className="ops-rc-title">Eligible for an Increase?</h3>
            {!d.eligibility.length ? <p className="ops-rc-empty">No strategy is saved yet - add one under ECRI Management &gt; Strategies.</p> : (
              <ul className="ops-rc-list">
                {d.eligibility.map((e) => (
                  <li key={e.strategyId} className="ops-rc-row">
                    <div className="ops-rc-main">
                      <span className="ops-rc-name is-plain">{e.strategy}: <span style={{ color: e.eligible ? 'var(--ok-fg)' : 'var(--muted)' }}>{e.eligible ? 'Eligible' : 'Not Eligible'}</span></span>
                      <div className="ops-rc-about">
                        {e.eligible ? `${cash(e.newRent)} (${signed(e.increase)}) from ${formatDate(e.effective)}, the earliest its notice allows. ` : `${e.reasons.join('; ')}. `}
                        {e.summary}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="ops-rc">
            <h3 className="ops-rc-title">Rate History</h3>
            <OpsGrid tableKey="revenue:rate-history" title={`Rate History - ${t.tenant}`} where={d.facility} asOf={d.asOf}
              columns={HISTORY_COLS} rows={d.history} rowKey={(e) => `${e.date}:${e.rent}`} search={false} stack={false}
              empty="No rate history for this tenant." />
            <p className="ops-note" style={{ margin: '6px 0 0' }}>
              {d.fromHummingbird ? 'Before 09/15/2026 the rates come from Hummingbird, one figure per month. ' : 'No Hummingbird lease matches this tenant, so the history starts in Cubby. '}
              Since then, from Cubby and the rent changes Nexus put in Cubby.
            </p>
          </section>

          <section className="ops-rc">
            <h3 className="ops-rc-title">Comments</h3>
            <div className="ops-th-add">
              <textarea className="form-input" rows={2} maxLength={2000} value={text} placeholder="Add a note for whoever plans this tenant's next rent change"
                aria-label="New comment" onChange={(e) => setText(e.target.value)} />
              <div className="ops-th-add-row">
                <label className="ops-th-hold">
                  <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Hold rent increases for this tenant
                </label>
                <button type="button" className="primary-btn ops-btn-sm" onClick={add} disabled={busy || !text.trim()}>{busy ? 'Saving...' : 'Add Comment'}</button>
              </div>
              {err && <p className="ops-form-error" role="alert">{err}</p>}
            </div>
            {!d.comments.length ? <p className="ops-rc-empty">No comments yet.</p> : (
              <ul className="ops-rc-list">
                {d.comments.map((c) => (
                  <li key={c.id} className={`ops-rc-row${c.withdrawn ? ' is-withdrawn' : ''}`}>
                    <div className="ops-rc-main">
                      <div className="ops-th-text">{c.text}</div>
                      <div className="ops-rc-about">
                        {c.author}, {formatDateTime(c.createdAt)}{c.hold ? ' - holds rent increases' : ''}{c.withdrawn ? ` - taken back ${formatDate(c.withdrawnAt)}` : ''}
                      </div>
                    </div>
                    {!c.withdrawn && c.authorEmail === me && (
                      <div className="ops-rc-acts">
                        <HoldButton label="Take Back" size="sm" holdMs={HOLD_RECORD_MS} doneLabel="Taken Back" ariaLabel="Take back this comment"
                          onConfirm={async () => { await api.withdrawOpsTenantComment(c.id); await load(); }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="ops-rc">
            <h3 className="ops-rc-title">Notes in Cubby</h3>
            {d.cubbyNotesError ? <p className="ops-rc-empty" role="status">{d.cubbyNotesError}</p>
              : !d.cubbyNotes.length ? <p className="ops-rc-empty">Cubby has no notes on this lease.</p> : (
                <ul className="ops-rc-list">
                  {d.cubbyNotes.map((n, i) => (
                    <li key={i} className="ops-rc-row">
                      <div className="ops-rc-main">
                        <div className="ops-th-text">{n.text}</div>
                        <div className="ops-rc-about">{[n.createdBy, n.createdAt ? formatDateTime(n.createdAt) : ''].filter(Boolean).join(', ')}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            <p className="ops-note" style={{ margin: '6px 0 0' }}>Read from Cubby each time this opens; Nexus does not keep a copy.{t.url ? ' ' : ''}
              {t.url && <a className="ops-link" href={t.url} target="_blank" rel="noopener noreferrer">Open in Cubby</a>}</p>
          </section>
        </div>
      )}
    </Modal>
  );
}
