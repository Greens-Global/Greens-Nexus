import { useEffect, useMemo, useState } from 'react';
import { MessageCircleQuestion, Plus, Search, Settings, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime } from '../../lib/datetime';
import Amount from './Amount';
import { CustomizeButton, DENSITIES, EntityPicker, ExportMenu, OpFilter, Pager, control } from './reportControls';
import { useCustomizePrefs, usePaged } from './tableHooks';
import { Chip } from './LoanSetupDialog';
import { Dialog } from './LoanDialogs';
import { notAvailable } from './LoansTab';
import { downloadBlob, iso, numberFilterHit } from './reportModel';
import { linesFile } from './linesExport';
import EntryDetail from './EntryDetail';
import { takePendingOpen } from '../../lib/pendingOpen';
import AskAccountantDialog, { LineFacts, PersonSelect, amountText, usePeople } from './AskAccountantDialog';

// Accounting -> Reporting -> AMA, Ask My Accountant (Neil, 10/15: "AMA means
// Ask My Accountant"; the agreements screen first built under the name is
// Management Fees now).
//   - Every line on the Ask My Accountant (suspense) account(s) in the period
//     shows here by itself, Open until someone asks about it and it is
//     answered or resolved. Questions asked on any other ledger line (Ledger
//     Search, a report's drill-down, the journal entry) show here too.
//   - Open / Answered / Resolved / All with their counts, an entity, the
//     period, a filter box; Assigned To Me / Asked By Me.
//   - A row opens the side panel: the line, a link to its entry, the thread
//     and a reply box; Resolve (with Moved To Account) and Reopen.
//   - A question whose line has left the AMA account in the ledger shows
//     Reclassed and resolves in one click.
//   - Editors keep the settings: which accounts are the AMA accounts (or
//     find them by title) and the accountants per entity.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const muted = { color: 'var(--text-muted)' };
const fieldLabel = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const ellipsis = { maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const dash = <span style={muted}>-</span>;

export const STATUS_FILTERS = ['Open', 'Answered', 'Resolved', 'All'];
const TONE = { Open: 'wait', Answered: 'brand', Resolved: 'ok' };

const yearAgo = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return iso(d); };
const person = (name, email) => name || email || '';
const statusText = (r) => (r.reclassed && r.status !== 'Resolved' ? `${r.status} (Reclassed)` : r.status || '');

/** What a line says: the ledger LINE memo first (Priyanka, 10/15 - Intacct's
 *  AMA report shows "Charge Card Transaction - GG - Amex - 1009: ... AMAZON
 *  MARKETPLACE", not the batch title "Credit card transactions(...): Batch
 *  Summary Entry"), else the entry's description. */
export const lineText = (r) => r.memo || r.description || '';

// The grid's columns (Oct 22): each with its text for the cell, the filter
// box under its header (Neil: "a search box at the top of every column,
// critical") and the export. `num` columns filter with =, >, <, >=, <=,
// Between (OpFilter, as in Ledger Search).
export const GRID_COLUMNS = [
  { key: 'date', label: 'Date', text: (r) => (r.date ? formatDate(r.date) : ''), placeholder: 'MM/DD/YYYY' },
  { key: 'entity', label: 'Entity', text: (r) => r.entityCode || '' },
  { key: 'entry', label: 'Entry', text: (r) => r.entryNo || '' },
  { key: 'account', label: 'Account', text: (r) => `${r.accountNo || ''} ${r.accountTitle || ''}`.trim(), width: 200 },
  { key: 'description', label: 'Description', text: lineText, width: 280 },
  { key: 'department', label: 'Department', text: (r) => r.department || '', width: 150 },
  { key: 'vendor', label: 'Vendor', text: (r) => r.vendor || '', width: 170 },
  { key: 'custom', label: 'Custom', text: (r) => r.custom || '', width: 150 },
  { key: 'amount', label: 'Amount', num: true, text: (r) => Number(r.amount) || 0 },
  { key: 'question', label: 'Question', text: (r) => r.question || '', width: 240 },
  { key: 'askedBy', label: 'Asked By', text: (r) => person(r.askedByName, r.askedBy) },
  { key: 'accountant', label: 'Accountant', text: (r) => person(r.accountantName, r.accountant) },
  { key: 'status', label: 'Status', text: statusText },
  { key: 'lastReply', label: 'Last Reply', text: (r) => (r.lastReplyAt ? formatDateTime(r.lastReplyAt) : '') },
];
export const COLUMNS = GRID_COLUMNS.map((c) => c.label);

