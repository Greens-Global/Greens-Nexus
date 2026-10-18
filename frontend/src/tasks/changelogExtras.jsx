// What's New, the parts beyond the feed (Oct 16 2026): rich text and video,
// threaded comments with @mentions, helpful votes and feature requests,
// following + the weekly digest + the private RSS feed, edit history, bulk
// actions, insights (read rate, trends, most-reacted), CSV export, version
// numbering, and the "New on this screen" hint App.jsx shows on any view.
// ChangelogView.jsx composes these; the server side is
// backend/routers/changelog_extras.py + changelog_reach.py.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, CornerDownRight, ThumbsUp, ThumbsDown, Lightbulb, Rss, Copy, RefreshCw, Bell, Download,
  Printer, X, Sparkles, ArrowRight, AlertTriangle, History, Link2, CalendarX, Compass,
} from 'lucide-react';
import { api } from '../api';
import { MODULES } from '../contexts/RoleContext';
import { NX, FONT, btn, card, chip, input as inputStyle } from './theme';
import { Avatar, Modal, usePeople, useIsMobile } from './components';
import { LoadingState } from '../components/AsyncState';
import { formatDateTime, formatFullDate } from './changelogDates';
import { RequestStatusChip, RequestStatusEditor, REQUEST_STATUSES, TourHost, startTour } from './changelogLifecycle';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Rich text ──────────────────────────────────────────────────────────────
// Descriptions are Markdown (bold, lists, links, tables). The parser loads
// only when an update is actually shown; until then the plain text is.
const MarkdownBody = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'), import('remark-gfm'),
  ]);
  return {
    default: ({ children }) => (
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: NX.blue }}>{c}</a> }}>
        {children}
      </ReactMarkdown>
    ),
  };
});

export function RichText({ text, style }) {
  if (!text) return null;
  const plain = <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>;
  return (
    <div className="nx-md" style={{ fontSize: 13.5, lineHeight: 1.6, color: NX.ink, ...style }}>
      <Suspense fallback={plain}><MarkdownBody>{text}</MarkdownBody></Suspense>
    </div>
  );
}

