import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Send, Undo2, X } from 'lucide-react';
import { api } from '../../api';
import { formatDateTime } from '../../lib/datetime';
import { formatAmount } from './Amount';
import { control } from './reportControls';
import { Chip } from './LoanSetupDialog';
import { downloadBlob } from './reportModel';
import { useBackdropClose } from './LoanDialogs';
import { LineFacts } from './AskAccountantDialog';
import { AMA_GL_PICKER_LIMIT, AMA_OFFSET_BATCH, AMA_OFFSET_DISPLAY } from './assumptions';

// AMA, change request 13 (Charmi, Oct 22 call):
//   - Other Side: the account(s) the money came from or went to, read from
//     the line's journal entry, on the first screen (no two clicks).
//   - Notes: typed in the grid, saved per line, seen by the bookkeeper.
//   - GL Reclass: pick the GL (and a vendor or customer); it waits for the
//     bookkeeper, who changes it, sends it back, or approves and pushes it.
//     Nobody else can push (34:42: "Neil should not be able to push").
// The defaults still to be confirmed are in ./assumptions.js.

const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const fieldLabel = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const small = { fontSize: '0.78rem', height: 30, padding: '0 12px' };

export const AWAITING = 'Awaiting Bookkeeper';
export const RECLASS_TONE = { [AWAITING]: 'wait', 'Sent Back': 'bad', Pushing: 'brand', Pushed: 'ok' };
const UUID = /^[0-9a-f-]{36}$/i;

/** What the reclass chip says: Pushed reads as where it went. */
export function reclassLabel(rv) {
  if (!rv?.status) return '';
  if (rv.status === 'Pushed') return rv.pushMode === 'intacct' ? 'Pushed To Intacct' : 'Approved For Import';
  return rv.status;
}

/** The line as the server keys it (Notes and the reclass). */
export function lineBody(r) {
  return {
    entityCode: r.entityCode || '', entryId: r.entryId || '', entryNo: r.entryNo || '', lineId: r.lineId || '',
    accountNo: r.accountNo || '', accountTitle: r.accountTitle || '', date: r.date || '', amount: Number(r.amount) || 0,
    description: r.memo || r.description || '',
    // A question's snapshot keeps "4100 Storage"; the bare code goes on the reclass entry.
    departmentId: r.departmentId || String(r.department || '').split(' ')[0] || '',
  };
}

/** The other side of one row from its entry's offsets: the accounts on the
 *  opposite side of the line (all of the entry's other accounts when none
 *  is), never the row's own account. {shown, all} - `shown` is the largest
 *  only or every one, per AMA_OFFSET_DISPLAY; null while unread; {error}. */
export function pickOffsets(row, entry, display = AMA_OFFSET_DISPLAY) {
  if (!entry) return null;
  if (entry.error) return { error: entry.error, shown: [], all: [] };
  const list = (entry.offsets || []).filter((o) => o.accountNo !== row.accountNo);
  const amt = Number(row.amount) || 0;
  const opposite = list.filter((o) => !amt || Math.sign(Number(o.amount) || 0) === -Math.sign(amt));
  const all = opposite.length ? opposite : list;
  return { shown: display === 'all' ? all : all.slice(0, 1), all, hidden: entry.hidden || 0 };
}

/** A row's Other Side from the offsets read so far (`map`: entry id ->
 *  answer). A row with no entry to read has none. */
export function sideFor(row, map) {
  if (!row.entryId || !UUID.test(row.entryId)) return { error: '', shown: [], all: [] };
  return pickOffsets(row, map?.[row.entryId]);
}

const acct = (o) =>`${o.accountNo}${o.accountTitle ? ` ${o.accountTitle}` : ''}`;

/** The Other Side as text (filters, export): every account on that side. */
export function otherSideText(side) {
  return side && !side.error ? side.all.map(acct).join('; ') : '';
}

const readOffsets = (ids) => {
  const batches = [];
  for (let i = 0; i < ids.length; i += AMA_OFFSET_BATCH) batches.push(ids.slice(i, i + AMA_OFFSET_BATCH));
  return Promise.all(batches.map((b) => api.getAskOffsets(b)
    .then((d) => ({ ...(d?.offsets || {}), ...Object.fromEntries(Object.entries(d?.errors || {}).map(([k, v]) => [k, { error: v }])) }))
    .catch((e) => Object.fromEntries(b.map((k) => [k, { error: e?.message || 'Could not read the entry.' }])))))
    .then((parts) => Object.assign({}, ...parts));
};

