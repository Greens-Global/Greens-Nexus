// The Build Mode panel: a 60vw sheet (full screen on phones) with Queue /
// Sessions / Settings. Queue = pins grouped by Build Session with Send To
// Claude Code at the top; Sessions = every session with its PR and a Stats
// strip; Settings = Send Instantly, Dispatch Target, Pins On Load, Build
// Tokens and the watcher one-liner for VS Code.
import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Send, ExternalLink, Copy, Check, Loader2, Trash2, Pencil, RotateCcw, KeyRound, MessageSquare, Download } from 'lucide-react';
import { api } from '../api';
import { graphTokenSilent, listMyChats } from '../teamsGraph';
import { formatDateTime, formatDate } from '../lib/datetime';
import { toViewUrl } from '../lib/storageView';
import { useIsMobile } from '../lib/useIsMobile';
import { StatusLabel } from '../components/StatusLabel';
import { statusMeta, sessionMeta, KIND_META, PRIORITY_META, firstNameOf, WATCHER_COMMAND } from './meta';
import { toast } from './store';

const TABS = [{ id: 'queue', label: 'Queue' }, { id: 'sessions', label: 'Sessions' }, { id: 'settings', label: 'Settings' }];

function useCopy() {
  const [done, setDone] = useState('');
  const copy = useCallback(async (text, key = 'x') => {
    try { await navigator.clipboard.writeText(text); setDone(key); setTimeout(() => setDone(''), 1600); } catch { toast('Copy failed - select the text and copy it'); }
  }, []);
  return [done, copy];
}

function CopyButton({ text, label = 'Copy', copyKey }) {
  const [done, copy] = useCopy();
  return (
    <button type="button" className="bm-btn bm-btn-sm" onClick={() => copy(text, copyKey || text)} aria-label={label}>
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Copied' : label}
    </button>
  );
}

function Switch({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`bm-switch-row${disabled ? ' is-disabled' : ''}`}>
      <span className="bm-switch-text"><span className="bm-switch-label">{label}</span>{hint && <span className="bm-dim bm-small">{hint}</span>}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`bm-switch${checked ? ' is-on' : ''}`} onClick={() => !disabled && onChange(!checked)} disabled={disabled}><span className="bm-switch-knob" /></button>
    </label>
  );
}

