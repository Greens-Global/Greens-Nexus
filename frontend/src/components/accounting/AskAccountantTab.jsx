import { useEffect, useMemo, useState } from 'react';
import { MessageCircleQuestion, Plus, Send, Settings, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime } from '../../lib/datetime';
import Amount, { formatAmount } from './Amount';
import { BarMore, BarSearch, ControlBar, CustomizeButton, DENSITIES, EntityPicker, ExportMenu, OpFilter, Pager, SyncButton, control, fitSelect } from './reportControls';
import { useCustomizePrefs, useFitHeight, usePaged } from './tableHooks';
import { useTableSync } from './tableSync';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { Chip } from './LoanSetupDialog';
import { Dialog } from './LoanDialogs';
import { notAvailable } from './LoansTab';
import { downloadBlob, iso, numberFilterHit } from './reportModel';
import { linesFile } from './linesExport';
import EntryDetail from './EntryDetail';
import { takePendingOpen } from '../../lib/pendingOpen';
import AskAccountantDialog, { LineFacts, PersonSelect, amountText, usePeople } from './AskAccountantDialog';
import { AWAITING, NoteCell, OtherSideCell, PushBatchDialog, ReclassCell, ReclassDialog, missingEntries, otherSideText, reclassLabel, sideFor, useOffsets } from './AmaReclass';
import { AMA_PUSH_BATCH_LIMIT_DEFAULT, AMA_RECLASS_MODE_DEFAULT, AMA_SHOW_ACCOUNT_COLUMN } from './assumptions';
import { DateField } from '../../tasks/components';

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
//     find them by title), the accountants per entity and the bookkeepers.
//   - Change request 13 (Charmi, 10/22, ./AmaReclass.jsx): Other Side (the
//     offsetting account, in place of the always-AMA Account column), Notes
//     typed in the grid, and a GL Reclass per line that only a bookkeeper
//     approves and pushes.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const muted = { color: 'var(--text-muted)' };
const fieldLabel = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const ellipsis = { maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const dash = <span style={muted}>-</span>;

export const STATUS_FILTERS = ['Open', 'Answered', 'Resolved', 'All'];
const WHOSE = { all: 'Everyone', assigned: 'Assigned To Me', asked: 'Asked By Me', awaiting: 'Awaiting Bookkeeper' };
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
  // CR-13: the Account column always read "Ask My Accountant"; Other Side is
  // what the money came from or went to (Charmi, 31:36).
  ...(AMA_SHOW_ACCOUNT_COLUMN ? [{ key: 'account', label: 'Account', text: (r) => `${r.accountNo || ''} ${r.accountTitle || ''}`.trim(), width: 200 }] : []),
  { key: 'otherSide', label: 'Other Side', text: (r) => otherSideText(r.otherSide), width: 220 },
  { key: 'description', label: 'Description', text: lineText, width: 280 },
  { key: 'department', label: 'Department', text: (r) => r.department || '', width: 150 },
  { key: 'vendor', label: 'Vendor', text: (r) => r.vendor || '', width: 170 },
  { key: 'custom', label: 'Custom', text: (r) => r.custom || '', width: 150 },
  { key: 'amount', label: 'Amount', num: true, text: (r) => Number(r.amount) || 0 },
  { key: 'notes', label: 'Notes', text: (r) => r.note || '', width: 180 },
  { key: 'reclass', label: 'GL Reclass', text: (r) => (r.reclass ? `${r.reclass.toAccount} ${reclassLabel(r.reclass)}` : '') },
  { key: 'question', label: 'Question', text: (r) => r.question || '', width: 240 },
  { key: 'askedBy', label: 'Asked By', text: (r) => person(r.askedByName, r.askedBy) },
  { key: 'accountant', label: 'Accountant', text: (r) => person(r.accountantName, r.accountant) },
  { key: 'status', label: 'Status', text: statusText },
  { key: 'lastReply', label: 'Last Reply', text: (r) => (r.lastReplyAt ? formatDateTime(r.lastReplyAt) : '') },
];
export const COLUMNS = GRID_COLUMNS.map((c) => c.label);

// The grid's columns for the standard table view (10/23 meeting, item 01):
// the date and the amount typed for the rules, the newest lines first.
const AMA_VIEW_COLUMNS = GRID_COLUMNS.map((c) => {
  if (c.key === 'date') return { ...c, type: 'date', value: (r) => r.date || '' };
  if (c.key === 'amount') return { ...c, type: 'amount', value: (r) => Number(r.amount) || 0, text: (r) => formatAmount(r.amount), exportAs: [{ label: 'Amount', num: true, width: 120, get: (r) => Number(r.amount) || 0 }] };
  if (c.key === 'lastReply') return { ...c, sortBy: (r) => r.lastReplyAt || '' };
  return { ...c, exportAs: [{ label: c.label, width: c.key === 'question' || c.key === 'description' ? 260 : 120, get: c.text }] };
});
const AMA_SORT = { col: 'date', dir: 'desc' };