/** The rows a status, a "mine" choice and the filter box let through. */
export function visibleRows(rows, { status = 'Open', mine = 'all', me = '', text = '' } = {}) {
  const q = text.trim().toLowerCase();
  return (rows || []).filter((r) => (status === 'All' || r.status === status)
    && (mine === 'all' || (mine === 'assigned' ? r.accountant === me : r.askedBy === me))
    && (!q || [r.entityCode, r.entryNo, r.accountNo, r.accountTitle, r.description, r.memo, r.party, r.department, r.vendor, r.custom, r.question, r.askedByName, r.askedBy, r.accountantName, r.accountant, String(r.amount)]
      .some((v) => String(v || '').toLowerCase().includes(q))));
}

const opSet = (f) => !!f && typeof f === 'object' && !!(String(f.a ?? '').trim() || String(f.b ?? '').trim());
const textSet = (v) => typeof v === 'string' && !!v.trim();
/** Whether any column filter is typed. */
export const columnFiltering = (typed) => GRID_COLUMNS.some((c) => (c.num ? opSet(typed?.[c.key]) : textSet(typed?.[c.key])));

/** The rows every typed column filter lets through: a text column holds the
 *  words typed (each must appear, any case), an amount column compares. They
 *  stack. */
export function columnFilter(rows, typed = {}) {
  const active = GRID_COLUMNS.filter((c) => (c.num ? opSet(typed[c.key]) : textSet(typed[c.key])));
  if (!active.length) return rows || [];
  return (rows || []).filter((r) => active.every((c) => {
    if (c.num) return numberFilterHit(c.text(r), typed[c.key]);
    const hay = String(c.text(r) || '').toLowerCase();
    return typed[c.key].trim().toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }));
}

/** The grid as an export table (linesExport): the line memo as Description,
 *  with Department, Vendor and Custom beside it, as Intacct's AMA report. */
export function exportTable(rows, { from, to }) {
  return {
    title: 'Ask My Accountant',
    period: `${formatDate(from)} - ${formatDate(to)}`.replace(/\//g, '-'),
    subtitle: `${rows.length} ${rows.length === 1 ? 'line' : 'lines'} · ${formatDate(from)} - ${formatDate(to)}`,
    columns: GRID_COLUMNS.map((c) => ({ label: c.label, num: !!c.num, width: c.key === 'question' || c.key === 'description' ? 260 : 120 })),
    rows: rows.map((r) => GRID_COLUMNS.map((c) => c.text(r))),
    totals: null,
  };
}

function StatusChips({ r }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <Chip tone={TONE[r.status] || 'muted'}>{r.status}</Chip>
      {r.reclassed && r.status !== 'Resolved' && <Chip tone="muted" title="This line is no longer on the AMA account in the ledger">Reclassed</Chip>}
    </span>
  );
}

