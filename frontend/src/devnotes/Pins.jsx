// Existing pins on the current screen: numbered markers anchored to their
// element (selector first, the saved rect when it is gone), colored by status,
// with the author's initials; click = the thread. Everyone with Build Mode
// sees everyone's pins. Accept / Reopen live here, on the fixed pin, where
// the bug was.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, ExternalLink, Check, RotateCcw, Send, Loader2, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';
import { toViewUrl } from '../lib/storageView';
import { RUNNING_SINCE } from '../lib/useBuildVersion';
import { useIsMobile } from '../lib/useIsMobile';
import { StatusLabel } from '../components/StatusLabel';
import { anchorRect } from './lib/capture';
import { placeCard } from './lib/anchor';
import { statusMeta, KIND_META, PRIORITY_META, initialsOf, firstNameOf } from './meta';
import { toast } from './store';

const MINE = import.meta.env.VITE_BUILD_ID || 'dev';

/** The fix merged, but this tab still runs code older than the fix. */
export function fixDeploying(pin) {
  if (!pin?.fixedBuildId || MINE === 'dev' || pin.fixedBuildId === MINE) return false;
  return !pin.fixedAt || RUNNING_SINCE < pin.fixedAt;
}

/** A human answered and Claude Code has not picked it up again yet. */
export function waitingForClaude(pin) {
  if (pin?.status !== 'building') return false;
  const last = (pin.thread || [])[pin.thread.length - 1];
  return !!last && last.kind === 'comment' && last.by !== 'claude';
}

// Re-measures every pin's anchor on scroll (any scroller), resize, DOM
// changes and a slow safety tick - pins follow their element.
function useAnchors(pins) {
  const [anchors, setAnchors] = useState({});
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = {};
        for (const p of pins) next[p.id] = anchorRect(p.target);
        setAnchors(next);
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(measure, 200); }) : null;
    mo?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    const tick = setInterval(measure, 1500);
    return () => {
      cancelAnimationFrame(raf); clearInterval(tick); mo?.disconnect(); clearTimeout(mo?._t);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [pins]);
  return anchors;
}

export default function Pins({ pins = [], openPinId = '', onOpen, onClose, onChanged, show = true }) {
  const anchors = useAnchors(pins);
  const openPin = pins.find((p) => p.id === openPinId) || null;
  const vpH = typeof window !== 'undefined' ? window.innerHeight : 800;
  if (!show && !openPin) return null;
  return (
    <>
      {show && pins.map((p) => {
        const a = anchors[p.id];
        if (!a) return null;
        if (a.y + a.h < -20 || a.y > vpH + 20) return null;           // scrolled away
        const m = statusMeta(p.status);
        const left = Math.max(14, Math.min(window.innerWidth - 14, a.x + a.w));
        const top = Math.max(14, a.y);
        const isOpen = p.id === openPinId;
        return (
          <button key={p.id} type="button" className={`bm-pin${m.pulse ? ' is-pulse' : ''}${m.faded ? ' is-faded' : ''}${isOpen ? ' is-open' : ''}${a.anchored ? '' : ' is-loose'}`}
            style={{ left, top, '--c': m.color }} onClick={() => (isOpen ? onClose?.() : onOpen?.(p.id))}
            title={`Pin #${p.number} - ${m.label}${a.anchored ? '' : ' (element not found - at its last position)'}`}
            aria-label={`Pin ${p.number}, ${m.label}, by ${firstNameOf(p.createdBy)}`} aria-expanded={isOpen} data-testid="bm-pin">
            <span className="bm-pin-no">{p.number}</span>
            <span className="bm-pin-init" aria-hidden="true">{initialsOf(p.createdBy)}</span>
          </button>
        );
      })}
      {openPin && anchors[openPin.id] && (
        <div className="bm-pin-ring" aria-hidden="true" style={{ left: anchors[openPin.id].x - 3, top: anchors[openPin.id].y - 3, width: anchors[openPin.id].w + 6, height: anchors[openPin.id].h + 6, '--c': statusMeta(openPin.status).color }} />
      )}
      {openPin && <PinThread pin={openPin} anchor={anchors[openPin.id]} onClose={onClose} onChanged={onChanged} />}
    </>
  );
}

// ── The thread card ──────────────────────────────────────────────────────────
const ENTRY_LABEL = { claude: 'Claude', progress: 'Progress', system: 'System' };

