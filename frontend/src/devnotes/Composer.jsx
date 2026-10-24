// The card anchored to what was picked: kind, priority, the comment (Ctrl+V
// pastes a screenshot into it), hold-to-talk, Record, the "Looks like ..."
// line, and Save Pin / Save And Send. The draft it edits lives in
// localStorage until the pin is saved (store.js saveDraft).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Mic, Video, CircleStop, Loader2, Send, Check, Trash2, Camera, CameraOff } from 'lucide-react';
import { useIsMobile } from '../lib/useIsMobile';
import { toViewUrl } from '../lib/storageView';
import { filesFromPaste } from '../tasks/lib';
import { MODULES } from '../contexts/RoleContext';
import { KINDS, PRIORITIES } from './meta';
import { placeCard } from './lib/anchor';
import { uploadDevNoteFile, storageReady } from './lib/upload';
import { speechSupported } from './lib/recorder';
import { api } from '../api';

const ROUTE_LABEL = Object.fromEntries(MODULES.map((m) => [m.id, m.label]));
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

/** "Looks like UpdateRow in Tasks > Home (src/tasks/Home.jsx:142)". */
export function looksLike(target, view) {
  if (!target) return '';
  const comp = (target.components || []).slice(-1)[0];
  const where = (target.headings || []).slice(0, 3).join(' > ') || ROUTE_LABEL[view] || view || '';
  const what = comp || (target.text ? `"${target.text.slice(0, 40)}${target.text.length > 40 ? '…' : ''}"` : `<${target.tag || 'element'}>`);
  const src = target.source?.file ? ` (${target.source.file}:${target.source.line})` : '';
  return `Looks like ${what}${where ? ` in ${where}` : ''}${src}`;
}

// Whose area the pick is on (v2): the server answers { owner, held } for a
// source stamp (GET /dev-notes/owner-of - the same code_owners.py rule it
// holds pins by). One lookup per file per page load, after the pick has sat
// for a moment; a pick that moves on quickly never asks.
const OWNER_CACHE = new Map();
const OWNER_DEBOUNCE_MS = 250;
function useHeldOwner(path) {
  const [got, setGot] = useState({ path: '', v: null });
  useEffect(() => {
    if (!path || OWNER_CACHE.has(path)) return undefined;
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve(api.devNotesOwnerOf?.(path)).then((r) => {
        const v = { owner: r?.owner || null, held: !!r?.held };
        OWNER_CACHE.set(path, v);
        if (live) setGot({ path, v });
      }).catch(() => { /* no answer = no owner line; the server still decides on save */ });
    }, OWNER_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [path]);
  const v = path ? (OWNER_CACHE.get(path) || (got.path === path ? got.v : null)) : null;
  return v?.held && v.owner ? { name: v.owner.name || v.owner.email || 'its owner', email: v.owner.email || '' } : null;
}