// ── Queue ────────────────────────────────────────────────────────────────────
function PinRow({ pin, onOpen, onChanged }) {
  const m = statusMeta(pin.status);
  const kind = KIND_META[pin.kind] || KIND_META.bug;
  const prio = PRIORITY_META[pin.priority];
  const [busy, setBusy] = useState(false);
  const act = async (fn, msg) => { setBusy(true); try { const n = await fn(); onChanged?.(n); if (msg) toast(msg); } catch (e) { toast(e?.message || 'That did not work.'); } finally { setBusy(false); } };
  const shot = pin.screenshotUrl || pin.pageShotUrl;
  return (
    <div className={`bm-row${m.faded ? ' is-faded' : ''}`} data-testid="bm-queue-row">
      <span className="bm-pin bm-pin-inline" style={{ '--c': m.color }} aria-hidden="true"><span className="bm-pin-no">{pin.number}</span></span>
      {shot ? <img className="bm-row-thumb" src={toViewUrl(shot)} alt="" /> : <span className="bm-row-thumb is-empty" aria-hidden="true" />}
      <div className="bm-row-main">
        <div className="bm-row-top">
          <span className="bm-row-kind" style={{ color: kind.color }}>{kind.label}</span>
          {prio && pin.priority !== 'normal' && <span className="bm-row-prio" style={{ color: prio.color }}>{prio.label}</span>}
          <StatusLabel label={m.label} color={m.color} size="sm" />
          {pin.prUrl && <a className="bm-link" href={pin.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={11} /> PR #{pin.prNumber}</a>}
          {pin.videoUrl && <a className="bm-link" href={toViewUrl(pin.videoUrl)} target="_blank" rel="noreferrer"><ExternalLink size={11} /> Video</a>}
        </div>
        <button type="button" className="bm-row-comment" onClick={() => onOpen?.(pin)} title="Open this pin where it was made">
          {pin.comment || pin.edit?.note || <span className="bm-dim">(no comment)</span>}
        </button>
        <div className="bm-row-meta">
          <span>{firstNameOf(pin.createdBy)}</span><span className="bm-dot-sep" /><span>{pin.route}{pin.sub ? ` › ${pin.sub}` : ''}</span><span className="bm-dot-sep" /><span>{formatDateTime(pin.createdAt)}</span>
          {pin.progress && <><span className="bm-dot-sep" /><span className="bm-row-progress">{pin.progress}</span></>}
          {(pin.thread || []).length > 0 && <><span className="bm-dot-sep" /><span>{pin.thread.length} in thread</span></>}
        </div>
      </div>
      <div className="bm-row-actions">
        {pin.status === 'dismissed'
          ? <button type="button" className="bm-btn bm-btn-sm" disabled={busy} onClick={() => act(() => api.devNotesPatch(pin.id, { status: 'open' }), `Pin #${pin.number} reopened`)}><RotateCcw size={13} /> Reopen</button>
          : pin.status !== 'done' && <button type="button" className="bm-btn bm-btn-sm bm-btn-ghost" disabled={busy} onClick={() => act(() => api.devNotesPatch(pin.id, { status: 'dismissed' }), `Pin #${pin.number} dismissed`)} title="Dismiss"><Trash2 size={13} /></button>}
      </div>
    </div>
  );
}

// Where the Build Session also posts in Teams: any group chat or 1:1 chat the
// person is in (their own list, loaded through the server's delegated token
// like TeamsTargetPicker, MSAL only as the fallback), or nowhere. The pick is
// remembered in their Build Mode settings and sent with the dispatch.
function TeamsChatPick({ settings, onSettings }) {
  const [chats, setChats] = useState(null);     // null = not loaded
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const picked = settings?.teamsChatId || '';
  const load = async () => {
    if (chats || loading) return;
    setLoading(true);
    try {
      const r = await api.timeMyChats();
      if (r?.chats?.length) { setChats(r.chats); return; }
      const tok = await graphTokenSilent();
      setChats(tok ? await listMyChats(tok) : []);
      if (!tok) toast(r?.reason ? `Could not load your Teams chats - ${r.reason}` : 'Could not load your Teams chats.');
    } catch (e) { setChats([]); toast(e?.message || 'Could not load your Teams chats.'); }
    finally { setLoading(false); }
  };
  const pick = async (c) => {
    setOpen(false);
    try { await onSettings?.({ teamsChatId: c?.id || '', teamsChatName: c?.name || '' }); }
    catch (e) { toast(e?.message || 'The chat was not saved.'); }
  };
  return (
    <div className="bm-chat-pick">
      <button type="button" className="bm-btn bm-btn-sm" onClick={() => { setOpen((o) => !o); load(); }} aria-expanded={open} aria-haspopup="listbox"
        title="Also post this Build Session to a Teams chat - a group or a person">
        <MessageSquare size={13} /> {picked ? `Teams: ${settings.teamsChatName || 'chat'}` : 'Also Post To Teams'}
      </button>
      {open && (
        <div className="bm-chat-menu" role="listbox" aria-label="Teams chat">
          <button type="button" role="option" aria-selected={!picked} className={`bm-chat-opt${!picked ? ' is-on' : ''}`} onClick={() => pick(null)}>Do not post to Teams</button>
          {loading && <div className="bm-dim bm-small bm-chat-note"><Loader2 size={12} className="bm-spin" /> Loading your chats…</div>}
          {chats && !chats.length && !loading && <div className="bm-dim bm-small bm-chat-note">No chats found. Sign in to Teams once and try again.</div>}
          {(chats || []).map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={picked === c.id} className={`bm-chat-opt${picked === c.id ? ' is-on' : ''}`} onClick={() => pick(c)}>
              {c.name || 'Chat'} <span className="bm-dim bm-small">{c.chatType === 'group' ? 'group' : c.chatType === 'oneOnOne' ? 'person' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueTab({ notes, dismissed, sessions, loading, onOpenPin, onChanged, onDispatched, myEmail, settings, onSettings }) {
  const [sending, setSending] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const bySession = new Map();
  for (const n of notes) { const k = n.sessionId || ''; if (!bySession.has(k)) bySession.set(k, []); bySession.get(k).push(n); }
  const sessionOf = (id) => sessions.find((s) => s.id === id);
  const groups = [...bySession.entries()].map(([id, pins]) => ({ id, pins, session: sessionOf(id) }))
    .sort((a, b) => {
      const ac = a.session?.status === 'collecting' ? 0 : 1, bc = b.session?.status === 'collecting' ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return String(b.session?.createdAt || b.pins[0]?.createdAt || '').localeCompare(String(a.session?.createdAt || a.pins[0]?.createdAt || ''));
    });
  const mineOpen = notes.filter((n) => n.status === 'open' && (!myEmail || n.createdBy === myEmail) && sessionOf(n.sessionId)?.status !== 'sent');
  const canSend = mineOpen.length > 0;
  const send = async () => {
    setSending(true);
    try {
      const r = await api.devNotesDispatch({});
      const n = Array.isArray(r?.notes) ? r.notes.length : 0;   // the server's count, nothing guessed
      const chat = r?.session?.teamsChatName ? ` and posted to ${r.session.teamsChatName}` : '';
      toast(n ? `${n} pin${n === 1 ? '' : 's'} sent to Claude Code${chat}` : `Build Session sent to Claude Code${chat}`);
      onDispatched?.();
    }
    catch (e) { toast(e?.message || 'Nothing was sent.'); }
    finally { setSending(false); }
  };
  return (
    <>
      <div className="bm-queue-head">
        <div>
          <div className="bm-h2">{notes.length} pin{notes.length === 1 ? '' : 's'} in the queue</div>
          <div className="bm-dim bm-small">{canSend ? `${mineOpen.length} of yours ready to send.` : 'Your collecting session is empty - pin something first.'}</div>
        </div>
        <TeamsChatPick settings={settings} onSettings={onSettings} />
        <button type="button" className="bm-btn bm-btn-primary" onClick={send} disabled={!canSend || sending} title={canSend ? 'Send your open pins to the watcher in your terminal' : 'Nothing to send yet'}>
          {sending ? <Loader2 size={14} className="bm-spin" /> : <Send size={14} />} Send To Claude Code
        </button>
      </div>
      <div className="bm-list nx-fill" data-testid="bm-queue">
        {loading && !notes.length && <div className="bm-dim">Loading…</div>}
        {!loading && !notes.length && <div className="bm-empty">No pins yet. Press P, click anything on the page and say what should change.</div>}
        {groups.map(({ id, pins, session }) => {
          const sm = sessionMeta(session?.status || 'collecting');
          return (
            <section key={id || 'none'} className="bm-group">
              <header className="bm-group-head">
                <span className="bm-group-title">{session?.title || 'Build Session'}</span>
                <StatusLabel label={sm.label} color={sm.color} size="sm" />
                <span className="bm-dim bm-small">{pins.length} pin{pins.length === 1 ? '' : 's'}</span>
                {session?.prUrl && <a className="bm-link" href={session.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={11} /> PR #{session.prNumber}</a>}
              </header>
              {pins.sort((a, b) => (a.number || 0) - (b.number || 0)).map((p) => <PinRow key={p.id} pin={p} onOpen={onOpenPin} onChanged={onChanged} />)}
            </section>
          );
        })}
        {dismissed.length > 0 && (
          <section className="bm-group">
            <header className="bm-group-head">
              <button type="button" className="bm-link-btn" onClick={() => setShowDismissed((v) => !v)}>{showDismissed ? 'Hide' : 'Show'} {dismissed.length} dismissed</button>
            </header>
            {showDismissed && dismissed.map((p) => <PinRow key={p.id} pin={p} onOpen={onOpenPin} onChanged={onChanged} />)}
          </section>
        )}
      </div>
    </>
  );
}

// ── Sessions ─────────────────────────────────────────────────────────────────
const pct = (v) => (v == null || Number.isNaN(Number(v)) ? '-' : `${Math.round(Number(v) * 100)}%`);
const hours = (v) => (v == null || Number.isNaN(Number(v)) ? '-' : Number(v) < 1 ? `${Math.round(Number(v) * 60)} min` : `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} h`);

function Stats({ stats }) {
  if (!stats) return null;
  return (
    <div className="bm-stats" aria-label="Build Mode statistics">
      <div className="bm-stat"><span className="bm-stat-v">{hours(stats.medianPinToPrHours)}</span><span className="bm-stat-l">Pin To PR (Median)</span></div>
      <div className="bm-stat"><span className="bm-stat-v">{pct(stats.firstClaimHitRate)}</span><span className="bm-stat-l">First-Claim Hit Rate</span></div>
      <div className="bm-stat"><span className="bm-stat-v">{pct(stats.reopenRate)}</span><span className="bm-stat-l">Reopen Rate</span></div>
      {stats.pins && <div className="bm-stat bm-stat-wide"><span className="bm-stat-v">{stats.pins.total ?? '-'}</span><span className="bm-stat-l">Pins{stats.days ? ` (${stats.days} days)` : ''} · {stats.pins.open ?? 0} open · {stats.pins.fixed ?? 0} to verify · {stats.pins.done ?? 0} done</span></div>}
    </div>
  );
}

function SessionRow({ s, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title || '');
  const [saving, setSaving] = useState(false);
  const m = sessionMeta(s.status);
  // Save Report: one HTML file with every pin, its module, comment and
  // marked-up shot - opens anywhere, no login, attaches to an email.
  const report = async () => {
    setSaving(true);
    try {
      const { blob, filename } = await api.devNotesSessionReport(s.id);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename || 'Build Session.html' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e?.message || 'The report could not be saved.'); }
    finally { setSaving(false); }
  };
  const save = async () => {
    const t = title.trim();
    setEditing(false);
    if (!t || t === s.title) return;
    try { onChanged?.(await api.devNotesSessionPatch(s.id, { title: t })); toast('Session renamed'); } catch (e) { toast(e?.message || 'Rename failed'); }
  };
  return (
    <div className="bm-row bm-session-row">
      <div className="bm-row-main">
        <div className="bm-row-top">
          {editing
            ? <input className="bm-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setTitle(s.title || ''); setEditing(false); } }} aria-label="Session title" />
            : <button type="button" className="bm-row-title" onClick={() => setEditing(true)} title="Rename">{s.title || 'Build Session'} <Pencil size={11} /></button>}
          <StatusLabel label={m.label} color={m.color} size="sm" />
        </div>
        <div className="bm-row-meta">
          <span>{s.noteCount ?? 0} pin{(s.noteCount ?? 0) === 1 ? '' : 's'}</span><span className="bm-dot-sep" /><span>{firstNameOf(s.createdBy)}</span><span className="bm-dot-sep" /><span>{formatDateTime(s.createdAt)}</span>
          {s.dispatchedAt && <><span className="bm-dot-sep" /><span>sent {formatDateTime(s.dispatchedAt)}</span></>}
          {s.branch && <><span className="bm-dot-sep" /><code>{s.branch}</code></>}
          {s.teamsChatName && <><span className="bm-dot-sep" /><span title="Posted to this Teams chat"><MessageSquare size={11} /> {s.teamsChatName}</span></>}
        </div>
      </div>
      <button type="button" className="bm-btn bm-btn-sm" onClick={report} disabled={saving || !(s.noteCount > 0)} title="Save one HTML file with every pin, comment and screenshot">
        {saving ? <Loader2 size={13} className="bm-spin" /> : <Download size={13} />} Save Report
      </button>
      {s.prUrl && <a className="bm-btn bm-btn-sm" href={s.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> PR #{s.prNumber}</a>}
    </div>
  );
}

function SessionsTab({ sessions, stats, loading, onChanged }) {
  return (
    <>
      <Stats stats={stats} />
      <div className="bm-list nx-fill">
        {loading && !sessions.length && <div className="bm-dim">Loading…</div>}
        {!loading && !sessions.length && <div className="bm-empty">No Build Sessions yet - the first pin starts one.</div>}
        {sessions.map((s) => <SessionRow key={s.id} s={s} onChanged={onChanged} />)}
      </div>
    </>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────
function Tokens() {
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState(null);    // { token, label, expiresAt } shown once
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState('');
  const load = useCallback(() => api.devNotesTokens().then((t) => setTokens(Array.isArray(t) ? t : [])).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const mint = async () => {
    setBusy(true);
    try { const r = await api.devNotesTokenCreate(label.trim() || 'My Computer'); setMinted(r); setLabel(''); load(); }
    catch (e) { toast(e?.message || 'The token could not be minted.'); }
    finally { setBusy(false); }
  };
  const revoke = async (id) => {
    setBusy(true);
    try { await api.devNotesTokenRevoke(id); setConfirmId(''); if (minted?.id === id) setMinted(null); load(); toast('Token revoked'); }
    catch (e) { toast(e?.message || 'The token could not be revoked.'); }
    finally { setBusy(false); }
  };
  const live = tokens.filter((t) => !t.revokedAt);
  return (
    <section className="bm-settings-sec">
      <div className="bm-sec-title"><KeyRound size={13} /> Build Tokens</div>
      <div className="bm-dim bm-small">A token lets the watcher in your terminal act as you for 30 days. It is shown once, right after minting.</div>
      <div className="bm-mint">
        <input className="bm-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Neil's MacBook" aria-label="Token label" onKeyDown={(e) => { if (e.key === 'Enter') mint(); }} />
        <button type="button" className="bm-btn bm-btn-primary" onClick={mint} disabled={busy}>{busy ? <Loader2 size={14} className="bm-spin" /> : <KeyRound size={14} />} Mint Token</button>
      </div>
      {minted?.token && (
        <div className="bm-minted" role="status">
          <div className="bm-small"><b>Copy it now</b> - it is not shown again. Expires {formatDate(minted.expiresAt)}.</div>
          <div className="bm-code-row"><code className="bm-code">{minted.token}</code><CopyButton text={minted.token} label="Copy Token" /></div>
          <div className="bm-small bm-dim">One line for a VS Code terminal at the repo root - saves the token and starts waiting for pins:</div>
          <div className="bm-code-row"><code className="bm-code">NEXUS_BUILD_TOKEN={minted.token} {WATCHER_COMMAND}</code><CopyButton text={`NEXUS_BUILD_TOKEN=${minted.token} ${WATCHER_COMMAND}`} label="Copy Command" /></div>
        </div>
      )}
      {live.length > 0 && (
        <div className="bm-token-list">
          {live.map((t) => (
            <div key={t.id} className="bm-row bm-token-row">
              <div className="bm-row-main">
                <div className="bm-row-top"><span className="bm-row-title">{t.label || 'Token'}</span>{t.email && <span className="bm-dim bm-small">{t.email}</span>}</div>
                <div className="bm-row-meta"><span>Minted {formatDate(t.createdAt)}</span><span className="bm-dot-sep" /><span>Expires {formatDate(t.expiresAt)}</span>{t.lastUsedAt && <><span className="bm-dot-sep" /><span>Last used {formatDateTime(t.lastUsedAt)}</span></>}</div>
              </div>
              {confirmId === t.id
                ? <span className="bm-confirm">Revoke? <button type="button" className="bm-btn bm-btn-sm bm-btn-danger" onClick={() => revoke(t.id)} disabled={busy}>Revoke</button><button type="button" className="bm-btn bm-btn-sm bm-btn-ghost" onClick={() => setConfirmId('')}>Keep</button></span>
                : <button type="button" className="bm-btn bm-btn-sm bm-btn-ghost" onClick={() => setConfirmId(t.id)} disabled={busy}><Trash2 size={13} /> Revoke</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsTab({ settings, onSettings }) {
  const [busy, setBusy] = useState('');
  const change = async (patch) => {
    setBusy(Object.keys(patch)[0]);
    try { await onSettings(patch); } catch (e) { toast(e?.message || 'The setting was not saved.'); } finally { setBusy(''); }
  };
  return (
    <div className="bm-settings nx-fill">
      <section className="bm-settings-sec">
        <div className="bm-sec-title">Sending</div>
        <Switch label="Send Instantly" hint="Every pin goes to Claude Code the moment it is saved, instead of collecting into a Build Session." checked={!!settings.sendInstantly} disabled={busy === 'sendInstantly'} onChange={(v) => change({ sendInstantly: v })} />
        <div className="bm-field-block">
          <div className="bm-switch-label">Dispatch Target</div>
          <div className="bm-radios" role="radiogroup" aria-label="Dispatch Target">
            <label className="bm-radio"><input type="radio" name="bm-dispatch" checked={(settings.dispatchTarget || 'local') === 'local'} onChange={() => change({ dispatchTarget: 'local' })} /> Local Terminal <span className="bm-dim bm-small">- the watcher running in your VS Code</span></label>
            <label className="bm-radio is-disabled" title="Coming later"><input type="radio" name="bm-dispatch" disabled /> GitHub Issue <span className="bm-dim bm-small">- Coming Later</span></label>
          </div>
        </div>
      </section>
      <section className="bm-settings-sec">
        <div className="bm-sec-title">On Screen</div>
        <Switch label="Pins On Load" hint="Show everyone's pins on a screen as soon as Build Mode turns on. Off = toggle them from the strip." checked={settings.pinsOnLoad !== false} disabled={busy === 'pinsOnLoad'} onChange={(v) => change({ pinsOnLoad: v })} />
      </section>
      <Tokens />
      <section className="bm-settings-sec">
        <div className="bm-sec-title">The Watcher</div>
        <div className="bm-dim bm-small">Paste into a VS Code terminal at the repo root. It waits for pins and starts Claude Code on them in that same terminal; the token comes from <code>~/.config/nexus/build-notes.token</code> or <code>NEXUS_BUILD_TOKEN</code>.</div>
        <div className="bm-code-row"><code className="bm-code">{WATCHER_COMMAND}</code><CopyButton text={WATCHER_COMMAND} label="Copy" /></div>
      </section>
    </div>
  );
}

// ── The sheet ────────────────────────────────────────────────────────────────
export default function Panel({ open, tab = 'queue', onTab, onClose, settings, onSettings, onOpenPin, version = 0, onDispatched, myEmail = '' }) {
  const isMobile = useIsMobile();
  const [notes, setNotes] = useState([]);
  const [dismissed, setDismissed] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const sheetRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [n, d, s, st] = await Promise.all([
      api.devNotesList({ limit: 200 }).catch(() => null),
      api.devNotesList({ status: 'dismissed', limit: 50 }).catch(() => null),
      api.devNotesSessions({ limit: 50 }).catch(() => null),
      api.devNotesStats().catch(() => null),
    ]);
    if (Array.isArray(n)) setNotes(n);
    if (Array.isArray(d)) setDismissed(d);
    if (Array.isArray(s)) setSessions(s);
    setStats(st && typeof st === 'object' ? st : null);
    setLoading(false);
  }, []);
  useEffect(() => { if (open) load(); }, [open, version, load]);
  useEffect(() => { if (open) setTimeout(() => sheetRef.current?.focus(), 20); }, [open]);

  if (!open) return null;
  const replace = (note) => {
    if (!note?.id) return;
    const put = (list) => list.some((x) => x.id === note.id) ? list.map((x) => (x.id === note.id ? note : x)) : list;
    if (note.status === 'dismissed') { setNotes((l) => l.filter((x) => x.id !== note.id)); setDismissed((l) => (l.some((x) => x.id === note.id) ? put(l) : [note, ...l])); }
    else { setDismissed((l) => l.filter((x) => x.id !== note.id)); setNotes((l) => (l.some((x) => x.id === note.id) ? put(l) : [note, ...l])); }
  };
  const replaceSession = (s) => s?.id && setSessions((l) => l.map((x) => (x.id === s.id ? { ...x, ...s } : x)));

  return (
    <div className="bm-sheet-overlay" onClick={onClose} role="presentation">
      <div ref={sheetRef} className={`bm-sheet${isMobile ? ' is-mobile' : ''}`} role="dialog" aria-modal="true" aria-label="Build Mode" tabIndex={-1} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}>
        <div className="bm-sheet-head">
          <div className="bm-sheet-title">Build Mode</div>
          <nav className="bm-tabs scroll-tabs" aria-label="Build Mode sections">
            {TABS.map((t) => (
              <button key={t.id} type="button" className={`bm-tab${tab === t.id ? ' is-active' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => onTab?.(t.id)}>{t.label}</button>
            ))}
          </nav>
          <button type="button" className="bm-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="bm-sheet-body">
          {tab === 'queue' && <QueueTab notes={notes} dismissed={dismissed} sessions={sessions} loading={loading} onOpenPin={onOpenPin} onChanged={replace} onDispatched={() => { load(); onDispatched?.(); }} myEmail={myEmail} settings={settings || {}} onSettings={onSettings} />}
          {tab === 'sessions' && <SessionsTab sessions={sessions} stats={stats} loading={loading} onChanged={replaceSession} />}
          {tab === 'settings' && <SettingsTab settings={settings || {}} onSettings={onSettings} />}
        </div>
      </div>
    </div>
  );
}