// A thread after a needs-input round trip reads: progress "Picked up by
// Claude Code", progress "Found ...", claude "<question>", comment "<answer>",
// progress, system "Repro: ...", system "PR #n Open: ...", system "Merged To
// Dev", system "Verified: ...". Progress = one muted line; claude = Claude's
// reply bubble; system = a small centered marker; comment = the person's.
function ThreadEntry({ e }) {
  const kind = e.kind || 'comment';
  if (kind === 'progress' || kind === 'system') {
    return (
      <div className={`bm-entry bm-entry-${kind}`} title={formatDateTime(e.at)}>
        <span className="bm-entry-text">{e.text}</span>
        {e.imageUrl && <a href={toViewUrl(e.imageUrl)} target="_blank" rel="noreferrer"><img className="bm-thumb" src={toViewUrl(e.imageUrl)} alt="" /></a>}
      </div>
    );
  }
  const who = kind === 'comment' ? firstNameOf(e.by) : (ENTRY_LABEL[kind] || kind);
  return (
    <div className={`bm-entry bm-entry-${kind}`}>
      <div className="bm-entry-head">
        <span className="bm-entry-who">{who}</span>
        <span className="bm-entry-at">{formatDateTime(e.at)}</span>
      </div>
      {e.text && <div className="bm-entry-text">{e.text}</div>}
      {e.imageUrl && <a href={toViewUrl(e.imageUrl)} target="_blank" rel="noreferrer"><img className="bm-thumb" src={toViewUrl(e.imageUrl)} alt="" /></a>}
    </div>
  );
}