const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function Composer({
  pick, draft, onChange, onCancel, onSave, saving = '', settings,
  capture = 'idle', recording = null, onRecord, onStopRecord, recorded = null,
  voiceOn = false, interim = '', onVoiceStart, onVoiceStop,
  markupCount = 0, onClearMarkup, view,
}) {
  const isMobile = useIsMobile();
  const ref = useRef(null);
  const textRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const rect = pick?.rect;

  useLayoutEffect(() => {
    if (isMobile) { setPos(null); return; }
    const size = { w: ref.current?.offsetWidth || 400, h: ref.current?.offsetHeight || 520 };
    setPos(placeCard(rect, size, { w: window.innerWidth, h: window.innerHeight }, false));
  }, [rect, isMobile]);

  useEffect(() => { if (!isMobile) setTimeout(() => textRef.current?.focus(), 30); }, [draft?.id, isMobile]);

  const set = (patch) => onChange?.(patch);

  const onPaste = async (e) => {
    const files = filesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    if (!storageReady()) { setErr('File storage is not configured on this build.'); return; }
    setUploading((n) => n + files.length); setErr('');
    for (const f of files) {
      try {
        const url = await uploadDevNoteFile(draft.id, 'paste', f);
        set((d) => ({ attachments: [...(d.attachments || []), url] }));
      } catch (ex) { setErr(ex?.message || 'The paste could not be uploaded.'); }
      finally { setUploading((n) => n - 1); }
    }
  };
  const removeAttachment = (url) => set((d) => ({ attachments: (d.attachments || []).filter((u) => u !== url) }));

  // Someone else's area (v2): the server says the pin would be held for them,
  // so it is never sent to Claude Code from here - one button, Save For <Owner>.
  const owner = useHeldOwner(pick?.target?.source?.file || '');
  const sendInstantly = !!settings?.sendInstantly && !owner;
  const busy = !!saving || uploading > 0 || !!recording;
  const kindMeta = KINDS.find((k) => k.id === draft.kind) || KINDS[0];
  const hint = looksLike(pick?.target, view);

  return (
    <div ref={ref} className="bm-card bm-composer" role="dialog" aria-label="New Pin" data-testid="bm-composer"
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(false); } if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSave?.(!owner && !sendInstantly); } }}>
      <div className="bm-card-head">
        <span className="bm-pin bm-pin-inline" style={{ '--c': kindMeta.color }} aria-hidden="true"><span className="bm-pin-no">+</span></span>
        <div className="bm-card-title">{draft.edit ? 'New Edit Pin' : 'New Pin'}{pick?.mode === 'region' ? <span className="bm-dim bm-small"> · region</span> : null}</div>
        <button type="button" className="bm-icon-btn" onClick={() => onCancel?.(false)} aria-label="Close composer"><X size={16} /></button>
      </div>
      <div className="bm-card-body">
        {hint && <div className="bm-looks" title={pick?.target?.selector}>{hint}</div>}
        {owner && <div className="bm-hint bm-hint-amber" role="note" data-testid="bm-owner-line">This is {owner.name}&apos;s area - it goes to {owner.name}, not Claude Code.</div>}
        <div className="bm-pills" role="radiogroup" aria-label="Kind">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={draft.kind === k.id} className={`bm-pill${draft.kind === k.id ? ' is-on' : ''}`} style={{ '--c': k.color }} onClick={() => set({ kind: k.id })}>{k.label}</button>
          ))}
        </div>
        <div className="bm-pills" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={draft.priority === p.id} className={`bm-pill bm-pill-sm${draft.priority === p.id ? ' is-on' : ''}`} style={{ '--c': p.color }} onClick={() => set({ priority: p.id })}>{p.label}</button>
          ))}
        </div>
        {draft.edit?.note && <div className="bm-edit-note"><b>Edit:</b> {draft.edit.note}</div>}
        <div className="bm-comment-wrap nx-fill">
          <textarea ref={textRef} className="bm-textarea bm-comment-box" value={draft.comment || ''} onChange={(e) => set({ comment: e.target.value })} onPaste={onPaste}
            placeholder={draft.kind === 'question' ? 'What do you want to know about this?' : 'What is wrong, or what should change?'} aria-label="Comment" rows={4} />
          {interim && <div className="bm-interim" aria-live="polite">{interim}</div>}
          <div className="bm-paste-hint">or press {MOD}+V to paste a screenshot{uploading > 0 && <> · <Loader2 size={11} className="bm-spin" /> uploading</>}</div>
        </div>
        {(draft.attachments || []).length > 0 && (
          <div className="bm-thumbs">
            {draft.attachments.map((u) => (
              <span key={u} className="bm-thumb-wrap">
                <img className="bm-thumb" src={toViewUrl(u)} alt="" />
                <button type="button" className="bm-thumb-x" onClick={() => removeAttachment(u)} aria-label="Remove image"><X size={10} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="bm-tools-row">
          {speechSupported() && (
            <button type="button" className={`bm-btn bm-btn-sm${voiceOn ? ' is-live' : ''}`}
              onPointerDown={(e) => { e.preventDefault(); if (!voiceOn) onVoiceStart?.(); }}
              onPointerUp={() => { if (voiceOn) onVoiceStop?.(); }} onPointerLeave={() => { if (voiceOn) onVoiceStop?.(); }} onPointerCancel={() => onVoiceStop?.()}
              title="Hold to talk - what you say is added to the comment (M)" aria-pressed={voiceOn}>
              <Mic size={14} /> {voiceOn ? 'Listening…' : 'Hold To Talk'}
            </button>
          )}
          {recording
            ? <button type="button" className="bm-btn bm-btn-sm is-rec" onClick={onStopRecord} title="Stop recording (V)"><CircleStop size={14} /> Stop · {fmtDur(Date.now() - recording.startedAt)}</button>
            : <button type="button" className="bm-btn bm-btn-sm" onClick={onRecord} disabled={!!saving} title="Record the screen with your voice (V)"><Video size={14} /> {recorded ? 'Record Again' : 'Record'}</button>}
          {markupCount > 0 && (
            <span className="bm-chip-info">{markupCount} markup item{markupCount === 1 ? '' : 's'} <button type="button" className="bm-link-btn" onClick={onClearMarkup}>clear</button></span>
          )}
          <span className={`bm-chip-info bm-push ${capture === 'live' ? 'is-ok' : ''}`} title={capture === 'live' ? 'The screenshot is taken when you save' : 'Screenshots are off'}>
            {capture === 'live' ? <><Camera size={12} /> Screenshot on save</> : <><CameraOff size={12} /> No screenshot</>}
          </span>
        </div>
        {recording && (
          <div className="bm-live" aria-live="polite">
            <div className="bm-live-head"><span className="bm-rec-dot" /> Recording{speechSupported() ? ' - live transcript' : ''}</div>
            <div className="bm-live-text">{recording.transcript || (speechSupported() ? 'Say what you see…' : 'Speech-to-text is not available in this browser; the video still records your voice.')}</div>
          </div>
        )}
        {recorded && !recording && (
          <div className="bm-recorded">
            <Check size={13} /> Video attached ({fmtDur(recorded.durationMs)}){recorded.sheetUrl ? <img className="bm-thumb" src={recorded.sheetUrl} alt="Recording frames" /> : null}
            {recorded.transcript && <details className="bm-details"><summary>Transcript</summary><pre className="bm-pre">{recorded.transcript}</pre></details>}
          </div>
        )}
        {capture !== 'live' && capture !== 'idle' && (
          <div className="bm-hint bm-small">Screenshots are off - turn Build Mode off and on to allow tab capture.</div>
        )}
        {err && <div className="bm-error" role="alert">{err}</div>}
      </div>
      <div className="bm-card-foot">
        {confirmDiscard
          ? <span className="bm-confirm">Discard this pin? <button type="button" className="bm-btn bm-btn-danger" onClick={() => onCancel?.(true)}>Discard</button><button type="button" className="bm-btn bm-btn-ghost" onClick={() => setConfirmDiscard(false)}>Keep</button></span>
          : <button type="button" className="bm-btn bm-btn-ghost" onClick={() => ((draft.comment || '').trim() || draft.attachments?.length || recorded ? setConfirmDiscard(true) : onCancel?.(true))} disabled={!!saving}><Trash2 size={14} /> Discard</button>}
        <span className="bm-push" />
        {owner ? (
          <button type="button" className="bm-btn bm-btn-primary" onClick={() => onSave?.(false)} disabled={busy} title={`${MOD}+Enter`}>
            {saving === 'save' ? <Loader2 size={14} className="bm-spin" /> : <Check size={14} />} Save For {owner.name}
          </button>
        ) : (
          <button type="button" className={`bm-btn${sendInstantly ? ' bm-btn-primary' : ''}`} onClick={() => onSave?.(false)} disabled={busy}>
            {saving === 'save' ? <Loader2 size={14} className="bm-spin" /> : <Check size={14} />} {sendInstantly ? 'Save And Send' : 'Save Pin'}
          </button>
        )}
        {!sendInstantly && !owner && (
          <button type="button" className="bm-btn bm-btn-primary" onClick={() => onSave?.(true)} disabled={busy} title={`${MOD}+Enter`}>
            {saving === 'send' ? <Loader2 size={14} className="bm-spin" /> : <Send size={14} />} Save And Send
          </button>
        )}
      </div>
    </div>
  );
}