/** The entry ids of some rows that have an entry to read and are not in `map`. */
export const missingEntries = (rows, map) => [...new Set((rows || []).map((r) => r.entryId).filter((id) => id && UUID.test(id) && !(id in (map || {}))))];

/** Offsets per entry id: `load(rows)` reads the entries not read yet (the
 *  page on screen), `ensure(rows)` does the same and answers the whole map
 *  (the export). An entry read once is kept. */
export function useOffsets() {
  const [map, setMap] = useState({});
  const ensure = async (rows) => {
    const ids = missingEntries(rows, map);
    if (!ids.length) return map;
    const got = await readOffsets(ids);
    setMap((m) => ({ ...m, ...got }));
    return { ...map, ...got };
  };
  return { map, load: ensure, ensure };
}

/** The Other Side cell. */
export function OtherSideCell({ side }) {
  if (side === undefined || side === null) return <div className="nx-skel" style={{ height: 12, borderRadius: 4, width: 120 }} aria-label="Reading the other side" />;
  if (side.error || !side.all.length) return <span style={{ color: 'var(--text-muted)' }} title={side.error || 'No other account on this entry'}>-</span>;
  const more = side.all.length - side.shown.length;
  const tip = side.all.map((o) => `${acct(o)}  ${o.amount < 0 ? `(${formatAmount(-o.amount)})` : formatAmount(o.amount)}${o.entityCode ? `  ${o.entityCode}` : ''}`).join('\n');
  return (
    <span title={tip}>
      {side.shown.map((o, i) => <span key={`${o.accountNo}-${o.entityCode}`}>{i ? '; ' : ''}<span className="acct-code">{o.accountNo}</span>{o.accountTitle}</span>)}
      {more > 0 && <span style={{ color: 'var(--text-muted)' }}> +{more} more</span>}
    </span>
  );
}

/** Notes, typed in the grid; saved when the box loses focus or on Enter.
 *  Keyed by the row and its saved note, so a reload shows the stored text. */
export function NoteCell({ row, onSaved }) {
  const [v, setV] = useState(row.note || '');
  const [state, setState] = useState('');
  const save = () => {
    if (v.trim() === (row.note || '').trim()) return;
    setState('saving');
    api.saveAskNote({ ...lineBody(row), note: v.trim() })
      .then((rv) => { setState('saved'); onSaved?.(row, rv); })
      .catch((e) => setState(`error:${e?.message || 'Could not save the note.'}`));
  };
  const err = state.startsWith('error:') ? state.slice(6) : '';
  return (
    <input type="text" value={v} maxLength={4000} onChange={(e) => { setV(e.target.value); setState(''); }} onBlur={save}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      aria-label={`Notes for ${row.entryNo || row.accountNo || 'line'}`} placeholder="Add a note" title={err || v || undefined}
      style={{ ...control, height: 26, width: 180, fontSize: '0.78rem', ...(err ? { borderColor: 'var(--bad-fg, #dc2626)' } : {}), ...(state === 'saving' ? { opacity: 0.6 } : {}) }} />
  );
}

