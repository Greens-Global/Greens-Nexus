// The Build Mode panel: a 60vw sheet (full screen on phones) with Queue /
// Sessions / Settings. Queue = pins grouped by Build Session with Send To
// Claude Code at the top; Sessions = every session with its PR and a Stats
// strip; Settings = Send Instantly, Dispatch Target, Pins On Load, Build
// Tokens and the watcher one-liner for VS Code.
import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Send, ExternalLink, Copy, Check, Loader2, Trash2, Pencil, RotateCcw, KeyRound, MessageSquare, Download, ChevronDown, Plug } from 'lucide-react';
import { api, API_BASE } from '../api';
import { graphTokenSilent, listMyChats } from '../teamsGraph';
import { formatDateTime, formatDate } from '../lib/datetime';
import { toViewUrl } from '../lib/storageView';
import { useIsMobile } from '../lib/useIsMobile';
import { StatusLabel } from '../components/StatusLabel';
import HoldButton from '../ui/HoldButton';
import { pinMeta, pinReady, pinHeld, pinReopened, isLocalPreview, sessionMeta, READY_META, HELD_COLOR, KIND_META, PRIORITY_META, firstNameOf, WATCHER_COMMAND, CLAUDE_SEND_ON } from './meta';
import { toast, useBuildStore, setAllTools } from './store';
import { MODULES } from '../contexts/RoleContext';
import { wantsTabCapture, setWantsTabCapture, startTabCapture, stopTabCapture } from './lib/screenshot';

// Settings comes back with Send to Claude Code (meta.CLAUDE_SEND_ON).
const TABS = [{ id: 'queue', label: 'Queue' }, { id: 'sessions', label: 'Sessions' }, ...(CLAUDE_SEND_ON ? [{ id: 'settings', label: 'Settings' }] : [])];

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
  const m = pinMeta(pin);
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
          {pinReady(pin) && isLocalPreview(pin.preview?.url) && <a className="bm-link" href={pin.preview.url} target="_blank" rel="noreferrer"><ExternalLink size={11} /> Open Preview</a>}
          {pin.videoUrl && <a className="bm-link" href={toViewUrl(pin.videoUrl)} target="_blank" rel="noreferrer"><ExternalLink size={11} /> Video</a>}
        </div>
        <button type="button" className="bm-row-comment" onClick={() => onOpen?.(pin)} title="Open this pin where it was made">
          {pin.comment || pin.edit?.note || <span className="bm-dim">(no comment)</span>}
        </button>
        <div className="bm-row-meta">
          <span>{firstNameOf(pin.createdBy)}</span><span className="bm-dot-sep" /><span>{pin.route}{pin.sub ? ` › ${pin.sub}` : ''}</span><span className="bm-dot-sep" /><span>{formatDateTime(pin.createdAt)}</span>
          {pinReopened(pin) && <><span className="bm-dot-sep" /><span>Reopened - Claude Code is on it</span></>}
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