const MINE = {
  assigned: (r, me) => r.accountant === me,
  asked: (r, me) => r.askedBy === me,
  awaiting: (r) => r.reclass?.status === AWAITING,    // CR-13: the bookkeeper's queue
};

/** The rows a status, a "mine" choice and the filter box let through. */
export function visibleRows(rows, { status = 'Open', mine = 'all', me = '', text = '' } = {}) {
  const q = text.trim().toLowerCase();
  return (rows || []).filter((r) => (status === 'All' || r.status === status)
    && (mine === 'all' || !MINE[mine] || MINE[mine](r, me))
    && (!q || [r.entityCode, r.entryNo, r.accountNo, r.accountTitle, r.description, r.memo, r.party, r.department, r.vendor, r.custom, r.question, r.askedByName, r.askedBy, r.accountantName, r.accountant, String(r.amount), r.note, otherSideText(r.otherSide)]
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
export function ThreadPanel({ row, me, canEdit, onClose, onChanged, onAsk, onReclass }) {
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
            {row.otherSide?.all?.length > 0 && (
              <div style={{ fontSize: '0.78rem', marginTop: 4 }}><strong>Other Side: </strong><OtherSideCell side={{ ...row.otherSide, shown: row.otherSide.all }} /></div>
            )}
            {row.note && <div style={{ fontSize: '0.78rem', marginTop: 4 }}><strong>Notes: </strong>{row.note}</div>}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              {t.entryId && (
                <button type="button" className="acct-drill" onClick={() => setEntry({ id: t.entryId, no: t.entryNo })} style={{ fontSize: '0.78rem' }}>
                  Open the Journal Entry
                </button>
              )}
              {onReclass && <ReclassCell row={row} onOpen={onReclass} />}
            </div>
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
  // CR-13: who approves and pushes reclasses - the list kept here (the
  // server's environment list shows while this one is empty).
  const [keepers, setKeepers] = useState(() => (settings?.bookkeepersFromEnv ? [] : (settings?.bookkeepers || []).map((p) => p.email)));
  // CR-13 rework: no push edits an entry dated on or before this day.
  const [closed, setClosed] = useState(settings?.closedThrough || '');
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
    api.saveAskSettings({ ...(limited ? {} : { accounts: auto ? [] : [...picked], bookkeepers: keepers.filter(Boolean), closedThrough: closed }), accountants })
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
      <div>
        <span style={fieldLabel}>Bookkeepers</span>
        {limited ? (
          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
            {(settings?.bookkeepers || []).map((p) => p.name || p.email).join(', ') || 'None set'} - set by someone with access to every entity.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {settings?.bookkeepersFromEnv && !keepers.length && (
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                {settings.bookkeeperSource === 'seed'
                  ? `The team's bookkeepers, matched by name on the People list: ${(settings.bookkeepers || []).map((p) => p.name || p.email).join(', ') || 'nobody yet'}.`
                  : `From the server's settings: ${(settings.bookkeepers || []).map((p) => p.name || p.email).join(', ')}.`}
                {(settings.unmatchedBookkeepers || []).length > 0 && ` Not matched to exactly one person: ${settings.unmatchedBookkeepers.join(', ')}.`}
                {' '}Add people here to replace them.
              </div>
            )}
            {keepers.map((email, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
                <PersonSelect people={people} value={email} onChange={(v) => setKeepers((x) => x.map((y, j) => (j === i ? v : y)))} ariaLabel={`Bookkeeper ${i + 1}`} />
                <button type="button" className="icon-btn" aria-label={`Remove bookkeeper ${i + 1}`} onClick={() => setKeepers((x) => x.filter((_y, j) => j !== i))} style={{ padding: 4, color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
              </div>
            ))}
            <button type="button" className="secondary-btn" onClick={() => setKeepers((x) => [...x, ''])}
              style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', height: 28, padding: '0 10px' }}>
              <Plus size={13} /> Add Bookkeeper
            </button>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Only a bookkeeper can change, send back, approve and push a GL reclass. Anyone else picks the GL and it waits for them.</div>
          </div>
        )}
      </div>
      {!limited && (
        <div>
          <span style={fieldLabel}>Books Closed Through</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ width: 160 }}><DateField value={closed} onChange={(v) => setClosed(v || '')} placeholder="MM/DD/YYYY" title="Books Closed Through" style={{ width: '100%' }} /></div>
            {closed && <button type="button" className="secondary-btn" onClick={() => setClosed('')} style={{ fontSize: '0.74rem', height: 26, padding: '0 8px' }}>Clear</button>}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>
            No push to Intacct edits an entry dated on or before this day.{settings?.closedThroughDefault && !closed ? ` The server default is ${formatDate(settings.closedThroughDefault)}.` : ''}
            {settings?.pushBatchLimit ? ` Pushes take at most ${settings.pushBatchLimit} ${settings.pushBatchLimit === 1 ? 'line' : 'lines'} at a time.` : ''}
          </div>
        </div>
      )}
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
  // CR-13: Notes and reclasses saved since the list was read (no ledger
  // re-read for each), the line in the GL Reclass dialog, and the Other
  // Side read for the rows on screen.
  const [saved, setSaved] = useState({ notes: {}, reclasses: {} });
  const [reclassing, setReclassing] = useState(null);
  const offsets = useOffsets();

  useEffect(() => {
    api.getAccountingLocations?.().then((x) => setEntities(x?.entities || [])).catch(() => setEntities([]));
  }, []);
  useEffect(() => {
    const onOpen = (e) => { const id = e.detail?.id; if (id) { takePendingOpen('amaThread'); setOpen({ id, kind: 'thread', status: '' }); } };
    window.addEventListener('nexus:open-ama-thread', onOpen);
    return () => window.removeEventListener('nexus:open-ama-thread', onOpen);
  }, []);
  // 10/23 meeting, item 13: Sync reads these lines and questions again
  // (ts.tick), nothing else; an open thread or dialog stays open.
  const ts = useTableSync();
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);
  const key = JSON.stringify([entity, from, to, reloads, ts.tick]);
  useEffect(() => {
    let alive = true;
    ts.read(() => api.getAskItems({ entity, from, to }))
      .then((d) => { if (alive) { setRes({ key, data: d, error: null }); setSaved({ notes: {}, reclasses: {} }); } })
      .catch((e) => { if (alive) setRes({ key, data: null, error: e }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const load = () => setReloads((n) => n + 1);
  const loading = res.key !== key;
  const data = res.data;
  const error = loading ? null : res.error;
  const me = data?.me || '';
  const all = useMemo(() => (data?.rows || []).map((r) => ({
    ...r,
    note: r.id in saved.notes ? saved.notes[r.id] : (r.note || ''),
    reclass: r.id in saved.reclasses ? saved.reclasses[r.id] : (r.reclass || null),
    otherSide: sideFor(r, offsets.map),
  })), [data, saved, offsets.map]);
  // Whose, the filter box, the column filters and the standard table view
  // (10/23 meeting, item 01) narrow the rows; the status tabs count what they
  // leave, so a count is always what its tab shows. Newest first unless the
  // view sorts otherwise.
  const boxed = useMemo(() => columnFilter(visibleRows(all, { status: 'All', mine, me, text }), typed), [all, mine, me, text, typed]);
  const view = useTableView('ama', AMA_VIEW_COLUMNS, boxed, { sort: AMA_SORT });
  const narrowed = view.rows;
  const rows = useMemo(() => narrowed.filter((r) => status === 'All' || r.status === status), [narrowed, status]);
  const paged = usePaged(rows, custom.pageSize, [status, mine, text, entity, from, to, typed, view.state]);
  // The page on screen asks for its entries' other side (Charmi, 36:07: "on
  // the first page and not with two clicks").
  const pageKey = missingEntries(paged.rows, offsets.map).join(',');
  useEffect(() => {
    if (pageKey) offsets.load(paged.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);
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

  const amaCodes = new Set((data?.accounts || []).map((a) => a.code));
  const bookkeeper = !!data?.isBookkeeper;
  // CR-13 rework: the push edits the original entry, a few lines at a time.
  const reclassMode = data?.reclassMode || AMA_RECLASS_MODE_DEFAULT;
  const awaiting = useMemo(() => all.filter((r) => r.reclass?.status === AWAITING), [all]);
  const [pushing, setPushing] = useState(false);
  const exportAs = async (format) => {
    setBusy(format);
    try {
      // Every exported line carries its Other Side, read now when not yet on screen.
      const map = await offsets.ensure(rows);
      // Exactly what the view leaves: its rows, order and columns (item 01).
      const sided = rows.map((r) => ({ ...r, otherSide: sideFor(r, map) }));
      const about = exportTable([], { from, to });
      const file = await linesFile(viewTable(sided, view.columns, { title: about.title, period: about.period, subtitle: `${sided.length} ${sided.length === 1 ? 'line' : 'lines'} · ${formatDate(from)} - ${formatDate(to)}`, totals: false }), format);
      downloadBlob(file.name, file);
    } finally {
      setBusy('');
    }
  };
  const importFile = () => {
    setBusy('intacct');
    api.exportAskReclasses().then((blob) => downloadBlob('ama-reclasses-intacct-gl.csv', blob)).catch(() => {}).finally(() => setBusy(''));
  };
  const noteSaved = (r, rv) => setSaved((s) => ({ ...s, notes: { ...s.notes, [r.id]: rv?.note ?? '' } }));
  const reclassSaved = (r, rv) => {
    setSaved((s) => ({ ...s, reclasses: { ...s.reclasses, [r.id]: rv } }));
    if (rv?.status === 'Pushed') load();        // the line (and any question on it) is Resolved now
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

      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <div role="tablist" aria-label="Status" className="scroll-tabs" style={{ display: 'inline-flex', gap: 4 }}>
          {STATUS_FILTERS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)} className={status === s ? 'primary-btn' : 'secondary-btn'}
              style={{ fontSize: '0.76rem', height: 28, padding: '0 10px', whiteSpace: 'nowrap' }}>
              {s} <span style={{ opacity: 0.8 }}>{counts[s] ?? (loading ? '' : 0)}</span>
            </button>
          ))}
        </div>
        <BarMore level={2} active={entity ? 1 : 0}>
        <EntityPicker entities={entities} value={entity} onChange={setEntity} noneLabel={limited ? 'My Entities' : 'All Entities'} showHistorical={custom.showHistorical} ariaLabel="Entity" />
        </BarMore>
        <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" title="Lines dated from" style={control} />
        <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" title="Lines dated to" style={control} />
        {/* 10/23 meeting, item 02 (fix 10/24): the list as wide as the choice, the search an icon until used. */}
        <BarMore level={2} active={mine !== 'all' ? 1 : 0}>
        <select value={mine} onChange={(e) => setMine(e.target.value)} aria-label="Whose" style={{ ...control, ...fitSelect(WHOSE[mine]) }}>
          {Object.entries(WHOSE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        </BarMore>
        <BarSearch value={text} onChange={setText} label="Filter questions" placeholder="Filter questions" width={200} />
        <TableViewBar view={view} />
        <div className="acct-bar-end">
          <SyncButton onSync={ts.sync} busy={loading && !!data} syncedAt={ts.syncedAt} />
          <BarMore level={1}>
          <CustomizeButton {...custom} />
          {bookkeeper && reclassMode !== 'new_entry' && awaiting.length > 0 && (
            <button type="button" className="secondary-btn" onClick={() => setPushing(true)} title="Push Reclasses" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}>
              <Send size={14} /> <span className="acct-bar-label">Push Reclasses</span> ({awaiting.length})
            </button>
          )}
          {editor && (
            <button type="button" className="secondary-btn" onClick={openSettings} title="Settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}>
              <Settings size={14} /> <span className="acct-bar-label">Settings</span>
            </button>
          )}
          </BarMore>
          <ExportMenu disabled={!rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The lines on screen, amounts as numbers', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            ...(bookkeeper && reclassMode === 'new_entry' ? [{ key: 'intacct', label: 'Intacct Import File', hint: 'The approved GL reclasses recorded for import', onPick: importFile, busy: busy === 'intacct' }] : []),
          ]} />
        </div>
      </ControlBar>

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
          {/* 10/23 meeting, item 05: the lines scroll inside this box; the headings and filter boxes stay pinned. */}
          <div className="req-table-wrapper acct-scroll-box" ref={setBox} data-testid="ama-box" style={fit}>
            <table className="req-table acct-ask acct-sticky-head" style={{ fontVariantNumeric: 'tabular-nums', '--ask-py': py }}>
              <thead>
                <tr>{view.columns.map((c) => <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={{ position: 'relative', ...(c.num ? num : null), ...(view.manualWidth(c.key) ? { width: view.manualWidth(c.key), minWidth: view.manualWidth(c.key), maxWidth: view.manualWidth(c.key) } : null) }} />)}</tr>
                <tr className="acct-filter-row">
                  {view.columns.map((c) => (
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
                  <tr key={`sk${i}`} aria-hidden="true">{view.columns.map((c) => <td key={c.key}><div className="nx-skel" style={{ height: 12, borderRadius: 4, width: '70%' }} /></td>)}</tr>
                )) : !rows.length ? (
                  <tr><td colSpan={view.columns.length} style={{ padding: 18, textAlign: 'center', color: 'var(--text-secondary)', cursor: 'default' }}>Nothing here matches - try another status or clear the filters.</td></tr>
                ) : paged.rows.map((r) => {
                  // A width set by hand clips the cell to it (item 01's Manual Width).
                  const w = (k, base = ellipsis) => { const px = view.manualWidth(k); return px ? { ...base, width: px, minWidth: px, maxWidth: px, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : base; };
                  const nowrap = { whiteSpace: 'nowrap' };
                  return (
                    <tr key={r.id} onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }} aria-label={`Open ${r.entryNo || r.accountNo} ${amountText(r)}`}
                      style={loading ? { opacity: 0.6 } : undefined}>
                      {viewCells(view, {
                        date: <td style={w('date', nowrap)}>{r.date ? formatDate(r.date) : dash}</td>,
                        entity: <td style={w('entity', nowrap)}>{r.entityCode || dash}</td>,
                        entry: <td style={w('entry', nowrap)}>{r.entryNo || dash}</td>,
                        account: <td style={w('account')} title={`${r.accountNo} ${r.accountTitle}`}><span className="acct-code">{r.accountNo}</span>{r.accountTitle}</td>,
                        otherSide: <td style={w('otherSide', { ...ellipsis, maxWidth: 260 })}><OtherSideCell side={r.otherSide} /></td>,
                        description: <td style={w('description')} title={[lineText(r), r.memo && r.description && r.description !== r.memo ? `Entry: ${r.description}` : ''].filter(Boolean).join('\n')}>{lineText(r) || dash}</td>,
                        department: <td style={w('department')} title={r.department || undefined}>{r.department || dash}</td>,
                        vendor: <td style={w('vendor')} title={r.vendor || undefined}>{r.vendor || dash}</td>,
                        custom: <td style={w('custom')} title={r.custom || undefined}>{r.custom || dash}</td>,
                        amount: <td style={w('amount', num)}><Amount value={r.amount} /></td>,
                        notes: <td style={w('notes', {})}><NoteCell key={`${r.id}:${r.note}`} row={r} onSaved={noteSaved} /></td>,
                        reclass: <td style={w('reclass', {})}>{amaCodes.has(r.accountNo) ? <ReclassCell row={r} onOpen={setReclassing} /> : dash}</td>,
                        question: <td style={w('question')} title={r.question}>{r.question || <span style={muted}>Not Asked Yet</span>}</td>,
                        askedBy: <td style={w('askedBy', nowrap)}>{person(r.askedByName, r.askedBy) || dash}</td>,
                        accountant: <td style={w('accountant', nowrap)}>{person(r.accountantName, r.accountant) || dash}</td>,
                        status: <td style={w('status', {})}><StatusChips r={r} /></td>,
                        lastReply: <td style={w('lastReply', nowrap)} title={r.lastReplyByName || r.lastReplyBy || undefined}>{r.lastReplyAt ? formatDateTime(r.lastReplyAt) : dash}</td>,
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!loading && <Pager {...paged} style={{ borderTop: '1px solid var(--border-color)' }} />}
        </div>
      )}

      {open && <ThreadPanel key={open.id} row={all.find((r) => r.id === open.id) || open} me={me} canEdit={editor} onClose={() => setOpen(null)} onChanged={load} onAsk={(r) => setAsking(r)}
        onReclass={amaCodes.has(open.accountNo) ? setReclassing : undefined} />}
      {reclassing && (
        <ReclassDialog key={reclassing.id} row={all.find((r) => r.id === reclassing.id) || reclassing} side={(all.find((r) => r.id === reclassing.id) || reclassing).otherSide}
          isBookkeeper={bookkeeper} pushToIntacct={!!data?.pushToIntacct} reclassMode={reclassMode} onClose={() => setReclassing(null)} onSaved={(rv) => reclassSaved(reclassing, rv)} />
      )}
      {pushing && (
        <PushBatchDialog rows={awaiting} limit={data?.pushBatchLimit || AMA_PUSH_BATCH_LIMIT_DEFAULT} live={!!data?.pushToIntacct}
          onClose={() => setPushing(false)} onDone={(r) => { (r?.reviews || []).forEach((rv) => { const row = all.find((x) => x.reclass?.id === rv.id); if (row) reclassSaved(row, rv); }); }} />
      )}
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