// ── The side panel: the line, the thread, a reply ───────────────────────────
export function ThreadPanel({ row, me, canEdit, onClose, onChanged, onAsk }) {
  const isThread = row.kind === 'thread';
  const [thread, setThread] = useState(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [moved, setMoved] = useState('');
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState('');
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    if (!isThread) return undefined;
    // The panel is keyed by the row, so a new row starts it afresh.
    let alive = true;
    api.getAskThread(row.id).then((t) => { if (alive) setThread(t); }).catch((e) => { if (alive) setError(e?.message || 'Could not open the question.'); });
    return () => { alive = false; };
  }, [row.id, isThread]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !entry) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, entry]);

  const t = thread || row;
  const canClose = canEdit || me === t.askedBy || me === t.accountant;
  const act = (key, call) => {
    setBusy(key);
    setError('');
    return call().then((next) => { setThread(next); onChanged?.(next); return next; })
      .catch((e) => { setError(e?.message || 'Could not save.'); })
      .finally(() => setBusy(''));
  };
  const send = (e) => {
    e.preventDefault();
    if (!reply.trim()) return;
    act('reply', () => api.replyAskThread(t.id, reply.trim())).then((next) => { if (next) setReply(''); });
  };
  const resolve = (movedTo = moved) => act('resolve', () => api.resolveAskThread(t.id, { movedToAccount: movedTo.trim() })).then((next) => { if (next) setResolving(false); });

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose} style={{ justifyContent: 'flex-end', alignItems: 'stretch', padding: 0 }}>
      <aside role="dialog" aria-modal="true" aria-label="Ask My Accountant Question" onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(480px, 100vw)', height: '100vh', background: 'var(--bg-card)', borderLeft: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.18))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-color)' }}>
          <MessageCircleQuestion size={16} style={{ color: 'var(--wk-brand, #2b45e1)' }} />
          <h3 style={{ margin: 0, fontSize: '0.98rem', flex: 1 }}>{isThread ? 'Question' : 'Ask My Accountant Line'}</h3>
          <StatusChips r={t} />
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'grid', gap: 12, alignContent: 'start' }}>
          {error && <div role="alert" style={bad}>{error}</div>}
          <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-secondary)' }}>
            <LineFacts line={{ ...t, entityName: t.entityName || '' }} />
            {t.entryId && (
              <button type="button" className="acct-drill" onClick={() => setEntry({ id: t.entryId, no: t.entryNo })} style={{ marginTop: 6, fontSize: '0.78rem' }}>
                Open the Journal Entry
              </button>
            )}
          </div>
          {t.reclassed && t.status !== 'Resolved' && (
            <div role="note" style={{ ...card, padding: '8px 10px', fontSize: '0.8rem', display: 'flex', gap: 8, alignItems: 'center', boxShadow: 'none' }}>
              <span style={{ flex: 1 }}>This line is no longer on the Ask My Accountant account in the ledger - it was reclassed in Intacct.</span>
              {isThread && canClose && (
                <button type="button" className="primary-btn" disabled={!!busy} onClick={() => resolve('')} style={{ fontSize: '0.76rem', height: 28, padding: '0 10px' }}>Resolve</button>
              )}
            </div>
          )}
          {!isThread ? (
            <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', display: 'grid', gap: 8 }}>
              <span>This line is parked on the Ask My Accountant account and nobody has asked about it yet.</span>
              <button type="button" className="primary-btn" onClick={() => onAsk(row)} style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
                <MessageCircleQuestion size={14} /> Ask My Accountant
              </button>
            </div>
          ) : !thread && !error ? (
            <div className="nx-skel" style={{ height: 80, borderRadius: 8 }} aria-label="Loading the question" />
          ) : thread && (
            <>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                Asked by <strong>{person(thread.askedByName, thread.askedBy)}</strong> · Accountant <strong>{person(thread.accountantName, thread.accountant)}</strong>
                {thread.movedToAccount ? <> · Moved To Account <strong>{thread.movedToAccount}</strong></> : null}
              </div>
              <ol aria-label="Thread" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {(thread.messages || []).map((m) => (
                  <li key={m.id} style={m.kind === 'event'
                    ? { fontSize: '0.74rem', color: 'var(--text-muted)', textAlign: 'center' }
                    : { border: '1px solid var(--border-color)', borderRadius: 10, padding: '8px 10px', background: m.author === thread.accountant ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                    {m.kind === 'event' ? (
                      <span>{person(m.authorName, m.author)} - {m.body} · {formatDateTime(m.at)}</span>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 8, fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 3 }}>
                          <strong style={{ color: 'var(--text-primary)' }}>{person(m.authorName, m.author)}</strong>
                          {m.kind === 'question' && <span>asked</span>}
                          <span style={{ marginLeft: 'auto' }}>{formatDateTime(m.at)}</span>
                        </div>
                        <div style={{ fontSize: '0.84rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        {isThread && thread && (
          <div style={{ borderTop: '1px solid var(--border-color)', padding: '10px 16px', display: 'grid', gap: 8 }}>
            <form onSubmit={send} style={{ display: 'grid', gap: 6 }}>
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={4000} aria-label="Reply"
                placeholder={me === thread.accountant ? 'Answer the question...' : 'Write a reply...'}
                style={{ ...control, width: '100%', height: 'auto', resize: 'vertical', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="submit" className="primary-btn" disabled={!reply.trim() || !!busy} style={{ fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
                  {busy === 'reply' ? 'Sending...' : 'Reply'}
                </button>
                {canClose && thread.status !== 'Resolved' && !resolving && (
                  <button type="button" className="secondary-btn" onClick={() => setResolving(true)} style={{ fontSize: '0.78rem', height: 30, padding: '0 12px' }}>Resolve</button>
                )}
                {canClose && thread.status === 'Resolved' && (
                  <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => act('reopen', () => api.reopenAskThread(thread.id))} style={{ fontSize: '0.78rem', height: 30, padding: '0 12px' }}>Reopen</button>
                )}
              </div>
            </form>
            {resolving && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <label style={fieldLabel} htmlFor="ask-moved">Moved To Account</label>
                  <input id="ask-moved" type="text" value={moved} maxLength={40} onChange={(e) => setMoved(e.target.value)} placeholder="Optional, e.g. 61000" style={{ ...control, width: '100%' }} />
                </div>
                <button type="button" className="primary-btn" disabled={!!busy} onClick={() => resolve()} style={{ fontSize: '0.78rem', height: 30, padding: '0 12px' }}>{busy === 'resolve' ? 'Saving...' : 'Mark Resolved'}</button>
                <button type="button" className="secondary-btn" onClick={() => setResolving(false)} style={{ fontSize: '0.78rem', height: 30, padding: '0 12px' }}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </aside>
      {/* Its own clicks stay inside it: the panel behind must not close. */}
      {entry && <div onClick={(e) => e.stopPropagation()} role="presentation"><EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} /></div>}
    </div>
  );
}

// ── Settings (editors): the AMA accounts and the accountants ───────────────
export function SettingsDialog({ settings, entities, limited, onClose, onSaved }) {
  const people = usePeople();
  const [chart, setChart] = useState(null);
  const [auto, setAuto] = useState(!settings?.configured?.length);
  const [picked, setPicked] = useState(() => new Set(settings?.configured || []));
  // A person limited to certain entities edits only those entities' accountants;
  // the Every Entity ('') default is shown, read-only, and never sent back
  // (Neil's review, Oct 20: re-sending it locked them out of saving at all).
  const mine = (entity) => !limited || entity !== '';
  const [rows, setRows] = useState(() => Object.entries(settings?.accountants || {}).filter(([entity]) => mine(entity)).flatMap(([entity, list]) => list.map((p) => ({ entity, email: p.email }))));
  const everyEntity = limited ? (settings?.accountants?.[''] || []) : [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
    if (limited) return undefined;
    let alive = true;
    api.getAskChart().then((c) => { if (alive) setChart(c?.accounts || []); }).catch((e) => { if (alive) { setChart([]); setError(e?.message || 'Could not read the chart of accounts.'); } });
    return () => { alive = false; };
  }, [limited]);
  const shown = (chart || []).filter((a) => !text.trim() || `${a.code} ${a.title}`.toLowerCase().includes(text.trim().toLowerCase()));

  const save = (e) => {
    e.preventDefault();
    const accountants = {};
    rows.filter((r) => r.email && mine(r.entity)).forEach((r) => { (accountants[r.entity] ||= []).push(r.email); });
    Object.keys(settings?.accountants || {}).filter(mine).forEach((k) => { accountants[k] ||= []; });
    if (!auto && !picked.size) { setError('Pick at least one account, or find them by title.'); return; }
    setBusy(true);
    setError('');
    api.saveAskSettings({ ...(limited ? {} : { accounts: auto ? [] : [...picked] }), accountants })
      .then(onSaved).catch((err) => { setError(err?.message || 'Could not save the settings.'); setBusy(false); });
  };

  return (
    <Dialog title="AMA Settings" onClose={onClose} onSubmit={save} busy={busy} submitLabel="Save" error={error} width={680}
      sub="Which accounts hold the Ask My Accountant lines, and who answers the questions.">
      {!limited && (
        <div>
          <span style={fieldLabel}>Ask My Accountant Accounts</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', marginBottom: 6 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Find them by title ("Ask My Accountant", "Ask Accountant", "Suspense")
          </label>
          {!auto && (
            <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 8 }}>
              <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter accounts" aria-label="Filter accounts" style={{ ...control, width: '100%', marginBottom: 6 }} />
              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 2 }}>
                {chart === null ? <div className="nx-skel" style={{ height: 60 }} /> : shown.map((a) => (
                  <label key={a.code} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem' }}>
                    <input type="checkbox" checked={picked.has(a.code)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(a.code); else n.delete(a.code); return n; })} />
                    <span className="acct-code">{a.code}</span>{a.title}{a.detected && <Chip tone="brand">Found By Title</Chip>}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div>
        <span style={fieldLabel}>Accountants</span>
        <div style={{ display: 'grid', gap: 6 }}>
          {everyEntity.length > 0 && (
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              Every Entity: {everyEntity.map((p) => p.name || p.email).join(', ')} - set by someone with access to every entity.
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
              <EntityPicker entities={entities} value={r.entity} onChange={(code) => setRows((x) => x.map((y, j) => (j === i ? { ...y, entity: code } : y)))}
                noneLabel={limited ? '' : 'Every Entity'} ariaLabel={`Entity ${i + 1}`} active={false} style={{ ...control, width: '100%', maxWidth: 'none' }} />
              <PersonSelect people={people} value={r.email} onChange={(v) => setRows((x) => x.map((y, j) => (j === i ? { ...y, email: v } : y)))} ariaLabel={`Accountant ${i + 1}`} />
              <button type="button" className="icon-btn" aria-label={`Remove accountant ${i + 1}`} onClick={() => setRows((x) => x.filter((_y, j) => j !== i))} style={{ padding: 4, color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="secondary-btn" onClick={() => setRows((x) => [...x, { entity: limited ? (entities[0]?.code || '') : '', email: '' }])}
            style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', height: 28, padding: '0 10px' }}>
            <Plus size={13} /> Add Accountant
          </button>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>A question goes to the first accountant of its entity, else the first for every entity, else the last one the asker picked.</div>
        </div>
      </div>
    </Dialog>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────
// The column filter row under the headers (Oct 22), styled like Ledger Search's.
const GRID_CSS = `.acct-ask tbody > tr > td { padding-top: var(--ask-py, 5px); padding-bottom: var(--ask-py, 5px); } .acct-ask tbody > tr { cursor: pointer; }
.acct-ask .acct-filter-row td { padding: 3px 4px 4px; background: var(--bg-card); border-bottom: 1px solid var(--border-color); }
.acct-ask .acct-filter-row input, .acct-ask .acct-filter-row select { width: 100%; min-width: 0; box-sizing: border-box; height: 24px; padding: 0 6px; border: 1px solid var(--border-color); border-radius: 6px; font: inherit; font-size: 12px; background: var(--bg-card); color: var(--text-primary); }
.acct-ask .acct-filter-row input::placeholder { color: var(--text-muted); opacity: .7; }
.acct-ask .acct-filter-row input:not(:placeholder-shown) { border-color: var(--wk-brand, #2b45e1); background: var(--wk-brand-tint, #e8ecfd); }
.acct-ask .acct-op-filter { display: flex; gap: 3px; align-items: center; min-width: 150px; }
.acct-ask .acct-op-filter select { width: auto; flex: 0 0 auto; padding: 0 2px; }
.acct-ask .acct-op-filter input { flex: 1 1 auto; min-width: 48px; text-align: right; }`;

export default function AskAccountantTab({ canEdit = false, limited = false }) {
  const custom = useCustomizePrefs(['density', 'pageSize', 'historicalEntities']);
  const py = DENSITIES.find((x) => x.key === custom.density)?.py || '5px';
  const [entities, setEntities] = useState([]);
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState(yearAgo);
  const [to, setTo] = useState(() => iso(new Date()));
  const [status, setStatus] = useState('Open');
  const [mine, setMine] = useState('all');
  const [text, setText] = useState('');
  const [typed, setTyped] = useState({});        // the column filters (Oct 22)
  const [reloads, setReloads] = useState(0);
  const [res, setRes] = useState({ key: null, data: null, error: null });
  // The row in the side panel. The bell's "Open AMA" names a question
  // (Priyanka, 10/15): it opens here whether or not its line is in the period.
  const [open, setOpen] = useState(() => {
    const id = takePendingOpen('amaThread');
    return id ? { id, kind: 'thread', status: '' } : null;
  });
  const [asking, setAsking] = useState(null);   // the line in the Ask dialog
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.getAccountingLocations?.().then((x) => setEntities(x?.entities || [])).catch(() => setEntities([]));
  }, []);
  useEffect(() => {
    const onOpen = (e) => { const id = e.detail?.id; if (id) { takePendingOpen('amaThread'); setOpen({ id, kind: 'thread', status: '' }); } };
    window.addEventListener('nexus:open-ama-thread', onOpen);
    return () => window.removeEventListener('nexus:open-ama-thread', onOpen);
  }, []);
  const key = JSON.stringify([entity, from, to, reloads]);
  useEffect(() => {
    let alive = true;
    api.getAskItems({ entity, from, to })
      .then((d) => { if (alive) setRes({ key, data: d, error: null }); })
      .catch((e) => { if (alive) setRes({ key, data: null, error: e }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const load = () => setReloads((n) => n + 1);
  const loading = res.key !== key;
  const data = res.data;
  const error = loading ? null : res.error;
  const me = data?.me || '';
  const all = useMemo(() => data?.rows || [], [data]);
  // Whose, the filter box and the column filters narrow the rows; the status
  // tabs count what they leave, so a count is always what its tab shows.
  const narrowed = useMemo(() => columnFilter(visibleRows(all, { status: 'All', mine, me, text }), typed), [all, mine, me, text, typed]);
  const rows = useMemo(() => narrowed.filter((r) => status === 'All' || r.status === status).sort((a, b) => String(b.date).localeCompare(String(a.date))), [narrowed, status]);
  const paged = usePaged(rows, custom.pageSize, [status, mine, text, entity, from, to, typed]);
  const counts = useMemo(() => {
    if (!data) return {};
    const c = Object.fromEntries(STATUS_FILTERS.map((st) => [st, 0]));
    narrowed.forEach((r) => { if (r.status in c) c[r.status] += 1; c.All += 1; });
    return c;
  }, [data, narrowed]);
  const filtering = columnFiltering(typed);
  const outside = data?.outside?.count ? data.outside : null;
  const editor = canEdit || !!data?.canEdit;
  const accountsText = (data?.accounts || []).map((a) => `${a.code}${a.title ? ` ${a.title}` : ''}`).join(', ');

  const exportAs = async (format) => {
    setBusy(format);
    try {
      const file = await linesFile(exportTable(rows, { from, to }), format);
      downloadBlob(file.name, file);
    } finally {
      setBusy('');
    }
  };
  const openSettings = () => api.getAskSettings().then(setSettings).catch(() => setSettings({}));
  const setFilter = (k, v) => setTyped((t) => ({ ...t, [k]: v }));

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <style>{GRID_CSS}</style>
      <div>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Ask My Accountant</h3>
        <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Lines parked on the Ask My Accountant account, and questions asked on any ledger line, until the accountant says where they belong.
        </p>
      </div>

      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div role="tablist" aria-label="Status" className="scroll-tabs" style={{ display: 'inline-flex', gap: 4 }}>
          {STATUS_FILTERS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)} className={status === s ? 'primary-btn' : 'secondary-btn'}
              style={{ fontSize: '0.76rem', height: 28, padding: '0 10px', whiteSpace: 'nowrap' }}>
              {s} <span style={{ opacity: 0.8 }}>{counts[s] ?? (loading ? '' : 0)}</span>
            </button>
          ))}
        </div>
        <EntityPicker entities={entities} value={entity} onChange={setEntity} noneLabel={limited ? 'My Entities' : 'All Entities'} showHistorical={custom.showHistorical} ariaLabel="Entity" />
        <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" title="Lines dated from" style={control} />
        <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" title="Lines dated to" style={control} />
        <select value={mine} onChange={(e) => setMine(e.target.value)} aria-label="Whose" style={control}>
          <option value="all">Everyone</option>
          <option value="assigned">Assigned To Me</option>
          <option value="asked">Asked By Me</option>
        </select>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter questions" aria-label="Filter questions" style={{ ...control, width: 180, paddingLeft: 24 }} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <CustomizeButton {...custom} />
          {editor && (
            <button type="button" className="secondary-btn" onClick={openSettings} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}>
              <Settings size={14} /> Settings
            </button>
          )}
          <ExportMenu disabled={!rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The lines on screen, amounts as numbers', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
          ]} />
        </div>
      </div>

      {data && (
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          {accountsText ? `AMA ${data.accounts.length === 1 ? 'account' : 'accounts'}: ${accountsText}${data.autoDetected ? ' (found by title)' : ''}` : 'No Ask My Accountant account was found on the ledger - questions asked on ledger lines still show here.'}
          {data.ledgerError && <span style={{ color: 'var(--bad-fg, #dc2626)' }}> · The ledger could not be read: {data.ledgerError}</span>}
        </div>
      )}
      {outside && (
        <div role="note" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span>
            {outside.count.toLocaleString('en-US')} {outside.count === 1 ? 'question is' : 'questions are'} on lines dated outside {formatDate(from)} - {formatDate(to)}
            {outside.open ? ` (${outside.open.toLocaleString('en-US')} not resolved)` : ''}.
          </span>
          <button type="button" className="acct-drill" style={{ fontSize: '0.76rem' }}
            onClick={() => { if (outside.earliest && outside.earliest < from) setFrom(outside.earliest); if (outside.latest && outside.latest > to) setTo(outside.latest); }}>
            Include Them
          </button>
        </div>
      )}

      {error && (notAvailable(error) ? (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Ask My Accountant is not available here.</strong> The accounting service is not connected on this environment.
        </div>
      ) : (
        <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1 }}>{error.message || 'Could not read the questions.'}</span>
          <button type="button" className="secondary-btn" onClick={load} style={{ fontSize: '0.76rem' }}>Try Again</button>
        </div>
      ))}

      {filtering && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          <span>Column filters on - {rows.length.toLocaleString('en-US')} {rows.length === 1 ? 'line matches' : 'lines match'}.</span>
          <button type="button" onClick={() => setTyped({})} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>Clear Column Filters</button>
        </div>
      )}

      {!error && !loading && !all.length && (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          Nothing to ask about in this period. Use the question mark on any line in Ledger Search or a journal entry to ask your accountant.
        </div>
      )}

      {!error && (loading || all.length > 0) && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }} aria-busy={loading}>
          <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="req-table acct-ask" style={{ fontVariantNumeric: 'tabular-nums', '--ask-py': py }}>
              <thead>
                <tr>{GRID_COLUMNS.map((c) => <th key={c.key} style={c.num ? num : undefined}>{c.label}</th>)}</tr>
                <tr className="acct-filter-row">
                  {GRID_COLUMNS.map((c) => (
                    <td key={c.key} style={c.width ? { minWidth: Math.min(c.width, 180) } : undefined}>
                      {c.num
                        ? <OpFilter label={c.label} value={typed[c.key]} onChange={(v) => setFilter(c.key, v)} />
                        : <input type="text" value={typed[c.key] || ''} onChange={(e) => setFilter(c.key, e.target.value)} aria-label={`Filter ${c.label}`} placeholder={c.placeholder || 'contains'} />}
                    </td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && !data ? Array.from({ length: 5 }, (_x, i) => (
                  <tr key={`sk${i}`} aria-hidden="true">{GRID_COLUMNS.map((c) => <td key={c.key}><div className="nx-skel" style={{ height: 12, borderRadius: 4, width: '70%' }} /></td>)}</tr>
                )) : !rows.length ? (
                  <tr><td colSpan={GRID_COLUMNS.length} style={{ padding: 18, textAlign: 'center', color: 'var(--text-secondary)', cursor: 'default' }}>Nothing here matches - try another status or clear the filters.</td></tr>
                ) : paged.rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }} aria-label={`Open ${r.entryNo || r.accountNo} ${amountText(r)}`}
                    style={loading ? { opacity: 0.6 } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.date ? formatDate(r.date) : dash}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.entityCode || dash}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.entryNo || dash}</td>
                    <td style={ellipsis} title={`${r.accountNo} ${r.accountTitle}`}><span className="acct-code">{r.accountNo}</span>{r.accountTitle}</td>
                    <td style={ellipsis} title={[lineText(r), r.memo && r.description && r.description !== r.memo ? `Entry: ${r.description}` : ''].filter(Boolean).join('\n')}>{lineText(r) || dash}</td>
                    <td style={ellipsis} title={r.department || undefined}>{r.department || dash}</td>
                    <td style={ellipsis} title={r.vendor || undefined}>{r.vendor || dash}</td>
                    <td style={ellipsis} title={r.custom || undefined}>{r.custom || dash}</td>
                    <td style={num}><Amount value={r.amount} /></td>
                    <td style={ellipsis} title={r.question}>{r.question || <span style={muted}>Not Asked Yet</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{person(r.askedByName, r.askedBy) || dash}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{person(r.accountantName, r.accountant) || dash}</td>
                    <td><StatusChips r={r} /></td>
                    <td style={{ whiteSpace: 'nowrap' }} title={r.lastReplyByName || r.lastReplyBy || undefined}>{r.lastReplyAt ? formatDateTime(r.lastReplyAt) : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && <Pager {...paged} style={{ borderTop: '1px solid var(--border-color)' }} />}
        </div>
      )}

      {open && <ThreadPanel key={open.id} row={open} me={me} canEdit={editor} onClose={() => setOpen(null)} onChanged={load} onAsk={(r) => setAsking(r)} />}
      {asking && (
        <AskAccountantDialog line={asking} onClose={() => setAsking(null)}
          onAsked={(t) => { setAsking(null); setOpen({ ...t, kind: 'thread' }); load(); }} />
      )}
      {settings && (
        <SettingsDialog settings={settings} entities={entities} limited={limited} onClose={() => setSettings(null)}
          onSaved={() => { setSettings(null); load(); }} />
      )}
    </div>
  );
}