// ── Video / GIF demos ──────────────────────────────────────────────────────
// YouTube, Vimeo and Loom play inline (the CSP's frame-src allows them);
// a video file in our storage plays in a <video>; anything else is a link.
export function embedOf(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  let m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
  if (m) return { kind: 'frame', src: `https://www.youtube-nocookie.com/embed/${m[1]}` };
  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { kind: 'frame', src: `https://player.vimeo.com/video/${m[1]}` };
  m = u.match(/loom\.com\/(?:share|embed)\/([\w-]+)/);
  if (m) return { kind: 'frame', src: `https://www.loom.com/embed/${m[1]}` };
  if (/\.(mp4|webm|mov)(\?|$)/i.test(u) && /supabase\.co\//.test(u)) return { kind: 'video', src: u };
  if (/^https?:\/\//.test(u)) return { kind: 'link', src: u };
  return null;
}

export function VideoEmbed({ url }) {
  const e = embedOf(url);
  if (!e) return null;
  const box = { width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 10, background: '#000' };
  if (e.kind === 'frame') return <iframe title="Demo video" src={e.src} style={box} allow="fullscreen; picture-in-picture" allowFullScreen />;
  if (e.kind === 'video') return <video src={e.src} controls style={box} />;
  return <a href={e.src} target="_blank" rel="noreferrer" style={{ color: NX.blue, fontSize: 13 }}>Watch the demo</a>;
}

// ── Breaking change / action required ──────────────────────────────────────
export function ActionRequired({ entry, compact = false }) {
  if (!entry.breaking && !entry.actionRequired) return null;
  return (
    <div role="note" style={{
      marginTop: compact ? 8 : 12, display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 8,
      background: 'rgba(220,38,38,0.10)', color: '#b91c1c', padding: '9px 12px', fontSize: 13,
    }}>
      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span><strong>{entry.breaking ? 'Breaking Change' : 'Action Required'}</strong>{entry.actionRequired ? `: ${entry.actionRequired}` : ''}</span>
    </div>
  );
}

// ── Version numbering ──────────────────────────────────────────────────────
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
export function latestSemver(entries) {
  let best = null;
  for (const e of entries || []) {
    const m = String(e.version || '').match(SEMVER);
    if (!m) continue;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || v[0] > best[0] || (v[0] === best[0] && (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))) best = v;
  }
  return best;
}
export function nextVersions(entries) {
  const [a, b, c] = latestSemver(entries) || [1, 0, 0];
  return { patch: `v${a}.${b}.${c + 1}`, minor: `v${a}.${b + 1}.0`, major: `v${a + 1}.0.0` };
}

// ── Copy a link to one update ──────────────────────────────────────────────
export const entryLink = (id) => `${window.location.origin}/whats-new?entry=${encodeURIComponent(id)}`;
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
export function CopyLinkButton({ entryId, onCopied, label = 'Copy Link' }) {
  return (
    <button type="button" onClick={async (e) => { e.stopPropagation(); const ok = await copyText(entryLink(entryId)); onCopied?.(ok); }}
      style={{ ...btn('ghost'), padding: 0, color: NX.dim, fontSize: 12 }} aria-label={`${label} to this update`}>
      <Link2 size={13} />{label}
    </button>
  );
}

// ── Comments: threads, replies, @mentions ──────────────────────────────────
// @ opens a people picker; the picked person is written as @Name and sent
// in `mentions`, so the server can ring their bell.
function MentionBox({ value, onChange, setMentions, onSubmit, placeholder, autoFocus, disabled }) {
  const people = usePeople();
  const ref = useRef(null);
  const [query, setQuery] = useState(null);     // text after "@", or null
  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.includes(q)).slice(0, 6);
  }, [people, query]);
  const [hi, setHi] = useState(0);
  const onText = (v) => {
    onChange(v);
    const caret = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/(?:^|\s)@([\w.\- ]{0,30})$/);
    setQuery(m ? m[1] : null);
    setHi(0);
    if (ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`; }
  };
  const pick = (p) => {
    const caret = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([\w.\- ]{0,30})$/, `@${p.name} `);
    onChange(before + value.slice(caret));
    setMentions((m) => (m.includes(p.email) ? m : [...m, p.email]));
    setQuery(null);
    window.setTimeout(() => ref.current?.focus(), 0);
  };
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <textarea ref={ref} value={value} rows={1} autoFocus={autoFocus} disabled={disabled}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[hi]); return; }
            if (e.key === 'Escape') { setQuery(null); return; }
          }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
        }}
        placeholder={placeholder} aria-label="Add a comment"
        style={{ ...inputStyle, resize: 'none', minHeight: 38, lineHeight: 1.4, fontFamily: FONT }} />
      {matches.length > 0 && (
        <div role="listbox" aria-label="Mention someone" style={{
          position: 'absolute', left: 0, bottom: '100%', marginBottom: 4, zIndex: 20, minWidth: 240, maxWidth: '100%',
          background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.18)', padding: '4px 0',
        }}>
          {matches.map((p, i) => (
            <button key={p.email} type="button" role="option" aria-selected={i === hi} onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left',
                background: i === hi ? 'rgba(37,99,235,0.10)' : 'transparent', padding: '6px 10px', fontFamily: FONT, fontSize: 13, color: NX.ink }}>
              <Avatar email={p.email} name={p.name} size={20} card={false} /><span>{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ entryId, parentId, onPosted, autoFocus, placeholder = 'Write a comment… (@ to mention)' }) {
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState([]);
  const [posting, setPosting] = useState(false);
  const post = async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      // Only names still in the text count as mentions.
      const kept = mentions.filter(Boolean);
      await api.addTaskChangelogComment(entryId, { body: text, ...(parentId ? { parentId } : {}), ...(kept.length ? { mentions: kept } : {}) });
      setDraft(''); setMentions([]);
      await onPosted?.();
    } catch { /* the text stays in the box to try again */ } finally { setPosting(false); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <MentionBox value={draft} onChange={setDraft} setMentions={setMentions} onSubmit={post}
        placeholder={placeholder} autoFocus={autoFocus} />
      <button onClick={post} disabled={!draft.trim() || posting} aria-label="Post comment"
        style={{ ...btn('primary'), padding: 9, flexShrink: 0, opacity: draft.trim() && !posting ? 1 : 0.4 }}><Send size={15} /></button>
    </div>
  );
}

// "@Amy Bolanos" in a comment shows as a mention when Amy was mentioned.
function CommentBody({ body, mentions, nameOf }) {
  const names = (mentions || []).map((m) => nameOf(m)).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return <>{body}</>;
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = String(body).split(new RegExp(`(@(?:${esc.join('|')}))`, 'g'));
  return <>{parts.map((p, i) => (p.startsWith('@') && names.includes(p.slice(1))
    ? <span key={i} style={{ color: NX.blue, fontWeight: 600 }}>{p}</span> : <span key={i}>{p}</span>))}</>;
}

function OneComment({ c, nameOf, canComment, onReply, small }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <Avatar email={c.authorId} name={nameOf(c.authorId)} size={small ? 22 : 24} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ borderRadius: 8, background: NX.surface2, padding: '7px 11px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId)}</span>
            {c.createdAt && <span style={{ fontSize: 11, color: NX.faint }}>{formatDateTime(c.createdAt)}</span>}
          </div>
          <div style={{ marginTop: 2, fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap' }}>
            <CommentBody body={c.body} mentions={c.mentions} nameOf={nameOf} />
          </div>
        </div>
        {canComment && onReply && (
          <button type="button" onClick={onReply} style={{ ...btn('ghost'), padding: '2px 0 0', fontSize: 12, color: NX.dim }}>
            <CornerDownRight size={12} />Reply
          </button>
        )}
      </div>
    </div>
  );
}

// The whole conversation on an update: top-level comments in order, each
// with its replies under it, a Reply box per thread, and a box for a new one.
// `open` false shows only the box (the card's resting state).
export function CommentThread({ entryId, canComment, nameOf, open = true, onCount, onPosted, compact = false }) {
  const [comments, setComments] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const load = () => api.getTaskChangelogComments(entryId)
    .then((r) => { setComments(r || []); onCount?.((r || []).length); })
    .catch(() => setComments((c) => c || []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) load(); }, [entryId, open]);
  const sorted = (comments || []).slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const tops = sorted.filter((c) => !c.parentId || !sorted.some((x) => x.id === c.parentId));
  const repliesOf = (id) => sorted.filter((c) => c.parentId === id);
  const posted = async () => { if (open) await load(); else onPosted?.(); };
  return (
    <div data-card-comments style={{ display: 'flex', flexDirection: 'column', gap: 10, ...(compact ? { marginTop: 12, borderTop: `1px solid ${NX.border}`, paddingTop: 12 } : null) }}>
      {open && (comments === null ? <LoadingState /> : tops.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.dim }}>No comments yet. Be the first to add one.</div>
      ) : tops.map((c) => (
        <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <OneComment c={c} nameOf={nameOf} canComment={canComment} onReply={() => setReplyTo(replyTo === c.id ? null : c.id)} />
          {(repliesOf(c.id).length > 0 || replyTo === c.id) && (
            <div style={{ marginLeft: 34, display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `2px solid ${NX.border}`, paddingLeft: 10 }}>
              {repliesOf(c.id).map((r) => <OneComment key={r.id} c={r} nameOf={nameOf} small canComment={canComment} onReply={() => setReplyTo(c.id)} />)}
              {replyTo === c.id && canComment && (
                <Composer entryId={entryId} parentId={c.id} autoFocus placeholder={`Reply to ${nameOf(c.authorId)}…`}
                  onPosted={async () => { setReplyTo(null); await load(); }} />
              )}
            </div>
          )}
        </div>
      )))}
      {canComment && <Composer entryId={entryId} onPosted={posted} />}
    </div>
  );
}

// ── Was this helpful? / Request a feature ──────────────────────────────────
export function FeedbackRow({ entry, onDone }) {
  const [state, setState] = useState(null);       // {yes, no, mine}
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let live = true;
    api.getTaskChangelogFeedback?.(entry.id)?.then?.((r) => { if (live) setState(r); })?.catch?.(() => {});
    return () => { live = false; };
  }, [entry.id]);
  const vote = async (helpful) => {
    try { setState(await api.sendTaskChangelogFeedback(entry.id, { kind: 'helpful', helpful })); } catch { /* keep */ }
  };
  const request = async () => {
    if (!note.trim()) return;
    try {
      await api.sendTaskChangelogFeedback(entry.id, { kind: 'request', note: note.trim() });
      setNote(''); setAsking(false); setSent(true); onDone?.('Thanks - your request went to the Nexus team.');
    } catch { /* keep the text */ }
  };
  const mine = state?.mine;
  const pill = (on) => ({ ...btn('outline'), padding: '3px 10px', fontSize: 12, ...(on ? { borderColor: NX.blue, color: NX.blue, background: 'rgba(37,99,235,0.10)' } : null) });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: NX.dim }}>
        <span>Was this helpful?</span>
        <button type="button" aria-pressed={mine === true} onClick={() => vote(true)} style={pill(mine === true)}><ThumbsUp size={12} />Yes{state?.yes ? ` (${state.yes})` : ''}</button>
        <button type="button" aria-pressed={mine === false} onClick={() => vote(false)} style={pill(mine === false)}><ThumbsDown size={12} />No{state?.no ? ` (${state.no})` : ''}</button>
        <button type="button" onClick={() => setAsking((a) => !a)} style={{ ...btn('ghost'), padding: 0, fontSize: 12, color: NX.blue, marginLeft: 'auto' }}>
          <Lightbulb size={13} />{sent ? 'Request Another Feature' : 'Request a Feature'}
        </button>
      </div>
      {asking && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus aria-label="Feature request"
            placeholder="What would make this better for you?" style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
          <button type="button" onClick={request} disabled={!note.trim()} style={{ ...btn('primary'), opacity: note.trim() ? 1 : 0.5 }}>Send</button>
        </div>
      )}
    </div>
  );
}

// ── Related updates ────────────────────────────────────────────────────────
export const RELATION_LABELS = { related: 'Related', followup: 'Follow-up To', reverts: 'Reverts', replaces: 'Replaces' };
export function RelatedUpdates({ entry, all, onOpen }) {
  const rel = (entry.relatedIds || []).map((r) => ({ ...r, other: (all || []).find((x) => x.id === r.id) })).filter((r) => r.other);
  const back = (all || []).filter((x) => (x.relatedIds || []).some((r) => r.id === entry.id) && !rel.some((r) => r.id === x.id));
  if (!rel.length && !back.length) return null;
  const row = (key, label, other) => (
    <button key={key} type="button" onClick={() => onOpen?.(other)} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', cursor: 'pointer', border: `1px solid ${NX.border}`,
      borderRadius: 8, background: 'transparent', padding: '8px 12px', fontFamily: FONT, fontSize: 13, color: NX.ink }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{other.title}</span>
      <ArrowRight size={13} style={{ color: NX.faint }} />
    </button>
  );
  return (
    <div>
      <h3 style={{ margin: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint }}>Related Updates</h3>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rel.map((r) => row(r.id, RELATION_LABELS[r.kind] || 'Related', r.other))}
        {back.map((o) => row(`b-${o.id}`, 'Referenced By', o))}
      </div>
    </div>
  );
}

// ── Edit history (admins) ──────────────────────────────────────────────────
const ACTION_WORDS = { created: 'Created', edit: 'Edited', published: 'Published', republished: 'Re-published', hidden: 'Hidden', shown: 'Shown Again', pinned: 'Pinned', unpinned: 'Unpinned', issue: 'Issue Reported', resolved: 'Issue Resolved', 'issue cleared': 'Issue Removed' };
const fieldWord = (f) => ({ businessImpact: 'Business impact', userImpact: 'User impact', whatsChanged: "What's changed", actionRequired: 'Action required', scheduledFor: 'Scheduled for', videoUrl: 'Video', relatedIds: 'Related updates', type: 'Category' }[f] || f.charAt(0).toUpperCase() + f.slice(1));
const show = (v) => (v === null || v === undefined || v === '' ? '(empty)' : v === true ? 'Yes' : v === false ? 'No' : typeof v === 'string' ? v : JSON.stringify(v));
export function HistoryList({ entryId, nameOf }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    api.getTaskChangelogHistory(entryId).then((r) => { if (live) setRows(r || []); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [entryId]);
  if (!rows) return <LoadingState />;
  if (!rows.length) return <p style={{ margin: 0, fontSize: 13, color: NX.dim }}>No changes recorded yet.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 10 }}>
          <History size={15} style={{ flexShrink: 0, marginTop: 2, color: NX.faint }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: NX.ink }}>
              <strong>{ACTION_WORDS[r.action] || r.action}</strong> by {r.by === 'schedule' ? 'the schedule' : (r.by ? nameOf(r.by) : 'Nexus')}
              <span style={{ marginLeft: 8, fontSize: 12, color: NX.faint }}>{formatDateTime(r.at)}</span>
            </div>
            {Object.entries(r.changes || {}).map(([f, [a, b]]) => (
              <div key={f} style={{ marginTop: 4, fontSize: 12, color: NX.dim }}>
                <span style={{ fontWeight: 600 }}>{fieldWord(f)}:</span>{' '}
                <span style={{ textDecoration: 'line-through' }}>{show(a).slice(0, 160)}</span> → <span style={{ color: NX.ink }}>{show(b).slice(0, 160)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Follow: modules, categories, weekly digest, private RSS ────────────────
export function FollowDialog({ entries, categories, initial, onClose, onSaved }) {
  const [mods, setMods] = useState(new Set(initial?.modules || []));
  const [cats, setCats] = useState(new Set(initial?.categories || []));
  const [digest, setDigest] = useState(!!initial?.digest);
  const [feed, setFeed] = useState(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const moduleNames = useMemo(() => {
    const names = new Set((entries || []).map((e) => e.module).filter(Boolean));
    MODULES.forEach((m) => names.add(m.label));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [entries]);
  useEffect(() => { api.getTaskChangelogFeedLink?.()?.then?.(setFeed)?.catch?.(() => {}); }, []);
  const toggle = (set, setter, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n); };
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveTaskChangelogSubscription({ modules: [...mods], categories: [...cats], digest });
      onSaved?.(r); onClose();
    } catch { setSaving(false); }
  };
  const chipBox = (on) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderRadius: 999, padding: '5px 11px', fontSize: 12.5, fontWeight: 600,
    border: `1px solid ${on ? NX.blue : NX.border}`, background: on ? 'rgba(37,99,235,0.10)' : 'transparent', color: on ? NX.blue : NX.dim, fontFamily: FONT,
  });
  const footer = (<>
    <button onClick={onClose} style={btn('outline')}>Cancel</button>
    <button onClick={save} disabled={saving} style={{ ...btn('primary'), opacity: saving ? 0.6 : 1 }}>Save</button>
  </>);
  return (
    <Modal title="Follow Updates" onClose={onClose} footer={footer}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: NX.dim }}>Pick what you care about - a matching update lands in your bell as soon as it is released.</p>
      <div style={{ fontSize: 12, fontWeight: 700, color: NX.dim, marginBottom: 8 }}>Modules</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {moduleNames.map((m) => {
          const k = m.toLowerCase();
          return <button key={m} type="button" aria-pressed={mods.has(k)} onClick={() => toggle(mods, setMods, k)} style={chipBox(mods.has(k))}>{m}</button>;
        })}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: NX.dim, marginBottom: 8 }}>Categories</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {categories.map((c) => {
          const k = c.toLowerCase();
          return <button key={c} type="button" aria-pressed={cats.has(k)} onClick={() => toggle(cats, setCats, k)} style={chipBox(cats.has(k))}>{c}</button>;
        })}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.ink, marginBottom: 18, cursor: 'pointer' }}>
        <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
        Email me a weekly digest every Monday
      </label>
      <div style={{ ...card, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: NX.ink }}><Rss size={14} />Private RSS Feed</div>
        <p style={{ margin: '4px 0 10px', fontSize: 12, color: NX.dim }}>Add this link to a feed reader or Outlook. It is yours alone - anyone with it sees what you see. Make a new one if it leaks.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input readOnly value={feed?.url || 'Loading…'} aria-label="Feed link" style={{ ...inputStyle, flex: '1 1 260px', fontSize: 12 }} onFocus={(e) => e.target.select()} />
          <button type="button" disabled={!feed} onClick={async () => { setCopied(await copyText(feed.url)); }} style={btn('outline')}><Copy size={13} />{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" onClick={async () => { try { setFeed(await api.rotateTaskChangelogFeedLink()); setCopied(false); } catch { /* keep */ } }} style={btn('outline')}><RefreshCw size={13} />New Link</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Audience, for the add / edit form ──────────────────────────────────────
export function AudiencePicker({ value, onChange }) {
  const [companies, setCompanies] = useState([]);
  useEffect(() => { api.getTaskChangelogAudienceOptions?.()?.then?.((r) => setCompanies(r?.companies || []))?.catch?.(() => {}); }, []);
  const v = value || { modules: [], companies: [] };
  const flip = (key, id) => {
    const cur = new Set(v[key] || []);
    cur.has(id) ? cur.delete(id) : cur.add(id);
    onChange({ ...v, [key]: [...cur] });
  };
  const chipBox = (on) => ({
    cursor: 'pointer', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 600, fontFamily: FONT,
    border: `1px solid ${on ? NX.blue : NX.border}`, background: on ? 'rgba(37,99,235,0.10)' : 'transparent', color: on ? NX.blue : NX.dim,
  });
  return (
    <div>
      <div style={{ fontSize: 11, color: NX.faint, marginBottom: 6 }}>Modules - only people with access to one of these see it. None picked = everyone.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {MODULES.map((m) => <button key={m.id} type="button" aria-pressed={(v.modules || []).includes(m.id)} onClick={() => flip('modules', m.id)} style={chipBox((v.modules || []).includes(m.id))}>{m.label}</button>)}
      </div>
      {companies.length > 0 && (<>
        <div style={{ fontSize: 11, color: NX.faint, marginBottom: 6 }}>Companies - only their people see it. None picked = every company.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {companies.map((c) => <button key={c.id} type="button" aria-pressed={(v.companies || []).includes(c.id)} onClick={() => flip('companies', c.id)} style={chipBox((v.companies || []).includes(c.id))}>{c.name}</button>)}
        </div>
      </>)}
    </div>
  );
}

// ── Manage: insights, feedback, export ─────────────────────────────────────
function Bars({ rows, field, color }) {
  const max = Math.max(1, ...rows.map((r) => r[field] || 0));
  const w = 100 / rows.length;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${field} per week`} style={{ width: '100%', height: 56, display: 'block' }}>
      {rows.map((r, i) => {
        const h = ((r[field] || 0) / max) * 36;
        // a faint full-height track per week, so empty weeks still read as weeks
        return <g key={r.week}><rect x={i * w + w * 0.15} y={4} width={w * 0.7} height={36} rx={0.8} fill={NX.border2} opacity={0.6} /><rect x={i * w + w * 0.15} y={40 - h} width={w * 0.7} height={h} rx={0.8} fill={color}><title>{`Week of ${formatFullDate(r.week)}: ${r[field] || 0}`}</title></rect></g>;
      })}
    </svg>
  );
}

