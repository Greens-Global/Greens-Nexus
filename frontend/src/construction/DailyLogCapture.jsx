// Daily Log capture - the worker's two minutes.
//
// Design constraint that drives everything here: someone on a jobsite, on a
// phone, in gloves, in sunlight, on bad LTE. So:
//   - Three big targets, no menus to discover. Camera / Video / Voice.
//   - Uploads start the instant a file is picked, not on Submit. By the time
//     they press Submit the bytes are already gone.
//   - A failed upload is retryable in place and never blocks the others.
//   - Nothing is required. A log of three photos and no typing is valid and is
//     the common case; the AI writes the prose afterwards.
//
// Mobile capture uses the hidden-input `capture="environment"` trick, the same
// pattern as tickets/TicketsView.jsx and tasks/QuickCreateTask.jsx. There is no
// getUserMedia video preview anywhere in this codebase and building one would
// be worse: the OS camera app is faster, better, and already familiar.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, Video, Mic, Paperclip, X, Send, AlertTriangle,
  RotateCcw, Square, Trash2, CheckCircle2,
} from 'lucide-react';
import { api } from '../api';
import { uploadConstructionMedia, validate, kindOf, filesFromPaste } from './lib/upload';

// One row per file the worker picked, tracked client-side until the server has
// a media row for it. `status` drives the whole strip:
//   uploading -> the bytes are in flight
//   done      -> Supabase has it AND the server registered it
//   error     -> retryable in place; the file stays in the list
const newItem = (file) => ({
  key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
  file, kind: kindOf(file), status: 'uploading', error: '', media: null, preview: '',
});

function Tile({ icon: Icon, label, onClick, disabled, danger }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{
        flex: 1, minWidth: 96, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 8, padding: '20px 8px', borderRadius: 14, cursor: 'pointer',
        border: `1px solid ${danger ? 'hsl(var(--color-red))' : 'var(--border-color)'}`,
        backgroundColor: danger ? 'hsl(var(--color-red) / 0.08)' : 'var(--bg-card)',
        color: danger ? 'hsl(var(--color-red))' : 'var(--text-primary)',
        opacity: disabled ? 0.5 : 1, fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 600,
      }}>
      <Icon size={26} />{label}
    </button>
  );
}

