import { useEffect, useMemo, useState } from 'react';
import { MessageCircleQuestion, Plus, Search, Settings, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime } from '../../lib/datetime';
import Amount from './Amount';
import { CustomizeButton, DENSITIES, EntityPicker, ExportMenu, Pager, control } from './reportControls';
import { useCustomizePrefs, usePaged } from './tableHooks';
import { Chip } from './LoanSetupDialog';
import { Dialog } from './LoanDialogs';
import { notAvailable } from './LoansTab';
import { downloadBlob, iso } from './reportModel';
import { linesFile } from './linesExport';
import EntryDetail from './EntryDetail';
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
export const COLUMNS = ['Date', 'Entity', 'Entry', 'Account', 'Description', 'Amount', 'Question', 'Asked By', 'Accountant', 'Status', 'Last Reply'];

const yearAgo = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return iso(d); };
const person = (name, email) => name || email || '';

/** The rows a status, a "mine" choice and the filter box let through. */
export function visibleRows(rows, { status = 'Open', mine = 'all', me = '', text = '' } = {}) {
  const q = text.trim().toLowerCase();
  return (rows || []).filter((r) => (status === 'All' || r.status === status)
    && (mine === 'all' || (mine === 'assigned' ? r.accountant === me : r.askedBy === me))
    && (!q || [r.entityCode, r.entryNo, r.accountNo, r.accountTitle, r.description, r.memo, r.party, r.question, r.askedByName, r.askedBy, r.accountantName, r.accountant, String(r.amount)]
      .some((v) => String(v || '').toLowerCase().includes(q))));
}

/** The grid as an export table (linesExport). */
export function exportTable(rows, { from, to }) {
  return {
    title: 'Ask My Accountant',
    period: `${formatDate(from)} - ${formatDate(to)}`.replace(/\//g, '-'),
    subtitle: `${rows.length} ${rows.length === 1 ? 'line' : 'lines'} · ${formatDate(from)} - ${formatDate(to)}`,
    columns: COLUMNS.map((label) => ({ label, num: label === 'Amount', width: label === 'Question' || label === 'Description' ? 260 : 120 })),
    rows: rows.map((r) => [formatDate(r.date), r.entityCode, r.entryNo, `${r.accountNo} ${r.accountTitle || ''}`.trim(), r.description || r.memo || '',
      Number(r.amount) || 0, r.question || '', person(r.askedByName, r.askedBy), person(r.accountantName, r.accountant),
      r.reclassed && r.status !== 'Resolved' ? `${r.status} (Reclassed)` : r.status, r.lastReplyAt ? formatDateTime(r.lastReplyAt) : '']),
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
  const [rows, setRows] = useState(() => Object.entries(settings?.accountants || {}).flatMap(([entity, list]) => list.map((p) => ({ entity, email: p.email }))));
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
    rows.filter((r) => r.email).forEach((r) => { (accountants[r.entity] ||= []).push(r.email); });
    Object.keys(settings?.accountants || {}).forEach((k) => { accountants[k] ||= []; });
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
  const [reloads, setReloads] = useState(0);
  const [res, setRes] = useState({ key: null, data: null, error: null });
  const [open, setOpen] = useState(null);       // the row in the side panel
  const [asking, setAsking] = useState(null);   // the line in the Ask dialog
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api.getAccountingLocations?.().then((x) => setEntities(x?.entities || [])).catch(() => setEntities([]));
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
  const rows = useMemo(() => visibleRows(all, { status, mine, me, text }).sort((a, b) => String(b.date).localeCompare(String(a.date))), [all, status, mine, me, text]);
  const paged = usePaged(rows, custom.pageSize, [status, mine, text, entity, from, to]);
  const counts = data?.counts || {};
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

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <style>{`.acct-ask tbody > tr > td { padding-top: var(--ask-py, 5px); padding-bottom: var(--ask-py, 5px); } .acct-ask tbody > tr { cursor: pointer; }`}</style>
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
        <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" style={control} />
        <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" style={control} />
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

      {!error && !loading && !rows.length && (
        <div style={{ ...card, padding: 18, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          {all.length ? 'Nothing here matches - try another status or clear the filter.' : 'Nothing to ask about. Use the question mark on any line in Ledger Search or a journal entry to ask your accountant.'}
        </div>
      )}

      {!error && (loading || rows.length > 0) && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }} aria-busy={loading}>
          <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="req-table acct-ask" style={{ fontVariantNumeric: 'tabular-nums', '--ask-py': py }}>
              <thead><tr>{COLUMNS.map((c) => <th key={c} style={c === 'Amount' ? num : undefined}>{c}</th>)}</tr></thead>
              <tbody>
                {loading && !data ? Array.from({ length: 5 }, (_x, i) => (
                  <tr key={`sk${i}`} aria-hidden="true">{COLUMNS.map((c) => <td key={c}><div className="nx-skel" style={{ height: 12, borderRadius: 4, width: '70%' }} /></td>)}</tr>
                )) : paged.rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }} aria-label={`Open ${r.entryNo || r.accountNo} ${amountText(r)}`}
                    style={loading ? { opacity: 0.6 } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.date ? formatDate(r.date) : dash}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.entityCode || dash}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.entryNo || dash}</td>
                    <td style={ellipsis} title={`${r.accountNo} ${r.accountTitle}`}><span className="acct-code">{r.accountNo}</span>{r.accountTitle}</td>
                    <td style={ellipsis} title={r.description || r.memo}>{r.description || r.memo || dash}</td>
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