// Post To Teams (Pranshu, Oct 26 2026): your open pins - on every screen - as
// ONE card in a Teams chat you pick (any group or person you chat with; your
// own list, loaded through the server's delegated token like
// TeamsTargetPicker, MSAL only as the fallback), screenshots inline. Nothing
// goes to Claude Code. The pick is remembered in your Build Mode settings;
// the first Post opens the list and picking a chat posts.
function TeamsPost({ settings, onSettings, count = 0, onPosted, primary = false, autoOpen = false }) {
  const [chats, setChats] = useState(null);     // null = not loaded
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [postOnPick, setPostOnPick] = useState(false);
  const [posting, setPosting] = useState(false);
  const picked = settings?.teamsChatId || '';
  const pickedName = settings?.teamsChatName || '';
  const post = async (id, name) => {
    setPosting(true);
    try {
      const r = await api.devNotesTeamsPost({ teamsChatId: id, teamsChatName: name });
      const n = r?.posted || 0;
      toast(`${n} pin${n === 1 ? '' : 's'} posted to ${r?.chatName || name || 'Teams'}`);
      onPosted?.();
    } catch (e) { toast(e?.message || 'Nothing was posted.'); }
    finally { setPosting(false); }
  };
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
    try { await onSettings?.({ teamsChatId: c.id, teamsChatName: c.name || '' }); }
    catch (e) { toast(e?.message || 'The chat was not saved.'); }
    if (postOnPick) { setPostOnPick(false); await post(c.id, c.name || ''); }
  };
  const openList = (thenPost) => { setPostOnPick(thenPost); setOpen((o) => !o); load(); };
  // Opened from Done (Oct 27): pick a chat and it posts - or, with one picked
  // already, Post is the button in focus.
  const postRef = useRef(null);
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoOpen || !count || autoDone.current) return undefined;   // once, when the pins have loaded
    autoDone.current = true;
    if (!picked) { openList(true); return undefined; }
    const t = setTimeout(() => postRef.current?.focus(), 60);   // after the sheet takes focus on open
    return () => clearTimeout(t);
  }, [autoOpen, count > 0]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="bm-chat-pick">
      <span className="bm-split">
        <button ref={postRef} type="button" className={`bm-btn bm-btn-sm${primary ? ' bm-btn-primary' : ''}`} disabled={!count || posting}
          onClick={() => (picked ? post(picked, pickedName) : openList(true))}
          title={count ? 'Post your open pins, with their screenshots, to a Teams chat - a group or a person' : 'Nothing to post yet'}>
          {posting ? <Loader2 size={13} className="bm-spin" /> : <MessageSquare size={13} />} {picked ? `Post To Teams - ${pickedName || 'chat'}` : 'Post To Teams'}
        </button>
        <button type="button" className="bm-btn bm-btn-sm bm-split-more" onClick={() => openList(false)} aria-expanded={open} aria-haspopup="listbox"
          aria-label="Pick the Teams chat" title="Pick the Teams chat"><ChevronDown size={13} /></button>
      </span>
      {open && (
        <div className="bm-chat-menu" role="listbox" aria-label="Teams chat">
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

// Your own Claude Code (Oct 26 2026): Send To Claude Code goes only to the
// sender's watcher, so the Queue says whether it is there, and connecting is
// one button and one line pasted into a VS Code terminal (tools/build_notes/
// connect.py: saves the token and this Nexus's API, adds the VS Code task that
// starts the watcher with the folder, starts it in that terminal).
export function connectCommand(token, apiBase) {
  const win = typeof navigator !== 'undefined' && /Win/.test(navigator.platform || navigator.userAgent || '');
  return `${win ? 'python' : 'python3'} tools/build_notes/connect.py ${token} --api ${apiBase}`;
}

// The API this page itself talks to is the Nexus the person is on, so it
// wins; the server's own public address (claude.apiBase) only when the page
// uses a relative /api (cookie mode). The server's answer alone was wrong
// locally: a laptop's NEXUS_API_BASE points at the dev API.
function apiBaseFor(claude) {
  if (API_BASE && /^https?:\/\//.test(API_BASE)) return API_BASE.replace(/\/+$/, '');
  if (claude?.apiBase) return claude.apiBase.replace(/\/+$/, '');
  try { return new URL(API_BASE || '', window.location.href).href.replace(/\/+$/, ''); } catch { return ''; }
}

function ConnectClaude({ claude }) {
  const [minted, setMinted] = useState(null);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try { setMinted(await api.devNotesTokenCreate(`Claude Code ${formatDate(new Date())}`)); }
    catch (e) { toast(e?.message || 'Could not start the connection.'); }
    finally { setBusy(false); }
  };
  if (claude?.connected) {
    return <div className="bm-connect is-ok" data-testid="bm-claude-connected"><span className="bm-claude-dot" /> Your Claude Code is connected - Send To Claude Code starts it in your VS Code terminal.</div>;
  }
  const cmd = minted?.token ? connectCommand(minted.token, apiBaseFor(claude)) : '';
  return (
    <div className="bm-connect" data-testid="bm-connect">
      <div className="bm-sec-title"><Plug size={13} /> Connect Your Claude Code - Once</div>
      {!minted ? (
        <>
          <div className="bm-small bm-dim">Send To Claude Code starts Claude Code in YOUR VS Code terminal - nobody else&apos;s. Connect it once on this computer.</div>
          <button type="button" className="bm-btn bm-btn-primary" onClick={connect} disabled={busy}>{busy ? <Loader2 size={14} className="bm-spin" /> : <Plug size={14} />} Connect My Claude Code</button>
        </>
      ) : (
        <>
          <ol className="bm-steps bm-small">
            <li>Open the Nexus folder in VS Code.</li>
            <li>Open a terminal there (Ctrl+`) and paste this line:</li>
          </ol>
          <div className="bm-code-row"><code className="bm-code">{cmd}</code><CopyButton text={cmd} label="Copy" /></div>
          <div className="bm-small bm-dim">Leave that terminal open. From now on VS Code starts it whenever you open the folder (it asks once to allow that).</div>
          <div className="bm-small"><Loader2 size={12} className="bm-spin" /> Waiting for your Claude Code…</div>
        </>
      )}
    </div>
  );
}

// Save Report: one HTML file of a Build Session - every pin, its module,
// comment and marked-up shot - that opens anywhere, no login, attaches to an email.
async function downloadReport(sessionId) {
  try {
    const { blob, filename } = await api.devNotesSessionReport(sessionId);
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename || 'Build Session.html' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { toast(e?.message || 'The report could not be saved.'); }
}

const ROUTE_LABEL = Object.fromEntries((MODULES || []).map((m) => [m.id, m.label]));

function QueueTab({ notes, dismissed, sessions, loading, onOpenPin, onChanged, onDispatched, myEmail, settings, onSettings, postFromDone = false }) {
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const claude = useBuildStore((st) => st.claude);
  const notConnected = claude?.connected === false;     // null = not known yet: Send as before
  const [showDismissed, setShowDismissed] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const bySession = new Map();
  for (const n of notes) { const k = n.sessionId || ''; if (!bySession.has(k)) bySession.set(k, []); bySession.get(k).push(n); }
  const sessionOf = (id) => sessions.find((s) => s.id === id);
  const groups = [...bySession.entries()].map(([id, pins]) => ({ id, pins, session: sessionOf(id) }))
    .sort((a, b) => {
      const ac = a.session?.status === 'collecting' ? 0 : 1, bc = b.session?.status === 'collecting' ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return String(b.session?.createdAt || b.pins[0]?.createdAt || '').localeCompare(String(a.session?.createdAt || a.pins[0]?.createdAt || ''));
    });
  // Sessions already sent or done fold away under Sent And Completed (Pranshu,
  // Oct 27) - unless a pin in them still waits on someone: not sent yet,
  // Needs Input, or Ready To Check.
  const waiting = (p) => p.status === 'open' || p.status === 'needs_input' || pinReady(p);
  const activeGroups = groups.filter((g) => g.pins.some(waiting));
  const sentGroups = groups.filter((g) => !g.pins.some(waiting));
  const queued = activeGroups.reduce((n, g) => n + g.pins.length, 0);
  // Every open pin of mine, whatever its session's status (v2: dispatch moves
  // held pins to a new collecting session). A pin on someone else's area
  // waits for them - never sent from here.
  const mineAll = notes.filter((n) => n.status === 'open' && (!myEmail || n.createdBy === myEmail));
  const mineOpen = mineAll.filter((n) => !pinHeld(n));
  const mineHeld = mineAll.filter(pinHeld);
  const canSend = mineOpen.length > 0;
  // No bell fires when a pin turns Ready To Check (the PR bell is the prompt),
  // so the Queue says it up top: the author's pins waiting on their check.
  const mineReady = notes.filter((n) => pinReady(n) && (!myEmail || n.createdBy === myEmail));
  const heldLine = mineHeld.map((n) => `Pin #${n.number} waits for ${n.ownerName || firstNameOf(n.ownerEmail)}`).join(', ');
  // Where your comments are, by module ("Tasks 3 · Tickets 2"), and the
  // session they collect in - Save Report saves that one.
  const byModule = Object.entries(mineAll.reduce((m, n) => ({ ...m, [n.route || 'other']: (m[n.route || 'other'] || 0) + 1 }), {}))
    .map(([r, c]) => `${ROUTE_LABEL[r] || r} ${c}`).join(' · ');
  const reportSession = mineAll[0]?.sessionId || '';
  const report = async () => { setReporting(true); await downloadReport(reportSession); setReporting(false); };
  const send = async () => {
    setSending(true);
    try {
      const r = await api.devNotesDispatch({});
      const n = Array.isArray(r?.notes) ? r.notes.length : 0;   // the server's count, nothing guessed
      const held = Array.isArray(r?.held) ? r.held : [];
      const waits = held.map((h) => `Pin #${h.number} waits for ${h.ownerName || 'its owner'}`).join('; ');
      const sentLine = `${n} pin${n === 1 ? '' : 's'} sent`;
      toast(waits ? `${sentLine} - ${waits}` : n ? `${sentLine} to Claude Code` : 'Build Session sent to Claude Code');
      onDispatched?.();
    }
    catch (e) { toast(e?.message || 'Nothing was sent.'); }
    finally { setSending(false); }
  };
  const renderGroup = ({ id, pins, session }) => {
    const sm = sessionMeta(session?.status || 'collecting');
    return (
      <section key={id || 'none'} className="bm-group">
        <header className="bm-group-head">
          <span className="bm-group-title">{session?.title || 'Build Session'}</span>
          <StatusLabel label={sm.label} color={sm.color} size="sm" />
          <span className="bm-dim bm-small">{pins.length} pin{pins.length === 1 ? '' : 's'}</span>
          {pins.filter(pinReady).length > 0 && <StatusLabel label={`${pins.filter(pinReady).length} Ready To Check`} color={READY_META.color} size="sm" />}
          {pins.filter(pinHeld).length > 0 && <StatusLabel label={`${pins.filter(pinHeld).length} Waiting For Owner`} color={HELD_COLOR} size="sm" />}
          {session?.prUrl && <a className="bm-link" href={session.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={11} /> PR #{session.prNumber}</a>}
        </header>
        {pins.sort((a, b) => (a.number || 0) - (b.number || 0)).map((p) => <PinRow key={p.id} pin={p} onOpen={onOpenPin} onChanged={onChanged} />)}
      </section>
    );
  };
  return (
    <>
      <div className="bm-queue-head">
        <div>
          <div className="bm-h2">{queued} pin{queued === 1 ? '' : 's'} in the queue</div>
          <div className="bm-dim bm-small">{!CLAUDE_SEND_ON
            ? (mineAll.length ? `${mineAll.length} of yours ready to post - pick a Teams chat and Post.` : 'Nothing of yours to post yet - comment on something first.')
            : canSend ? `${mineOpen.length} of yours ready to send.` : mineHeld.length ? 'Nothing of yours to send to Claude Code.' : 'Your collecting session is empty - pin something first.'}{CLAUDE_SEND_ON && heldLine ? ` ${heldLine}.` : ''}</div>
          {byModule && <div className="bm-small" data-testid="bm-by-module">{byModule}</div>}
        </div>
        {mineReady.length > 0 && (
          <button type="button" className="bm-ready-note" onClick={() => onOpenPin?.(mineReady[0])} data-testid="bm-ready-count" title="Open the first one">
            <StatusLabel label={`${mineReady.length} Ready To Check`} color={READY_META.color} size="sm" />
            <span className="bm-small">{mineReady.length === 1 ? 'Pin' : 'Pins'} {mineReady.map((n) => `#${n.number}`).join(', ')} - open on the preview and Accept or Reopen.</span>
          </button>
        )}
        <TeamsPost settings={settings} onSettings={onSettings} count={mineAll.length} onPosted={onDispatched} primary={!CLAUDE_SEND_ON} autoOpen={postFromDone && !CLAUDE_SEND_ON} />
        <button type="button" className="bm-btn bm-btn-sm" onClick={report} disabled={!reportSession || reporting} title="Save one HTML file with every comment and screenshot">
          {reporting ? <Loader2 size={13} className="bm-spin" /> : <Download size={13} />} Save Report
        </button>
        {CLAUDE_SEND_ON && notConnected && (
          <button type="button" className="bm-btn bm-btn-primary" onClick={() => document.querySelector('[data-testid="bm-connect"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
            title="Your Claude Code is not listening on this computer - connect it once (below)">
            <Plug size={14} /> Connect Claude Code First
          </button>
        )}
        {CLAUDE_SEND_ON && !notConnected && (
          <button type="button" className="bm-btn bm-btn-primary" onClick={send} disabled={!canSend || sending} title={canSend ? 'Starts Claude Code in your own VS Code terminal' : 'Nothing to send yet'}>
            {sending ? <Loader2 size={14} className="bm-spin" /> : <Send size={14} />} Send To Claude Code
          </button>
        )}
      </div>
      {CLAUDE_SEND_ON && claude && <ConnectClaude claude={claude} />}
      <div className="bm-list nx-fill" data-testid="bm-queue">
        {loading && !notes.length && <div className="bm-dim">Loading…</div>}
        {!loading && !notes.length && <div className="bm-empty">No pins yet. Press P, click anything on the page and say what should change.</div>}
        {activeGroups.map(renderGroup)}
        {sentGroups.length > 0 && (
          <section className="bm-group" data-testid="bm-sent-groups">
            <header className="bm-group-head">
              <button type="button" className="bm-link-btn" onClick={() => setShowSent((v) => !v)} aria-expanded={showSent}>{showSent ? 'Hide' : 'Show'} Sent And Completed ({sentGroups.reduce((n, g) => n + g.pins.length, 0)})</button>
            </header>
          </section>
        )}
        {showSent && sentGroups.map(renderGroup)}
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

function SessionRow({ s, onChanged, counts }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title || '');
  const [saving, setSaving] = useState(false);
  const m = sessionMeta(s.status);
  const report = async () => { setSaving(true); await downloadReport(s.id); setSaving(false); };
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
          {counts?.ready > 0 && <StatusLabel label={`${counts.ready} Ready To Check`} color={READY_META.color} size="sm" />}
          {counts?.held > 0 && <StatusLabel label={`${counts.held} Waiting For Owner`} color={HELD_COLOR} size="sm" />}
        </div>
        <div className="bm-row-meta">
          <span>{s.noteCount ?? 0} pin{(s.noteCount ?? 0) === 1 ? '' : 's'}</span><span className="bm-dot-sep" /><span>{firstNameOf(s.createdBy)}</span><span className="bm-dot-sep" /><span>{formatDateTime(s.createdAt)}</span>
          {s.dispatchedAt && <><span className="bm-dot-sep" /><span>sent {formatDateTime(s.dispatchedAt)}</span></>}
          {s.branch && <><span className="bm-dot-sep" /><code>{s.branch}</code></>}
        </div>
      </div>
      <button type="button" className="bm-btn bm-btn-sm" onClick={report} disabled={saving || !(s.noteCount > 0)} title="Save one HTML file with every pin, comment and screenshot">
        {saving ? <Loader2 size={13} className="bm-spin" /> : <Download size={13} />} Save Report
      </button>
      {s.prUrl && <a className="bm-btn bm-btn-sm" href={s.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> PR #{s.prNumber}</a>}
    </div>
  );
}

function SessionsTab({ sessions, notes = [], stats, loading, onChanged }) {
  // Per session (v2): how many pins wait on the author's check and how many
  // on the owner of their area - counted from the pins the Panel loaded.
  const counts = {};
  for (const n of notes) {
    const c = counts[n.sessionId || ''] || (counts[n.sessionId || ''] = { ready: 0, held: 0 });
    if (pinReady(n)) c.ready += 1;
    else if (pinHeld(n)) c.held += 1;
  }
  return (
    <>
      <Stats stats={stats} />
      <div className="bm-list nx-fill">
        {loading && !sessions.length && <div className="bm-dim">Loading…</div>}
        {!loading && !sessions.length && <div className="bm-empty">No Build Sessions yet - the first pin starts one.</div>}
        {sessions.map((s) => <SessionRow key={s.id} s={s} onChanged={onChanged} counts={counts[s.id]} />)}
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
  const load = useCallback(() => api.devNotesTokens().then((t) => setTokens(Array.isArray(t) ? t : [])).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const mint = async () => {
    setBusy(true);
    try { const r = await api.devNotesTokenCreate(label.trim() || 'My Computer'); setMinted(r); setLabel(''); load(); }
    catch (e) { toast(e?.message || 'The token could not be minted.'); }
    finally { setBusy(false); }
  };
  // Revoke is held on the row (Hold to confirm, Neil, Oct 30 2026): one
  // token, so the inline Revoke? / Keep step goes; a refusal rewinds the
  // button with the reason; the list re-reads once the check has shown.
  const revoke = async (id) => {
    try { await api.devNotesTokenRevoke(id); if (minted?.id === id) setMinted(null); toast('Token revoked'); }
    catch (e) { throw new Error(e?.message || 'The token could not be revoked.'); }
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
              <HoldButton size="sm" label="Revoke" doneLabel="Revoked" onConfirm={() => revoke(t.id)} onDone={() => load()} disabled={busy}
                ariaLabel={`Revoke ${t.label || 'Token'}`} fallbackMessage={`Revoke "${t.label || 'Token'}"? Anything using it can no longer act as you.`} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsTab({ settings, onSettings }) {
  const [busy, setBusy] = useState('');
  const [tabCapture, setTabCapture] = useState(wantsTabCapture);   // per browser, like the draft
  const allTools = useBuildStore((s) => s.allTools);
  const claude = useBuildStore((s) => s.claude);
  const change = async (patch) => {
    setBusy(Object.keys(patch)[0]);
    try { await onSettings(patch); } catch (e) { toast(e?.message || 'The setting was not saved.'); } finally { setBusy(''); }
  };
  return (
    <div className="bm-settings nx-fill">
      {claude && <section className="bm-settings-sec"><ConnectClaude claude={claude} /></section>}
      <section className="bm-settings-sec">
        <div className="bm-sec-title">Sending</div>
        <Switch label="Send Instantly" hint="On: every pin goes to Claude Code the moment you save it. Off: pins collect in your Build Session and go together when you click Done > Send To Claude Code." checked={!!settings.sendInstantly} disabled={busy === 'sendInstantly'} onChange={(v) => change({ sendInstantly: v })} />
        <Switch label="Collect Fixes Into One PR" hint={'On: Claude Code keeps every batch you send on one branch and waits in its terminal for the next one. Type "open a PR" there when you are done and all of it goes in one PR.'} checked={!!settings.onePr} disabled={busy === 'onePr'} onChange={(v) => change({ onePr: v })} />
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
        <Switch label="Higher Quality Screenshots" hint="Screenshots are taken from the page automatically. On = Chrome asks once to share this tab, for an exact picture (charts, embedded files)." checked={tabCapture}
          onChange={(v) => { setWantsTabCapture(v); setTabCapture(v); if (v) startTabCapture(); else stopTabCapture(); }} />
        <Switch label="Show All Tools" hint="The whole strip: every drawing tool, Edit, Hide Pins and the Queue. Off = the simple strip - Browse, Comment, Draw, Talk, Record and Done." checked={allTools} onChange={setAllTools} />
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
export default function Panel({ open, tab: asked = 'queue', onTab, onClose, settings, onSettings, onOpenPin, version = 0, onDispatched, myEmail = '', postFromDone = false }) {
  const tab = TABS.some((t) => t.id === asked) ? asked : 'queue';
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
          {tab === 'queue' && <QueueTab notes={notes} dismissed={dismissed} sessions={sessions} loading={loading} onOpenPin={onOpenPin} onChanged={replace} onDispatched={() => { load(); onDispatched?.(); }} myEmail={myEmail} settings={settings || {}} onSettings={onSettings} postFromDone={postFromDone} />}
          {tab === 'sessions' && <SessionsTab sessions={sessions} notes={notes} stats={stats} loading={loading} onChanged={replaceSession} />}
          {tab === 'settings' && <SettingsTab settings={settings || {}} onSettings={onSettings} />}
        </div>
      </div>
    </div>
  );
}