export default function DailyLogCapture({ log, project, onClose, onSubmitted }) {
  const [items, setItems] = useState([]);
  const [notes, setNotes] = useState(log.notes || '');
  const [crew, setCrew] = useState(log.crewSize || '');
  const [hours, setHours] = useState(log.hoursWorked || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef(null);
  const camRef = useRef(null);
  const vidRef = useRef(null);
  const fileRef = useRef(null);

  // Media already attached (the worker backgrounded the app and came back, or
  // a manager bounced the log back for more).
  useEffect(() => {
    api.getConstructionMedia(log.id)
      .then((rows) => setItems(rows.map((m) => ({
        key: m.id, file: null, kind: m.kind, status: 'done', error: '',
        media: m, preview: m.thumbnailUrl || m.url,
      }))))
      .catch(() => { /* an empty strip is the correct fallback, not an error */ });
  }, [log.id]);

  const patch = useCallback((key, next) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...next } : it)));
  }, []);

  const upload = useCallback(async (item) => {
    patch(item.key, { status: 'uploading', error: '' });
    const { payload, error: upErr } = await uploadConstructionMedia(item.file, { projectId: project.id });
    if (upErr) { patch(item.key, { status: 'error', error: upErr }); return; }
    try {
      const media = await api.createConstructionMedia(log.id, payload);
      patch(item.key, { status: 'done', media, preview: media.url });
    } catch (e) {
      // Supabase has the bytes but the server has no row. Retry re-uploads to a
      // fresh key rather than trying to reconcile - a duplicate object is
      // cheap, a media row pointing at nothing is not.
      patch(item.key, { status: 'error', error: e.message || 'Could not attach that file.' });
    }
  }, [log.id, project.id, patch]);

  const add = useCallback((files) => {
    const picked = Array.from(files || []).filter(Boolean);
    if (!picked.length) return;
    const rejected = picked.map((f) => ({ f, why: validate(f) })).filter((r) => r.why);
    if (rejected.length) setError(rejected[0].why);
    const accepted = picked.filter((f) => !validate(f));
    const fresh = accepted.map(newItem);
    setItems((prev) => [...prev, ...fresh]);
    // Sequential, not parallel: eight concurrent uploads on jobsite LTE is how
    // you get eight timeouts instead of eight files. Same reasoning as
    // egnyte/EgnyteUpload.jsx's deliberate for-loop.
    (async () => { for (const it of fresh) await upload(it); })();
  }, [upload]);

  // Window-level paste so the worker never has to click into a drop zone first.
  // Skips form fields so Ctrl+V still pastes text into the notes box.
  useEffect(() => {
    const onPaste = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = filesFromPaste(e);
      if (files.length) { e.preventDefault(); add(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [add]);

  // ── Voice note ────────────────────────────────────────────────────────────
  // Adapted from lib/screenRecorder.js's MediaRecorder pattern (mime picking,
  // chunk collection, stop-and-flush) but on getUserMedia({audio:true}) rather
  // than getDisplayMedia. Every track is stopped on the way out or the phone
  // keeps showing a recording indicator.
  const pickAudioMime = () => {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return '';
  };

  const startVoice = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickAudioMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        const ext = type.includes('mp4') ? 'm4a' : 'weba';
        add([new File([blob], `voice-${Date.now()}.${ext}`, { type })]);
        setRecording(false);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // Denied permission, no mic, or an insecure origin. Say which action is
      // blocked rather than "an error occurred".
      setError('Could not start recording. Allow microphone access and try again.');
      setRecording(false);
    }
  };

  const stopVoice = () => { try { recorderRef.current?.stop(); } catch { setRecording(false); } };

  // A tab closed mid-recording must not leave the mic light on.
  useEffect(() => () => {
    try { recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already gone */ }
  }, []);

  const remove = async (item) => {
    if (item.media) { try { await api.deleteConstructionMedia(item.media.id); } catch { /* soft delete is best effort */ } }
    setItems((prev) => prev.filter((i) => i.key !== item.key));
  };

  const pending = items.filter((i) => i.status === 'uploading').length;
  const failed = items.filter((i) => i.status === 'error').length;
  // Distinct reasons, not one line per file: eight photos failing for the same
  // reason is one problem, and eight identical red lines buries it.
  const failedReasons = [...new Set(
    items.filter((i) => i.status === 'error').map((i) => i.error).filter(Boolean),
  )];
  const attached = items.filter((i) => i.status === 'done').length;
  const canSubmit = !submitting && !pending && (attached > 0 || notes.trim().length > 0);

  // The typed half of the log. Media uploads itself the moment it is picked;
  // notes, crew and hours only exist in component state until this runs.
  const patchLog = () => api.updateConstructionLog(log.id, {
    notes_raw: notes,
    ...(crew !== '' ? { crew_size: Number(crew) } : {}),
    ...(hours !== '' ? { hours_worked: Number(hours) } : {}),
  });

  // Save & Close used to call onClose directly, so everything the worker had
  // typed was thrown away by a button that says Save. That is the worst
  // possible failure for this screen: uploads survived, the words did not, and
  // nothing said so. Both exits route through here now.
  //
  // A failed save keeps the sheet OPEN. Closing anyway would discard the text
  // in the same silent way, and the whole point is that the worker never
  // retypes anything.
  const saveAndClose = async () => {
    if (submitting) return;
    setSubmitting(true); setError('');
    try {
      await patchLog();
      onClose();
    } catch (e) {
      setSubmitting(false);
      setError(e.message || 'Could not save this log. Your notes are still here - try again.');
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true); setError('');
    try {
      // Notes and conditions are saved before submit, because submit freezes the
      // log - PATCH after that is a 409 by design.
      await patchLog();
      await api.submitConstructionLog(log.id);
      onSubmitted();
    } catch (e) {
      setSubmitting(false);
      setError(e.message || 'Could not submit the log.');
    }
  };

  return (
    <div className="modal-overlay" style={{ display: 'flex', alignItems: 'stretch' }}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 'clamp(520px, 60vw, 900px)', width: '100%', display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", margin: 0 }}>Daily Log</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '4px 0 0' }}>
              {project.name} &middot; {log.logDate}
            </p>
          </div>
          {/* Saves too. An X that discards what was typed is the same data loss
              as the old Save & Close, just with less warning. */}
          <button className="secondary-btn" onClick={saveAndClose} disabled={submitting}
            style={{ padding: 8 }} title="Save and close"><X size={16} /></button>
        </div>

        {error && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginTop: 16,
            borderRadius: 8, backgroundColor: 'hsl(var(--color-red) / 0.08)',
            border: '1px solid hsl(var(--color-red) / 0.3)', fontSize: '0.85rem',
          }}>
            <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{error}</span>
            <button className="secondary-btn" style={{ padding: '2px 10px', fontSize: '0.75rem' }}
              onClick={() => setError('')}>Dismiss</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          <Tile icon={Camera} label="Photo" onClick={() => camRef.current?.click()} disabled={recording} />
          <Tile icon={Video} label="Video" onClick={() => vidRef.current?.click()} disabled={recording} />
          {recording
            ? <Tile icon={Square} label="Stop" onClick={stopVoice} danger />
            : <Tile icon={Mic} label="Voice" onClick={startVoice} />}
          <Tile icon={Paperclip} label="File" onClick={() => fileRef.current?.click()} disabled={recording} />
        </div>

        {recording && (
          <div style={{ marginTop: 12, textAlign: 'center', fontSize: '0.85rem', color: 'hsl(var(--color-red))', fontWeight: 600 }}>
            Recording&hellip; tap Stop when you are done
          </div>
        )}

        {/* capture="environment" opens the rear camera straight into the OS
            camera app on a phone, and degrades to a normal file picker on
            desktop - no branching needed. */}
        <input ref={camRef} type="file" accept="image/*" capture="environment" multiple hidden
          onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <input ref={vidRef} type="file" accept="video/*" capture="environment" hidden
          onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" multiple hidden
          onChange={(e) => { add(e.target.files); e.target.value = ''; }} />

        <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 18 }}>
          {items.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '20px 0' }}>
              Nothing attached yet. Take a photo, record a clip, or press Ctrl+V to paste one.
            </p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
              {items.map((it) => (
                <div key={it.key} style={{
                  position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'hidden',
                  border: `1px solid ${it.status === 'error' ? 'hsl(var(--color-red))' : 'var(--border-color)'}`,
                  backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', flexDirection: 'column', gap: 4,
                }}>
                  {it.kind === 'photo' && it.preview
                    ? <img src={it.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <>{it.kind === 'video' ? <Video size={22} /> : it.kind === 'audio' ? <Mic size={22} /> : <Paperclip size={22} />}
                       <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{it.kind}</span></>}

                  {it.status === 'uploading' && (
                    <div style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      backgroundColor: 'rgba(0,0,0,.55)', color: '#fff', fontSize: '0.7rem', fontWeight: 600,
                    }}>Uploading&hellip;</div>
                  )}
                  {it.status === 'error' && (
                    <div title={it.error} style={{
                      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 6,
                      alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,.6)', color: '#fff', padding: 6,
                    }}>
                      <span style={{ fontSize: '0.62rem', textAlign: 'center', lineHeight: 1.25 }}>Failed</span>
                      <button type="button" onClick={() => upload(it)} title="Retry"
                        style={{ background: 'none', border: '1px solid #fff', borderRadius: 6, color: '#fff', padding: '2px 8px', fontSize: '0.65rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <RotateCcw size={11} />Retry
                      </button>
                    </div>
                  )}
                  {it.status === 'done' && (
                    <CheckCircle2 size={14} style={{ position: 'absolute', top: 4, left: 4, color: 'hsl(var(--color-green))', backgroundColor: '#fff', borderRadius: '50%' }} />
                  )}
                  <button type="button" onClick={() => remove(it)} title="Remove"
                    style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,.55)', border: 'none', borderRadius: 6, color: '#fff', padding: 3, cursor: 'pointer', display: 'inline-flex' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {failedReasons.length > 0 && (
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12,
              padding: '10px 14px', borderRadius: 8, fontSize: '0.8rem',
              backgroundColor: 'hsl(var(--color-red) / 0.08)',
              border: '1px solid hsl(var(--color-red) / 0.3)',
            }}>
              <AlertTriangle size={15} style={{ color: 'hsl(var(--color-red))', flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: 'block', marginBottom: failedReasons.length > 1 ? 4 : 0 }}>
                  {failed === 1 ? '1 file did not attach' : `${failed} files did not attach`}
                </strong>
                {failedReasons.map((r) => (
                  <div key={r} style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>{r}</div>
                ))}
              </div>
            </div>
          )}

          <label className="form-label" style={{ marginTop: 18 }}>Notes (optional)</label>
          <textarea className="form-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the photos do not show" style={{ resize: 'vertical', fontFamily: 'inherit' }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <label className="form-label">Crew size</label>
              <input className="form-input" type="number" inputMode="numeric" min="0" value={crew}
                onChange={(e) => setCrew(e.target.value)} placeholder="e.g. 6" />
            </div>
            <div>
              <label className="form-label">Hours worked</label>
              <input className="form-input" type="number" inputMode="decimal" min="0" step="0.5" value={hours}
                onChange={(e) => setHours(e.target.value)} placeholder="e.g. 8" />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
          <div style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {pending > 0 ? `Uploading ${pending}…`
              : failed > 0 ? `${attached} attached, ${failed} failed`
                : attached > 0 ? `${attached} attached` : 'Nothing attached yet'}
          </div>
          <button className="secondary-btn" onClick={saveAndClose} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save & Close'}
          </button>
          {/* No inline background: .primary-btn already carries var(--pine) and
              dims itself at :disabled. */}
          <button className="primary-btn" onClick={submit} disabled={!canSubmit}
            title={pending ? 'Wait for uploads to finish' : !canSubmit ? 'Attach something or write a note' : ''}>
            <Send size={15} />{submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