function Evidence({ v }) {
  if (!v || typeof v !== 'object') return null;
  const checks = v.styleCheck?.checks || [];
  return (
    <section className="bm-evidence" aria-label="Evidence">
      <div className="bm-sec-title">Evidence</div>
      {v.repro && (v.repro.before || v.repro.after) && (
        <div className="bm-repro">
          <div><span className="bm-dim">Before</span><div>{v.repro.before || '-'}</div></div>
          <div className="bm-repro-arrow" aria-hidden="true">→</div>
          <div><span className="bm-dim">After</span><div>{v.repro.after || '-'}</div></div>
        </div>
      )}
      {checks.length > 0 && (
        <table className="bm-table">
          <thead><tr><th>Prop</th><th>Expected</th><th>Actual</th><th aria-label="Result" /></tr></thead>
          <tbody>
            {checks.map((c, i) => (
              <tr key={i}>
                <td>{c.prop || c.name}</td><td>{String(c.expected ?? '')}</td><td>{String(c.actual ?? '')}</td>
                <td className={c.passed || c.ok ? 'bm-ok' : 'bm-bad'}>{c.passed || c.ok ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {v.styleCheck && !checks.length && <div className="bm-dim">Style check {v.styleCheck.passed ? 'passed' : 'failed'}</div>}
      {(v.visual?.beforeUrl || v.visual?.afterUrl) && (
        <div className="bm-side">
          {['beforeUrl', 'afterUrl'].map((k) => v.visual[k] && (
            <a key={k} href={toViewUrl(v.visual[k])} target="_blank" rel="noreferrer" className="bm-side-img">
              <img src={toViewUrl(v.visual[k])} alt={k === 'beforeUrl' ? 'Before' : 'After'} />
              <span>{k === 'beforeUrl' ? 'Before' : 'After'}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

export function PinThread({ pin, anchor, onClose, onChanged }) {
  const isMobile = useIsMobile();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState('');    // 'reopen' | 'dismiss'
  const m = statusMeta(pin.status);
  const kind = KIND_META[pin.kind] || KIND_META.bug;
  const prio = PRIORITY_META[pin.priority];
  const deploying = fixDeploying(pin);
  const waiting = waitingForClaude(pin);
  const closed = pin.status === 'done' || pin.status === 'dismissed';

  useLayoutEffect(() => {
    if (isMobile) { setPos(null); return; }
    const size = { w: ref.current?.offsetWidth || 400, h: ref.current?.offsetHeight || 480 };
    const rect = anchor ? { x: anchor.x + anchor.w, y: anchor.y, w: 0, h: 0 } : { x: window.innerWidth / 2, y: 80, w: 0, h: 0 };
    setPos(placeCard(rect, size, { w: window.innerWidth, h: window.innerHeight }, false, 18));
  }, [anchor?.x, anchor?.y, anchor?.w, isMobile, pin.id, pin.thread?.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setReply(''); setErr(''); setConfirm(''); }, [pin.id]);

  const run = async (label, fn) => {
    setBusy(label); setErr('');
    try { const note = await fn(); if (note) onChanged?.(note); return note; } catch (e) { setErr(e?.message || 'That did not work.'); return null; } finally { setBusy(''); }
  };
  const send = () => { const t = reply.trim(); if (!t) return; run('reply', () => api.devNotesThread(pin.id, t)).then((n) => { if (n) { setReply(''); toast(waiting ? 'Reply sent' : 'Reply added'); } }); };
  const accept = () => run('accept', () => api.devNotesVerify(pin.id, true, reply.trim())).then((n) => n && toast(`Pin #${pin.number} verified - thank you`));
  const reopen = () => run('reopen', () => api.devNotesVerify(pin.id, false, reply.trim())).then((n) => { if (n) { setConfirm(''); toast(`Pin #${pin.number} reopened`); } });
  const dismiss = () => run('dismiss', () => api.devNotesPatch(pin.id, { status: 'dismissed' })).then((n) => { if (n) { setConfirm(''); toast(`Pin #${pin.number} dismissed`); } });
  const undismiss = () => run('undismiss', () => api.devNotesPatch(pin.id, { status: 'open' })).then((n) => n && toast(`Pin #${pin.number} is open again`));

  const edit = pin.edit && typeof pin.edit === 'object' && (pin.edit.text || pin.edit.styles?.length) ? pin.edit : null;
  const shot = pin.screenshotUrl || pin.pageShotUrl;

  return (
    <div ref={ref} className="bm-card bm-thread" role="dialog" aria-label={`Pin ${pin.number}`} data-testid="bm-thread"
      style={pos ? { left: pos.left, top: pos.top } : undefined} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}>
      <div className="bm-card-head">
        <span className="bm-pin bm-pin-inline" style={{ '--c': m.color }} aria-hidden="true"><span className="bm-pin-no">{pin.number}</span></span>
        <div className="bm-card-title">
          <span>{kind.label}</span>
          {prio && pin.priority !== 'normal' && <span className="bm-dot-sep" />}
          {prio && pin.priority !== 'normal' && <span style={{ color: prio.color, fontWeight: 600 }}>{prio.label}</span>}
        </div>
        <StatusLabel label={m.label} color={m.color} size="sm" />
        <button type="button" className="bm-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="bm-card-body">
        <div className="bm-meta">
          <span>{firstNameOf(pin.createdBy)}</span><span className="bm-dot-sep" /><span>{formatDateTime(pin.createdAt)}</span>
          {pin.route && <><span className="bm-dot-sep" /><span>{pin.route}{pin.sub ? ` › ${pin.sub}` : ''}</span></>}
          {pin.reopenCount > 0 && <><span className="bm-dot-sep" /><span>Reopened {pin.reopenCount}x</span></>}
        </div>
        {pin.comment && <div className="bm-comment">{pin.comment}</div>}
        {pin.target?.source?.file && <div className="bm-src" title="Where the element is drawn">{pin.target.source.file}:{pin.target.source.line}</div>}
        {shot && (
          <a className="bm-shot" href={toViewUrl(pin.pageShotUrl || pin.screenshotUrl)} target="_blank" rel="noreferrer" title="Open the full screenshot">
            <img src={toViewUrl(shot)} alt="Screenshot" />
          </a>
        )}
        {(pin.videoUrl || pin.contactSheetUrl) && (
          <div className="bm-media-row">
            {pin.contactSheetUrl && <a href={toViewUrl(pin.contactSheetUrl)} target="_blank" rel="noreferrer"><img className="bm-thumb" src={toViewUrl(pin.contactSheetUrl)} alt="Recording frames" /></a>}
            {pin.videoUrl && <a className="bm-link" href={toViewUrl(pin.videoUrl)} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Open Recording</a>}
          </div>
        )}
        {pin.transcript && <details className="bm-details"><summary>Transcript</summary><pre className="bm-pre">{pin.transcript}</pre></details>}
        {(pin.attachments || []).length > 0 && (
          <div className="bm-thumbs">{pin.attachments.map((u, i) => <a key={i} href={toViewUrl(u)} target="_blank" rel="noreferrer"><img className="bm-thumb" src={toViewUrl(u)} alt="" /></a>)}</div>
        )}
        {edit && (
          <section className="bm-edit-block">
            <div className="bm-sec-title">Edit</div>
            {edit.text && <div className="bm-diff"><s>{edit.text.before}</s> <span aria-hidden="true">→</span> <b>{edit.text.after}</b></div>}
            {(edit.styles || []).map((s, i) => <div key={i} className="bm-diff"><code>{s.prop}</code> <s>{s.before}</s> <span aria-hidden="true">→</span> <b>{s.after}</b></div>)}
          </section>
        )}
        {pin.progress && (
          <div className="bm-progress"><Loader2 size={12} className={m.pulse ? 'bm-spin' : ''} /> <span>{pin.progress}</span>{pin.progressAt && <span className="bm-dim"> · {formatDateTime(pin.progressAt)}</span>}</div>
        )}
        {waiting && <div className="bm-hint">Waiting for Claude Code to pick up your reply.</div>}
        {pin.status === 'needs_input' && <div className="bm-hint bm-hint-amber">Claude Code is waiting for your answer - reply below.</div>}
        {pin.prUrl && (
          <a className="bm-link" href={pin.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /> PR #{pin.prNumber}{pin.branch ? ` · ${pin.branch}` : ''}</a>
        )}
        <Evidence v={pin.verification} />
        {(pin.thread || []).length > 0 && (
          <div className="bm-entries">{pin.thread.map((e) => <ThreadEntry key={e.id || e.at} e={e} />)}</div>
        )}
        {pin.status === 'fixed' && (
          <div className={`bm-verify${deploying ? ' is-deploying' : ''}`}>
            {deploying
              ? <><Loader2 size={13} className="bm-spin" /><span>Fix Deploying... reload once the new build is live, then check it here.</span></>
              : <><Check size={13} /><span>The fix is live in this build - does it look right?</span></>}
          </div>
        )}
        {err && <div className="bm-error" role="alert">{err}</div>}
      </div>
      {!closed && (
        <div className="bm-card-foot bm-col">
          <div className="bm-reply">
            <textarea className="bm-textarea" rows={2} value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder={pin.status === 'fixed' ? 'A note with your verdict (optional)' : 'Reply to this pin'}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }} />
            {pin.status !== 'fixed' && (
              <button type="button" className="bm-btn bm-btn-primary" onClick={send} disabled={!reply.trim() || !!busy} aria-label="Send reply"><Send size={14} /></button>
            )}
          </div>
          <div className="bm-actions">
            {pin.status === 'fixed' && !confirm && (
              <>
                <button type="button" className="bm-btn bm-btn-primary" onClick={accept} disabled={!!busy}><Check size={14} /> Accept</button>
                <button type="button" className="bm-btn" onClick={() => setConfirm('reopen')} disabled={!!busy}><RotateCcw size={14} /> Reopen</button>
              </>
            )}
            {confirm === 'reopen' && (
              <span className="bm-confirm">Still broken? <button type="button" className="bm-btn bm-btn-danger" onClick={reopen} disabled={!!busy}>Reopen Pin</button><button type="button" className="bm-btn bm-btn-ghost" onClick={() => setConfirm('')}>Keep</button></span>
            )}
            {confirm === 'dismiss' && (
              <span className="bm-confirm">Dismiss this pin? <button type="button" className="bm-btn bm-btn-danger" onClick={dismiss} disabled={!!busy}>Dismiss</button><button type="button" className="bm-btn bm-btn-ghost" onClick={() => setConfirm('')}>Keep</button></span>
            )}
            {!confirm && <button type="button" className="bm-btn bm-btn-ghost bm-push" onClick={() => setConfirm('dismiss')} disabled={!!busy} title="Dismiss"><Trash2 size={14} /> Dismiss</button>}
          </div>
        </div>
      )}
      {pin.status === 'dismissed' && (
        <div className="bm-card-foot"><button type="button" className="bm-btn" onClick={undismiss} disabled={!!busy}><RotateCcw size={14} /> Reopen</button></div>
      )}
    </div>
  );
}