/** The GL Reclass cell: one click opens the picker. */
export function ReclassCell({ row, onOpen }) {
  const rv = row.reclass;
  return (
    <button type="button" className="acct-drill" onClick={(e) => { e.stopPropagation(); onOpen(row); }} onKeyDown={(e) => e.stopPropagation()}
      aria-label={rv ? `GL reclass ${rv.toAccount} ${reclassLabel(rv)}` : `Pick GL for ${row.entryNo || 'line'}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
      {rv ? <><span className="acct-code">{rv.toAccount}</span><Chip tone={RECLASS_TONE[rv.status] || 'muted'}>{reclassLabel(rv)}</Chip></> : 'Pick GL'}
    </button>
  );
}

let glCache = null;
function useGlAccounts() {
  const [state, setState] = useState(() => (glCache ? { accounts: glCache, error: '' } : null));
  useEffect(() => {
    if (glCache) return undefined;
    let alive = true;
    api.getAskGlAccounts().then((d) => { glCache = d?.accounts || []; if (alive) setState({ accounts: glCache, error: '' }); })
      .catch((e) => { if (alive) setState({ accounts: [], error: e?.message || 'Could not read the chart of accounts.' }); });
    return () => { alive = false; };
  }, []);
  return state;
}

/** Vendors or customers matching what is typed (Vendors & Customers' list). */
function usePartners(kind, q) {
  const [res, setRes] = useState({ key: '', list: [], error: '' });
  const key = `${kind}|${q.trim()}`;
  useEffect(() => {
    if (!kind) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      api.getAccountingPartners(kind, q.trim())
        .then((d) => { if (alive) setRes({ key, list: (d?.partners || []).slice(0, 40), error: '' }); })
        .catch((e) => { if (alive) setRes({ key, list: [], error: e?.message || 'Could not read the list.' }); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ...res, loading: !!kind && res.key !== key };
}

/** The vendor a line already carries ("V01812 Greens Global, Inc."). */
const vendorOf = (row) => {
  const m = /^(\S+)\s+(.*)$/.exec(String(row.vendor || '').trim());
  return m ? { id: m[1], name: m[2] } : null;
};

// ── The GL reclass dialog ───────────────────────────────────────────────────
export function ReclassDialog({ row, side, isBookkeeper, pushToIntacct, onClose, onSaved }) {
  const [rv, setRv] = useState(row.reclass || null);
  const status = rv?.status || '';
  const editable = !status || status === 'Sent Back' || (status === AWAITING && isBookkeeper);
  const seeded = vendorOf(row);
  const [to, setTo] = useState(rv ? { code: rv.toAccount, title: rv.toAccountTitle } : null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState(rv ? rv.partyKind : (seeded ? 'vendor' : ''));
  const [party, setParty] = useState(rv?.partyId ? { id: rv.partyId, name: rv.partyName } : seeded);
  const [pq, setPq] = useState('');
  const [memo, setMemo] = useState(rv?.reclassMemo || '');
  const [backNote, setBackNote] = useState('');
  const [sendingBack, setSendingBack] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const gl = useGlAccounts();
  const partners = usePartners(editable ? kind : '', pq);
  const backdrop = useBackdropClose(onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (gl?.accounts || []).filter((a) => !needle || `${a.code} ${a.title}`.toLowerCase().includes(needle)).slice(0, AMA_GL_PICKER_LIMIT), [gl, needle]);
  const dirty = !rv || !to || to.code !== rv.toAccount || (kind || '') !== (rv.partyKind || '') || (party?.id || '') !== (kind ? rv.partyId : '') || memo.trim() !== (rv.reclassMemo || '');

  const run = (key, call) => {
    setBusy(key);
    setError('');
    return call().then((next) => { setRv(next); onSaved?.(next); return next; })
      .catch((e) => { setError(e?.message || 'Could not save.'); return null; })
      .finally(() => setBusy(''));
  };
  const save = () => {
    if (!to) { setError('Pick the GL account.'); return Promise.resolve(null); }
    if (kind && !party?.id) { setError(`Pick the ${kind}, or set the counterparty to None.`); return Promise.resolve(null); }
    return run('save', () => api.proposeAskReclass({
      ...lineBody(row), toAccount: to.code, toAccountTitle: to.title || '', partyKind: kind, partyId: kind ? party.id : '',
      partyName: kind ? (party.name || '') : '', memo: memo.trim(),
    }));
  };
  const push = async () => {
    let cur = rv;
    if (dirty) cur = await save();
    if (!cur) return;
    run('push', () => api.pushAskReclass(cur.id));
  };
  const download = () => {
    setBusy('file');
    api.exportAskReclasses(rv.id).then((blob) => downloadBlob(`ama-reclass-${rv.reclassRef || rv.id}.csv`, blob))
      .catch((e) => setError(e?.message || 'Could not build the import file.')).finally(() => setBusy(''));
  };

  const body = (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal-content nx-popup" role="dialog" aria-modal="true" aria-label="GL Reclass" style={{ width: 'max(60vw, 420px)', maxWidth: '100vw', minHeight: '60vh', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>GL Reclass {status && <Chip tone={RECLASS_TONE[status] || 'muted'}>{reclassLabel(rv)}</Chip>}</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Pick where this line belongs. A bookkeeper reviews it and pushes a new reclass entry - the original entry is never changed.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {error && <div role="alert" style={bad}>{error}</div>}
          <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-secondary)' }}>
            <LineFacts line={{ ...row, entityName: row.entityName || '' }} />
            <div style={{ fontSize: '0.78rem', marginTop: 4 }}>
              <strong>Other Side: </strong>{side?.all?.length ? side.all.map((o) => `${acct(o)} ${o.amount < 0 ? `(${formatAmount(-o.amount)})` : formatAmount(o.amount)}`).join('; ') : '-'}
            </div>
            {row.note && <div style={{ fontSize: '0.78rem', marginTop: 4 }}><strong>Notes: </strong>{row.note}</div>}
          </div>
          {status === 'Sent Back' && rv.reviewNote && <div role="note" style={{ ...bad, color: 'var(--text-primary)' }}>Sent back: {rv.reviewNote}</div>}
          {rv?.pushError && status === AWAITING && <div role="alert" style={bad}>The last push failed: {rv.pushError}</div>}

          {editable ? (
            <>
              <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', minHeight: 160 }}>
                <label style={fieldLabel} htmlFor="ama-gl-search">GL Account {to && <span style={{ fontWeight: 400 }}>- picked <span className="acct-code">{to.code}</span>{to.title}</span>}</label>
                <input id="ama-gl-search" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts by number or name" style={{ ...control, width: '100%' }} />
                <div role="listbox" aria-label="GL accounts" style={{ flex: 1, minHeight: 100, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, marginTop: 4 }}>
                  {gl === null ? <div className="nx-skel" style={{ height: 60, margin: 8 }} />
                    : gl.error ? <div style={{ padding: 8, fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{gl.error}</div>
                      : !shown.length ? <div style={{ padding: 8, fontSize: '0.8rem', color: 'var(--text-muted)' }}>No account matches.</div>
                        : shown.map((a) => (
                          <div key={a.code} role="option" aria-selected={to?.code === a.code} tabIndex={0} onClick={() => setTo(a)} onKeyDown={(e) => { if (e.key === 'Enter') setTo(a); }}
                            style={{ padding: '4px 10px', fontSize: '0.8rem', cursor: 'pointer', background: to?.code === a.code ? 'var(--wk-brand-tint, #e8ecfd)' : undefined }}>
                            <span className="acct-code">{a.code}</span>{a.title}
                          </div>
                        ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 160px) minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
                <div>
                  <label style={fieldLabel} htmlFor="ama-party-kind">Counterparty</label>
                  <select id="ama-party-kind" value={kind} onChange={(e) => { setKind(e.target.value); setParty(null); setPq(''); }} style={{ ...control, width: '100%' }}>
                    <option value="">None</option>
                    <option value="vendor">Vendor</option>
                    <option value="customer">Customer</option>
                  </select>
                </div>
                {kind && (
                  <div>
                    <label style={fieldLabel} htmlFor="ama-party-search">{kind === 'vendor' ? 'Vendor' : 'Customer'} {party?.id && <span style={{ fontWeight: 400 }}>- picked <span className="acct-code">{party.id}</span>{party.name}</span>}</label>
                    <input id="ama-party-search" type="text" value={pq} onChange={(e) => setPq(e.target.value)} placeholder={`Search ${kind}s by number or name`} style={{ ...control, width: '100%' }} />
                    <div role="listbox" aria-label={kind === 'vendor' ? 'Vendors' : 'Customers'} style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, marginTop: 4 }}>
                      {partners.loading ? <div className="nx-skel" style={{ height: 30, margin: 6 }} />
                        : partners.error ? (
                          <div style={{ padding: 8, fontSize: '0.78rem', display: 'grid', gap: 6 }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{partners.error}</span>
                            {pq.trim() && <button type="button" className="secondary-btn" onClick={() => setParty({ id: pq.trim(), name: '' })} style={{ ...small, justifySelf: 'start' }}>Use {pq.trim()} As The ID</button>}
                          </div>
                        ) : !partners.list.length ? <div style={{ padding: 8, fontSize: '0.78rem', color: 'var(--text-muted)' }}>Nothing matches.</div>
                          : partners.list.map((p) => (
                            <div key={p.id} role="option" aria-selected={party?.id === p.id} tabIndex={0} onClick={() => setParty({ id: p.id, name: p.displayName || p.name })}
                              onKeyDown={(e) => { if (e.key === 'Enter') setParty({ id: p.id, name: p.displayName || p.name }); }}
                              style={{ padding: '4px 10px', fontSize: '0.8rem', cursor: 'pointer', background: party?.id === p.id ? 'var(--wk-brand-tint, #e8ecfd)' : undefined }}>
                              <span className="acct-code">{p.id}</span>{p.displayName || p.name}
                            </div>
                          ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label style={fieldLabel} htmlFor="ama-reclass-memo">Memo On The Reclass</label>
                <input id="ama-reclass-memo" type="text" value={memo} maxLength={1000} onChange={(e) => setMemo(e.target.value)} placeholder="Optional, e.g. Laborers paid in cash" style={{ ...control, width: '100%' }} />
              </div>
            </>
          ) : rv && (
            <div style={{ fontSize: '0.84rem', display: 'grid', gap: 4 }}>
              <div><strong>GL:</strong> <span className="acct-code">{rv.toAccount}</span>{rv.toAccountTitle}</div>
              {rv.partyKind && <div><strong>{rv.partyKind === 'vendor' ? 'Vendor' : 'Customer'}:</strong> {rv.partyId} {rv.partyName}</div>}
              {rv.reclassMemo && <div><strong>Memo:</strong> {rv.reclassMemo}</div>}
              {status === AWAITING && <div style={{ color: 'var(--text-secondary)' }}>This reclass is with the bookkeeper. Only a bookkeeper can change it or push it to Intacct.</div>}
            </div>
          )}

          {rv && (
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', display: 'grid', gap: 2 }}>
              <div>Proposed by <strong>{rv.proposedByName || rv.proposedBy}</strong>{rv.proposedAt ? ` · ${formatDateTime(rv.proposedAt)}` : ''} · Reference {rv.reclassRef}</div>
              {status === 'Pushed' && (
                <div>Approved by <strong>{rv.approvedByName || rv.approvedBy}</strong> · {formatDateTime(rv.approvedAt)}{rv.intacctRef ? ` · Intacct record ${rv.intacctRef}` : ''}</div>
              )}
              {(rv.history || []).length > 0 && (
                <ol aria-label="Reclass history" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {rv.history.map((h, i) => <li key={i}>{formatDateTime(h.at)} - {h.event}</li>)}
                </ol>
              )}
            </div>
          )}
          {sendingBack && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label style={fieldLabel} htmlFor="ama-back-note">Why It Goes Back</label>
                <input id="ama-back-note" type="text" value={backNote} maxLength={1000} onChange={(e) => setBackNote(e.target.value)} placeholder="e.g. This is rent income, not repairs" style={{ ...control, width: '100%' }} />
              </div>
              <button type="button" className="primary-btn" disabled={!!busy} onClick={() => run('back', () => api.sendBackAskReclass(rv.id, backNote.trim())).then((n) => { if (n) setSendingBack(false); })} style={small}>Send Back</button>
              <button type="button" className="secondary-btn" onClick={() => setSendingBack(false)} style={small}>Cancel</button>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', padding: '10px 24px 16px' }}>
          {isBookkeeper && status === 'Pushed' && (
            <button type="button" className="secondary-btn" disabled={!!busy} onClick={download} style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={13} /> {busy === 'file' ? 'Building...' : 'Intacct Import File'}</button>
          )}
          {isBookkeeper && status === AWAITING && !sendingBack && (
            <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => setSendingBack(true)} style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Undo2 size={13} /> Send Back</button>
          )}
          <button type="button" className="secondary-btn" onClick={onClose} style={small}>Close</button>
          {editable && (
            <button type="button" className={isBookkeeper ? 'secondary-btn' : 'primary-btn'} disabled={!!busy || !to || (!dirty && status === AWAITING)} onClick={save} style={small}>
              {busy === 'save' ? 'Saving...' : isBookkeeper && status === AWAITING ? 'Save Changes' : 'Send To Bookkeeper'}
            </button>
          )}
          {isBookkeeper && editable && (
            <button type="button" className="primary-btn" disabled={!!busy || !to} onClick={push} style={{ ...small, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title={pushToIntacct ? 'Creates a new reclass entry in Intacct' : 'Pushing straight to Intacct is switched off on this server - the reclass is recorded for the Intacct import file'}>
              <Send size={13} /> {busy === 'push' ? 'Pushing...' : pushToIntacct ? 'Approve & Push To Intacct' : 'Approve & Record For Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? body : createPortal(body, document.body);
}