export function InsightsPanel({ insights, onOpen }) {
  const isMobile = useIsMobile();
  if (!insights) return null;
  const t = insights.trends || [];
  const charts = [['Published', 'published', '#16a34a'], ['Views', 'views', '#2563eb'], ['Reactions', 'reactions', '#d97706'], ['Comments', 'comments', '#7c3aed']];
  return (
    <div data-whats-new-insights style={{ marginBottom: 24, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: 12 }}>
      <div style={{ ...card, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: NX.ink }}>Last 12 Weeks</h3>
          <span style={{ fontSize: 12, color: NX.dim }}>
            Average read rate {insights.averageReadRate == null ? '-' : `${insights.averageReadRate}%`}
            {' · '}Helpful {insights.helpful?.rate == null ? '-' : `${insights.helpful.rate}%`}
          </span>
        </div>
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          {charts.map(([label, f, color]) => (
            <div key={f}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <span>{label}</span><span>{t.reduce((n, r) => n + (r[f] || 0), 0)}</span>
              </div>
              <Bars rows={t} field={f} color={color} />
            </div>
          ))}
        </div>
      </div>
      <div style={{ ...card, padding: 14 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: NX.ink }}>Most Reacted</h3>
        {(insights.topReacted || []).length === 0 ? <p style={{ margin: '8px 0 0', fontSize: 12, color: NX.dim }}>No reactions yet.</p> : (
          <ol style={{ margin: '8px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {insights.topReacted.map((r) => (
              <li key={r.id} style={{ fontSize: 13 }}>
                <button type="button" onClick={() => onOpen?.(r.id)} style={{ ...btn('ghost'), padding: 0, color: NX.ink, fontWeight: 600, textAlign: 'left' }}>{r.title}</button>
                <span style={{ marginLeft: 6, fontSize: 12, color: NX.faint }}>{plural(r.reactions, 'reaction')}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// Requests carry a status the requester sees (Oct 18 2026): Manage sets it
// here, with a note and the update that shipped it (changelog_lifecycle).
const OPEN_REQUESTS = 'open';
export function FeedbackList({ nameOf, entries, flash }) {
  const [rows, setRows] = useState(null);
  const [show, setShow] = useState(OPEN_REQUESTS);
  useEffect(() => { api.getTaskChangelogFeedbackList?.()?.then?.((r) => setRows(r || []))?.catch?.(() => setRows([])); }, []);
  if (!rows) return null;
  const shown = rows.filter((r) => (r.kind !== 'request' ? show === 'all'
    : show === 'all' || (show === OPEN_REQUESTS ? !['Shipped', 'Declined'].includes(r.status) : r.status === show)));
  const filters = [[OPEN_REQUESTS, 'Open Requests'], ...REQUEST_STATUSES.map((st) => [st, st]), ['all', 'Everything']];
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: NX.ink }}>Feature Requests and Feedback</h2>
        <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show requests" style={{ ...inputStyle, width: 'auto', padding: '4px 8px' }}>
          {filters.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      {shown.length === 0 ? (
        <div style={{ borderRadius: 12, border: `1px dashed ${NX.border}`, padding: '28px 0', textAlign: 'center', fontSize: 13, color: NX.dim }}>{rows.length ? 'Nothing here with this filter.' : 'No requests or notes yet.'}</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          {shown.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderBottom: `1px solid ${NX.border2}`, padding: '10px 14px' }}>
              <Avatar email={r.email} name={nameOf(r.email)} size={22} />
              <div style={{ minWidth: 0, flex: 1, fontSize: 13 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <strong>{nameOf(r.email)}</strong>
                  <span style={chip(r.kind === 'request' ? '#7c3aed' : (r.helpful ? '#16a34a' : '#dc2626'), r.kind === 'request' ? 'rgba(124,58,237,0.15)' : (r.helpful ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)'))}>
                    {r.kind === 'request' ? 'Feature Request' : (r.helpful ? 'Helpful' : 'Not Helpful')}
                  </span>
                  {r.kind === 'request' && <RequestStatusChip status={r.status} />}
                  <span style={{ fontSize: 12, color: NX.faint }}>{r.entryTitle ? `on ${r.entryTitle}` : (r.module || 'General request')} · {formatDateTime(r.at)}</span>
                </div>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', color: NX.ink }}>{r.note}</div>
                {r.kind === 'request' && (
                  <RequestStatusEditor row={r} entries={entries} flash={flash}
                    onSaved={(u) => setRows((all) => all.map((x) => (x.id === u.id ? { ...x, ...u, kind: 'request' } : x)))} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportCsv(entries, analytics, insights, statusOf) {
  const head = ['Title', 'Category', 'Module', 'Version', 'Environment', 'Status', 'Released', 'Pinned', 'Hidden', 'Breaking',
    'Issue', 'Going Away', 'In Production',
    'People Reached', 'Views', 'Reactions', 'Comments', 'Read Rate %', 'Helpful Yes', 'Helpful No', 'Feature Requests', 'Link'];
  const lines = [head.map(csvCell).join(',')];
  for (const e of entries) {
    const a = analytics?.entries?.[e.id] || {};
    const i = insights?.entries?.[e.id] || {};
    lines.push([e.title, e.type, e.module, e.version, e.environment, statusOf(e), e.releasedAt ? formatDateTime(e.releasedAt) : '',
      e.pinned ? 'Yes' : '', e.hidden ? 'Yes' : '', e.breaking ? 'Yes' : '',
      e.issue?.kind ? (e.issue.resolvedAt ? 'Fixed' : e.issue.kind === 'rolledBack' ? 'Rolled Back' : 'Known Issue') : '',
      e.deprecation?.removeOn ? formatFullDate(e.deprecation.removeOn) : '', e.prodAt ? formatDateTime(e.prodAt) : '', a.viewers ?? 0, a.views ?? 0, a.reactionTotal ?? 0,
      a.comments ?? 0, i.readRate ?? '', i.helpful?.yes ?? 0, i.helpful?.no ?? 0, i.requests ?? 0, entryLink(e.id)].map(csvCell).join(','));
  }
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `whats-new-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Print / PDF builds its own report document and prints that (Oct 16 2026).
// Printing the screen gave blank pages: What's New lives inside the app's
// fixed-height, scrolling shell, so the browser clipped it away. The report
// is the same rows and figures as Export CSV, laid out for paper.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function buildPrintReport(entries, analytics, insights, statusOf) {
  const t = analytics?.totals || {};
  const d = new Date();
  const today = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const tiles = [
    ['Published', entries.filter((e) => statusOf(e) === 'Released').length], ['People Reached', t.peopleReached ?? '-'],
    ['Views', t.views ?? '-'], ['Reactions', t.reactions ?? '-'], ['Comments', t.comments ?? '-'],
    ['Average Read Rate', insights?.averageReadRate == null ? '-' : `${insights.averageReadRate}%`],
    ['Helpful', insights?.helpful?.rate == null ? '-' : `${insights.helpful.rate}%`],
  ].map(([k, v]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const rows = entries.map((e) => {
    const a = analytics?.entries?.[e.id] || {};
    const i = insights?.entries?.[e.id] || {};
    const flags = [e.pinned && 'Pinned', e.hidden && 'Hidden', e.breaking && 'Breaking'].filter(Boolean).join(', ');
    return `<tr><td><strong>${esc(e.title)}</strong>${e.actionRequired ? `<div class="act">Action required: ${esc(e.actionRequired)}</div>` : ''}</td>`
      + `<td>${esc(e.type)}</td><td>${esc(e.module)}</td><td>${esc(e.version)}</td><td>${esc(statusOf(e))}${flags ? `<div class="sub">${esc(flags)}</div>` : ''}</td>`
      + `<td>${esc(e.releasedAt ? formatDateTime(e.releasedAt) : '')}</td>`
      + `<td class="n">${a.viewers ?? 0}</td><td class="n">${a.reactionTotal ?? 0}</td><td class="n">${a.comments ?? 0}</td>`
      + `<td class="n">${i.readRate == null ? '-' : `${i.readRate}%`}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>What's New - ${esc(today)}</title><style>
    @page { size: landscape; margin: 14mm; }
    body { font-family: Inter, Arial, sans-serif; color: #111827; font-size: 11px; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 2px; } .meta { color: #5b6472; margin: 0 0 14px; }
    .tiles { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
    .tile { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 10px; min-width: 90px; }
    .k { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: #6b7280; } .v { font-size: 16px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; }
    th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 5px 6px; }
    td { border-bottom: 1px solid #eef0f3; padding: 5px 6px; vertical-align: top; } tr { break-inside: avoid; }
    .n { text-align: right; white-space: nowrap; } .sub { color: #6b7280; font-size: 10px; } .act { color: #b91c1c; font-size: 10px; margin-top: 2px; }
  </style></head><body>
    <h1>What's New in Nexus</h1><p class="meta">${esc(entries.length)} updates · printed ${esc(today)}</p>
    <div class="tiles">${tiles}</div>
    <table><thead><tr><th>Update</th><th>Category</th><th>Module</th><th>Version</th><th>Status</th><th>Released</th>
      <th class="n">Reached</th><th class="n">Reactions</th><th class="n">Comments</th><th class="n">Read Rate</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10">No updates.</td></tr>'}</tbody></table>
  </body></html>`;
}

function printReport(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
  frame.contentWindow.addEventListener('afterprint', cleanup);
  // Let the report lay out before the print dialog reads it.
  window.setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); window.setTimeout(() => frame.remove(), 60_000); }, 250);
}

export function ExportButtons({ onCsv, onPrint }) {
  return (<>
    <button type="button" onClick={onCsv} style={btn('outline')}><Download size={14} />Export CSV</button>
    <button type="button" onClick={() => printReport(onPrint())} style={btn('outline')}><Printer size={14} />Print / PDF</button>
  </>);
}

// ── "New on this screen" (App.jsx, every view) ─────────────────────────────
// A released update that names the screen you are on (the Screen field) shows
// a small card the first time you open that screen after it shipped. Dismissed
// per person in this browser - a convenience, so storage failing just shows it again.
const HINT_KEY = 'nx-whats-new-hints-dismissed';
const readDismissed = () => { try { return new Set(JSON.parse(localStorage.getItem(HINT_KEY) || '[]')); } catch { return new Set(); } };
const writeDismissed = (set) => { try { localStorage.setItem(HINT_KEY, JSON.stringify([...set].slice(-200))); } catch { /* fine */ } };

const hintKey = (h) => (h.kind && h.kind !== 'new' ? `${h.kind}:${h.id}:${h.stamp || ''}` : h.id);
const HINT_LOOK = {
  issue: { icon: AlertTriangle, color: '#b45309' },
  rolledBack: { icon: AlertTriangle, color: '#b91c1c' },
  deprecation: { icon: CalendarX, color: '#9a3412' },
  new: { icon: Sparkles, color: NX.blue },
};
const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

// Known issues, coming removals and new updates on this screen (Oct 18
// 2026: issues and removals come first and show whatever their age), and
// the host that runs a guided tour on whatever screen is open.
export function WhatsNewHint({ view }) {
  return (<>
    <TourHost view={view} />
    <ScreenHint view={view} />
  </>);
}

function ScreenHint({ view }) {
  const [hint, setHint] = useState(null);
  useEffect(() => {
    setHint(null);
    if (!view || view === 'whats-new') return undefined;
    let live = true;
    const t = window.setTimeout(() => {
      api.getTaskChangelogHints?.(view)?.then?.((rows) => {
        if (!live) return;
        const dismissed = readDismissed();
        setHint((rows || []).find((r) => !dismissed.has(hintKey(r))) || null);
      })?.catch?.(() => {});
    }, 1200);   // after the screen itself has loaded
    return () => { live = false; window.clearTimeout(t); };
  }, [view]);
  if (!hint) return null;
  const dismiss = () => { const s = readDismissed(); s.add(hintKey(hint)); writeDismissed(s); setHint(null); };
  const open = () => {
    dismiss();
    window.history.replaceState(null, '', `/whats-new?entry=${encodeURIComponent(hint.id)}`);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'whats-new' } }));
  };
  const look = HINT_LOOK[hint.kind === 'issue' && hint.issueKind === 'rolledBack' ? 'rolledBack' : hint.kind] || HINT_LOOK.new;
  const Icon = look.icon;
  const heading = hint.kind === 'issue' ? (hint.issueKind === 'rolledBack' ? 'Rolled Back on This Screen' : 'Known Issue on This Screen')
    : hint.kind === 'deprecation' ? `Going Away ${formatFullDate(hint.removeOn)}` : 'New on This Screen';
  return (
    <div role={hint.kind === 'issue' ? 'alert' : 'status'} aria-label={heading} className="nx-rise" style={{
      position: 'fixed', right: 18, bottom: 88, zIndex: 1180, width: 'min(340px, calc(100vw - 32px))', ...card,
      padding: '12px 14px', boxShadow: '0 12px 36px rgba(0,0,0,0.18)', fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Icon size={16} style={{ color: look.color, flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: hint.kind === 'new' ? NX.faint : look.color }}>{heading}</div>
          <div style={{ marginTop: 2, fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{hint.kind === 'deprecation' ? (hint.what || hint.title) : hint.title}</div>
          {hint.kind === 'issue' && <div style={{ marginTop: 4, fontSize: 12.5, color: NX.ink }}>{hint.note}</div>}
          {hint.kind === 'issue' && hint.workaround && <div style={{ marginTop: 4, fontSize: 12.5, color: NX.dim }}><strong>Workaround:</strong> {hint.workaround}</div>}
          {hint.kind === 'deprecation' && (
            <div style={{ marginTop: 4, fontSize: 12.5, color: NX.ink }}>
              Goes away {inDays(hint.daysLeft)}.{hint.replacement ? ` Use ${hint.replacement} instead.` : ''}
            </div>
          )}
          {hint.actionRequired && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>Action required: {hint.actionRequired}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6 }}>
            {hint.tour && (
              <button type="button" onClick={() => { dismiss(); startTour(hint.id, view, view); }} style={{ ...btn('ghost'), padding: 0, color: NX.blue, fontSize: 12.5 }}>
                <Compass size={13} />Take the Tour
              </button>
            )}
            <button type="button" onClick={open} style={{ ...btn('ghost'), padding: 0, color: NX.blue, fontSize: 12.5 }}>
              {hint.kind === 'new' ? <>See What&apos;s Changed <ArrowRight size={13} /></> : <>See Details <ArrowRight size={13} /></>}
            </button>
          </div>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}><X size={14} /></button>
      </div>
    </div>
  );
}

export function FollowButton({ onClick, following }) {
  return (
    <button type="button" onClick={onClick} aria-label="Follow" style={{ ...btn('outline') }}>
      <Bell size={15} />{following ? 'Following' : 'Follow'}
    </button>
  );
}
