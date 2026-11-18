// Daily Log capture - the worker's two minutes.
//
// Design constraint that drives everything here: someone on a jobsite, on a
// phone, in gloves, in sunlight, on bad LTE. So:
//   - Three big targets, no menus to discover. Camera / Video / Voice.
//   - Uploads start the instant a file is picked, not on Submit. By the time
//     they press Submit the bytes are already gone.
//   - A failed upload is retryable in place and never blocks the others.
//   - Nothing is required. A log of three photos and no typing is valid and is
//     the common case.
//   - The crew can flag the day themselves - Delay, Safety, Issue, Weather
//     (11/03/2026): what a person said counts whether or not any AI ran.
//   - Where the phone is goes with the log when the person allows location
//     (navigator.geolocation) - optional, asked once, never blocks a thing; the
//     server records the advisory geofence check from it.
//   - The log drafts itself (Neil, 11/03/2026, plan phase 3): weather from the
//     jobsite's forecast, crew and hours from today's Time Clock punches at
//     the jobsite (hours only), today's photos, punch items Done / Verified
//     today and the forms filed to the job today - all editable; the person
//     adds what was unusual (dictation), tags the day, and gives each delay
//     its own line (cause, hours lost). One Submit, with their typed name.
//   - It works with no signal: the log, its photos, the edits and the Submit
//     wait in the phone's outbox (constructionOffline) and go out in order;
//     the prefill comes from what the phone saved.
//
// Mobile capture uses the hidden-input `capture="environment"` trick, the same
// pattern as tickets/TicketsView.jsx and tasks/QuickCreateTask.jsx. There is no
// getUserMedia video preview anywhere in this codebase and building one would
// be worse: the OS camera app is faster, better, and already familiar.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, Video, Mic, Paperclip, X, Send, AlertTriangle,
  RotateCcw, Square, Trash2, CheckCircle2, MapPin,
} from 'lucide-react';
import { api } from '../api';
import { uploadConstructionMedia, validate, kindOf, filesFromPaste } from './lib/upload';
import { formatDate } from '../lib/datetime';
import { useVoiceRecorder, clock, STOP_VOICE_FIRST } from '../lib/voice';
import { useIsMobile } from '../lib/useIsMobile';
import DictateButton from '../components/DictateButton';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { dialog } from '../ui/dialog';
import { useRole } from '../contexts/RoleContext';
import { LOG_TAGS, TAG_COLOR, TONE } from './ui';
import { formatDateTime, formatTime } from '../lib/datetime';
import { isOffline } from '../lib/offline/store';
import SyncState from '../components/offline/SyncState';
import { StatusLabel } from '../components/StatusLabel';
import { addLogPhoto, loadPrefill, saveLogPatch, submitLog } from './constructionOffline';
import { formatHoursWords } from '../lib/hoursText';

const DELAY_CAUSES = [
  ['weather', 'Weather'], ['inspection', 'Inspection'], ['material', 'Material'], ['labor', 'Labor'],
  ['owner', 'Owner or Client'], ['design', 'Design or RFI'], ['equipment', 'Equipment'], ['other', 'Other'],
];
const unanswered = (e) => !!e && (e.isNetworkError || !e.status);

// What today's log was drafted from (construction_field.prefill) - shown, so
// the person can see where each number came from and fix what is wrong.
function DraftedFrom({ pre, savedAt }) {
  if (!pre) return null;
  const done = pre.punch?.done || [];
  const verified = pre.punch?.verified || [];
  const line = { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 };
  return (
    <details data-drafted-from="" open style={{ marginTop: 16, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Drafted From Today</summary>
      {savedAt && <div style={line}>From this phone (saved {formatDateTime(savedAt, '')}).</div>}
      <div style={line}><b>Weather:</b> {pre.weather?.text ? `${pre.weather.text} (forecast)` : 'No forecast for this jobsite - type it in.'}</div>
      <div style={line}><b>Crew:</b> {pre.crew?.count ? `${pre.crew.count} ${pre.crew.count === 1 ? 'person' : 'people'} punched in here, ${formatHoursWords(pre.crew.hours, { compact: true })}` : 'No Time Clock punches at this jobsite yet today.'}
        {(pre.crew?.people || []).length > 0 && ` (${pre.crew.people.map((p) => `${p.name || p.email} ${formatHoursWords(p.hours, { compact: true })}`).join(', ')})`}</div>
      {(pre.photos || []).length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }} aria-label="Today's photos">
          {pre.photos.slice(0, 12).map((p) => <img key={p.id} src={p.thumbnailUrl || p.url} alt={p.caption || 'Photo from today'} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }} />)}
          <span style={line}>{pre.photos.length} photo{pre.photos.length === 1 ? '' : 's'} on the job today</span>
        </div>
      )}
      {(done.length > 0 || verified.length > 0) && (
        <div style={line}><b>Punch:</b> {[done.length ? `${done.length} done (${done.map((d) => d.title).join(', ')})` : '', verified.length ? `${verified.length} verified` : ''].filter(Boolean).join('; ')}</div>
      )}
      {(pre.forms || []).length > 0 && (
        <div style={line}><b>Forms:</b> {pre.forms.map((f) => `${f.title}${f.submittedByName ? ` by ${f.submittedByName}` : ''} at ${formatTime(f.submittedAt, '')}`).join('; ')}</div>
      )}
    </details>
  );
}

// Where the phone is, if the person allows it - one quick, low-power fix,
// never waited on: a jobsite with no signal or a "no" files the log anyway.
function usePhoneLocation() {
  const [fix, setFix] = useState(null);
  useEffect(() => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : null;
    if (!geo || typeof geo.getCurrentPosition !== 'function') return undefined;
    let live = true;
    try {
      geo.getCurrentPosition(
        (pos) => { if (live && pos?.coords) setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }); },
        () => { /* refused or unavailable: the log files without it */ },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
      );
    } catch { /* a browser that throws here simply has no location */ }
    return () => { live = false; };
  }, []);
  return fix;
}

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
        opacity: disabled ? 0.5 : 1, fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
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
  const [tags, setTags] = useState(log.tags || []);
  const [weather, setWeather] = useState(log.weather || '');
  const [temp, setTemp] = useState(log.temperatureF || '');
  const [weatherTyped, setWeatherTyped] = useState(false);
  const [delays, setDelays] = useState(log.delays || []);
  const [subs, setSubs] = useState(log.subs || []);
  // The job's own subs (Round Two item 7) as the names to pick from.
  const [jobSubs, setJobSubs] = useState([]);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getJobSubs?.(project.id))
      .then((d) => { if (live) setJobSubs(d?.subs || []); })
      .catch(() => {});
    return () => { live = false; };
  }, [project.id]);
  const [signedName, setSignedName] = useState('');
  const [pre, setPre] = useState(null);
  const [preSaved, setPreSaved] = useState('');
  const [queuedSubmit, setQueuedSubmit] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const fix = usePhoneLocation();
  const { myEmail } = useRole() || {};
  const isMobile = useIsMobile();
  const toggleTag = (k) => setTags((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]));
  const camRef = useRef(null);
  const vidRef = useRef(null);
  const fileRef = useRef(null);

  // What the log drafts itself from (the phone's copy with no signal).
  useEffect(() => {
    let live = true;
    loadPrefill(project.id, log.logDate, { onCache: (at) => { if (live) setPreSaved(at); } })
      .then((p) => { if (live) setPre(p); })
      .catch(() => { /* no prefill: the log is still the person's to fill */ });
    return () => { live = false; };
  }, [project.id, log.logDate]);

  // Media already attached (the worker backgrounded the app and came back, or
  // a manager bounced the log back for more). A log made on this phone with
  // no signal has none on the server yet.
  useEffect(() => {
    if (log.local) return;
    api.getConstructionMedia(log.id)
      .then((rows) => setItems(rows.map((m) => ({
        key: m.id, file: null, kind: m.kind, status: 'done', error: '',
        media: m, preview: m.thumbnailUrl || m.url,
      }))))
      .catch(() => { /* an empty strip is the correct fallback, not an error */ });
  }, [log.id, log.local]);

  const patch = useCallback((key, next) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...next } : it)));
  }, []);

  // No signal (or a log still on the phone): the photo waits in the outbox
  // and goes up when there is signal - shown with its sync state.
  const queuePhoto = useCallback(async (item) => {
    try {
      const out = await addLogPhoto(log, project, item.file);
      if (out?.queued) patch(item.key, { status: 'queued', entryId: out.queued.id, error: '' });
      else patch(item.key, { status: 'done', media: out.result, preview: out.result?.url || item.preview });
    } catch (e) { patch(item.key, { status: 'error', error: e.message || 'Could not keep that file on this phone.' }); }
  }, [log, project, patch]);

  const upload = useCallback(async (item) => {
    if (isOffline() || log.local) { await queuePhoto(item); return; }
    patch(item.key, { status: 'uploading', error: '' });
    const { payload, error: upErr } = await uploadConstructionMedia(item.file, { projectId: project.id });
    if (upErr) { patch(item.key, { status: 'error', error: upErr }); return; }
    try {
      const media = await api.createConstructionMedia(log.id, payload);
      patch(item.key, { status: 'done', media, preview: media.url });
    } catch (e) {
      // The signal dropped mid-send: the outbox keeps it and sends it.
      if (unanswered(e)) { await queuePhoto(item); return; }
      // Supabase has the bytes but the server has no row. Retry re-uploads to a
      // fresh key rather than trying to reconcile - a duplicate object is
      // cheap, a media row pointing at nothing is not.
      patch(item.key, { status: 'error', error: e.message || 'Could not attach that file.' });
    }
  }, [log.id, log.local, project.id, patch, queuePhoto]);

  const add = useCallback((files) => {
    const picked = Array.from(files || []).filter(Boolean);
    if (!picked.length) return;
    const rejected = picked.map((f) => ({ f, why: validate(f) })).filter((r) => r.why);
    if (rejected.length) setError(rejected[0].why);
    const accepted = picked.filter((f) => !validate(f));
    const fresh = accepted.map((f) => ({ ...newItem(f), preview: kindOf(f) === 'photo' && typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(f) : '' }));
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
  // The shared recorder (lib/voice.js, Oct 30 2026): one microphone even on a
  // double tap, 15 minutes at most, and the mic is released when the log
  // closes mid-recording. The clip joins the strip like any picked file.
  const voice = useVoiceRecorder((file) => add([file]));
  const recording = voice.recording;
  const startVoice = () => { setError(''); voice.start(); };
  const stopVoice = voice.stop;
  const notesRef = useRef(null);

  // A file not yet on the server just leaves the strip.
  const drop = (item) => setItems((prev) => prev.filter((i) => i.key !== item.key));

  // A file already filed is evidence (11/03/2026): it is removed by a press
  // and hold (HoldButton), and someone else's only with a reason on the
  // record - the server refuses one in front of a reviewer, and the refusal
  // shows under the button.
  const removeFiled = async (item) => {
    const by = String(item.media?.uploadedBy || '').toLowerCase();
    const mine = !myEmail || !by || by === String(myEmail).toLowerCase();
    if (mine) {
      await api.deleteConstructionMedia(item.media.id);
    } else {
      const reason = await dialog.prompt('Why is this file being removed? The reason goes on the record.', {
        title: 'Remove a File', confirmText: 'Remove', required: true, placeholder: 'e.g. Wrong jobsite',
      });
      if (!reason) throw new Error('Not removed - a reason is needed.');
      await api.removeConstructionMedia(item.media.id, reason);
    }
    drop(item);
  };

  const pending = items.filter((i) => i.status === 'uploading').length;
  const failed = items.filter((i) => i.status === 'error').length;
  // Distinct reasons, not one line per file: eight photos failing for the same
  // reason is one problem, and eight identical red lines buries it.
  const failedReasons = [...new Set(
    items.filter((i) => i.status === 'error').map((i) => i.error).filter(Boolean),
  )];
  const attached = items.filter((i) => i.status === 'done' || i.status === 'queued').length;
  // A voice note still recording: Submit and Save & Close wait for Stop - the
  // clip is only kept once it is stopped.
  const canSubmit = !submitting && !pending && !recording && (attached > 0 || notes.trim().length > 0) && signedName.trim().length > 1;

  // The typed half of the log. Media uploads itself the moment it is picked;
  // notes, crew and hours only exist in component state until this runs.
  const patchLog = () => saveLogPatch(log, {
    notes_raw: notes,
    tags,
    weather,
    ...(weatherTyped ? { weather_source: 'typed' } : {}),
    ...(temp !== '' && temp !== null ? { temperature_f: Number(temp) } : {}),
    delays: delays.filter((d) => d.cause).map((d) => ({ cause: d.cause, hours: Number(d.hours) || 0, note: d.note || '' })),
    subs: subs.filter((s) => String(s.name || '').trim()).map((s) => ({ name: s.name.trim(), headcount: Number(s.headcount) || 0, hours: Number(s.hours) || 0 })),
    ...(crew !== '' ? { crew_size: Number(crew) } : {}),
    ...(hours !== '' ? { hours_worked: Number(hours) } : {}),
    ...(fix ? { gps_latitude: fix.lat, gps_longitude: fix.lng, gps_accuracy_m: fix.acc || 0 } : {}),
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
      const out = await submitLog(log, signedName.trim());
      // Saved on this phone: it goes out when there is signal, in order.
      if (out?.queued) { setQueuedSubmit(out.queued.id); setSubmitting(false); return; }
      onSubmitted();
    } catch (e) {
      setSubmitting(false);
      setError(e.message || 'Could not submit the log.');
    }
  };

  return (
    <div className="modal-overlay" style={{ display: 'flex', alignItems: 'stretch' }}>
      <div className="modal-content nx-popup" onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'column', padding: '22px 24px 20px' }}>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Daily Log</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '4px 0 0' }}>
              {project.name} &middot; {formatDate(log.logDate, log.logDate)}
            </p>
          </div>
          {/* Saves too. An X that discards what was typed is the same data loss
              as the old Save & Close, just with less warning. On a phone the
              close lives in the bar at the bottom, within thumb reach. */}
          {!isMobile && (
            <button className="secondary-btn" onClick={saveAndClose} disabled={submitting || recording}
              style={{ padding: 8 }} title={recording ? STOP_VOICE_FIRST : 'Save and close'} aria-label="Save and close"><X size={16} /></button>
          )}
        </div>

        {/* Sent back: the reviewer's question, where the answer gets written. */}
        {log.status === 'needs_info' && log.reviewNote && (
          <div data-review-note="" style={{ marginTop: 16, padding: '10px 14px', borderRadius: 8, fontSize: 13,
            background: 'var(--bg-primary)', border: '1px solid var(--border-color)', lineHeight: 1.5 }}>
            <strong>{log.reviewedByName || 'Your manager'} asks:</strong> {log.reviewNote}
          </div>
        )}

        <DraftedFrom pre={pre} savedAt={preSaved} />

        {queuedSubmit && (
          <div role="status" style={{ marginTop: 16, padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border-color)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 14 }}>Saved on This Phone</b>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>The log, its photos and your signature go out when there is signal.</span>
            <SyncState id={queuedSubmit} />
            <button className="primary-btn" onClick={onSubmitted}>Done</button>
          </div>
        )}

        {(error || voice.error) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginTop: 16,
            borderRadius: 8, backgroundColor: 'hsl(var(--color-red) / 0.08)',
            border: '1px solid hsl(var(--color-red) / 0.3)', fontSize: 13,
          }}>
            <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{error || voice.error}</span>
            <button className="secondary-btn" style={{ padding: '2px 10px', fontSize: '0.75rem' }}
              onClick={() => { setError(''); voice.setError(''); }}>Dismiss</button>
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
          <div style={{ marginTop: 12, textAlign: 'center', fontSize: 13, color: 'hsl(var(--color-red))', fontWeight: 600 }}>
            Recording {clock(voice.seconds)} - tap Stop when you are done
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
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, padding: '20px 0' }}>
              Nothing attached yet. Take a photo, record a clip, or press Ctrl+V to paste one.
            </p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
              {items.map((it) => (
                <div key={it.key} data-capture-item={it.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <div style={{
                  position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'hidden',
                  border: `1px solid ${it.status === 'error' ? 'hsl(var(--color-red))' : 'var(--border-color)'}`,
                  backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', flexDirection: 'column', gap: 4,
                }}>
                  {it.kind === 'photo' && it.preview
                    ? <img src={it.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <>{it.kind === 'video' ? <Video size={22} /> : it.kind === 'audio' ? <Mic size={22} /> : <Paperclip size={22} />}
                       <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{it.kind}</span></>}

                  {it.status === 'uploading' && (
                    <div style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      backgroundColor: 'rgba(0,0,0,.55)', color: '#fff', fontSize: 11, fontWeight: 600,
                    }}>Uploading&hellip;</div>
                  )}
                  {it.status === 'error' && (
                    <div title={it.error} style={{
                      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 6,
                      alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,.6)', color: '#fff', padding: 6,
                    }}>
                      <span style={{ fontSize: 11, textAlign: 'center', lineHeight: 1.25 }}>Failed</span>
                      <button type="button" onClick={() => upload(it)} title="Retry"
                        style={{ background: 'none', border: '1px solid #fff', borderRadius: 6, color: '#fff', padding: '2px 8px', fontSize: 11, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <RotateCcw size={11} />Retry
                      </button>
                    </div>
                  )}
                  {it.status === 'done' && (
                    <CheckCircle2 size={14} style={{ position: 'absolute', top: 4, left: 4, color: 'hsl(var(--color-green))', backgroundColor: '#fff', borderRadius: '50%' }} />
                  )}
                  {it.status === 'queued' && (
                    <span style={{ position: 'absolute', bottom: 4, left: 4, right: 4 }}><SyncState id={it.entryId} /></span>
                  )}
                  {!it.media && it.status !== 'queued' && (
                    <button type="button" onClick={() => drop(it)} title="Remove" aria-label="Remove"
                      style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,.55)', border: 'none', borderRadius: 6, color: '#fff', padding: 3, cursor: 'pointer', display: 'inline-flex' }}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {it.media && (
                  <HoldButton label="Remove" doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                    ariaLabel={`Remove this ${it.kind || 'file'}`} onConfirm={() => removeFiled(it)}
                    fallbackMessage="Remove this file from the log?" style={{ width: '100%', justifyContent: 'center' }} />
                )}
                </div>
              ))}
            </div>
          )}

          {failedReasons.length > 0 && (
            <div style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12,
              padding: '10px 14px', borderRadius: 8, fontSize: 13,
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

          {/* The crew's words as text (Oct 30 2026): a voice note is never
              transcribed (AI is off), so the mic types the notes instead. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
            <label className="form-label" htmlFor="dl-notes" style={{ margin: 0 }}>Notes (optional)</label>
            <DictateButton target={notesRef} title="Say the Notes" />
          </div>
          <textarea id="dl-notes" ref={notesRef} className="form-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the photos do not show - or tap the mic and say it" style={{ resize: 'vertical', fontFamily: 'inherit' }} />

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 12, marginTop: 12 }}>
            <div>
              <label className="form-label" htmlFor="dl-weather">Weather {log.weatherSource === 'forecast' && !weatherTyped && weather ? <StatusLabel size="sm" label="From the Forecast" color={TONE.slate} /> : null}</label>
              <input id="dl-weather" className="form-input" value={weather} onChange={(e) => { setWeather(e.target.value); setWeatherTyped(true); }}
                placeholder="e.g. Clear, high 75°F" />
            </div>
            <div>
              <label className="form-label" htmlFor="dl-temp">Temperature (°F)</label>
              <input id="dl-temp" className="form-input" type="number" inputMode="decimal" value={temp ?? ''}
                onChange={(e) => { setTemp(e.target.value); setWeatherTyped(true); }} placeholder="e.g. 68" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <label className="form-label" htmlFor="dl-crew">Crew Size</label>
              <input id="dl-crew" className="form-input" type="number" inputMode="numeric" min="0" value={crew}
                onChange={(e) => setCrew(e.target.value)} placeholder="e.g. 6" />
            </div>
            <div>
              <label className="form-label" htmlFor="dl-hours">Hours Worked</label>
              <input id="dl-hours" className="form-input" type="number" inputMode="decimal" min="0" step="0.5" value={hours}
                onChange={(e) => setHours(e.target.value)} placeholder="e.g. 8" />
            </div>
          </div>

          {/* The crew's own flags (11/03/2026): one tap each, the reviewer
              sees them first and the dashboard counts them. */}
          <div style={{ marginTop: 14 }}>
            <div className="form-label" id="dl-flags">Flag Today</div>
            <div role="group" aria-labelledby="dl-flags" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {LOG_TAGS.map((t) => {
                const on = tags.includes(t.key);
                return (
                  <button key={t.key} type="button" aria-pressed={on} onClick={() => toggleTag(t.key)}
                    style={{
                      minHeight: 40, padding: '8px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: 13, fontWeight: 600,
                      border: `1px solid ${on ? TAG_COLOR[t.key] : 'var(--border-color)'}`,
                      background: on ? `color-mix(in srgb, ${TAG_COLOR[t.key]} 12%, transparent)` : 'var(--bg-card)',
                      color: on ? TAG_COLOR[t.key] : 'var(--text-primary)',
                    }}>
                    {on ? <CheckCircle2 size={14} style={{ verticalAlign: -2, marginRight: 4 }} /> : null}{t.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* One line per delay (11/03/2026): the weekly report adds the hours
              by cause - a weather-delay summary from what the crew wrote. */}
          <div style={{ marginTop: 14 }} data-delays="">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="form-label" style={{ margin: 0 }}>Delays</span>
              <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: 13 }}
                onClick={() => setDelays((d) => [...d, { cause: 'weather', hours: '', note: '' }])}>Add Delay</button>
            </div>
            {delays.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>No delays today.</div>}
            {delays.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <select className="form-input" aria-label="What caused it" value={d.cause} style={{ flex: '1 1 130px' }}
                  onChange={(e) => setDelays((x) => x.map((y, j) => (j === i ? { ...y, cause: e.target.value } : y)))}>
                  {DELAY_CAUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <input className="form-input" aria-label="Hours lost" type="number" min="0" max="24" step="0.25" inputMode="decimal" placeholder="Hours lost"
                  value={d.hours} style={{ flex: '0 1 110px' }}
                  onChange={(e) => setDelays((x) => x.map((y, j) => (j === i ? { ...y, hours: e.target.value } : y)))} />
                <input className="form-input" aria-label="What happened" placeholder="What happened" value={d.note || ''} style={{ flex: '2 1 160px' }}
                  onChange={(e) => setDelays((x) => x.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} />
                <button type="button" className="secondary-btn" aria-label="Remove this delay" style={{ padding: 8 }}
                  onClick={() => setDelays((x) => x.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          {/* Subs on site (Round Two, 11/05/2026): one line per subcontractor -
              sub manpower is the number a delay claim is argued with. */}
          <div style={{ marginTop: 14 }} data-subs="">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="form-label" style={{ margin: 0 }}>Subs On Site</span>
              <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: 13 }}
                onClick={() => setSubs((s) => [...s, { name: '', headcount: '', hours: '' }])}>Add Sub</button>
            </div>
            {subs.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>No subcontractors on site today.</div>}
            <datalist id="subs-on-job">{jobSubs.map((j) => <option key={j.vendorId} value={j.name} />)}</datalist>
            {subs.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <input className="form-input" aria-label="Subcontractor" placeholder="Subcontractor" value={s.name || ''} style={{ flex: '2 1 160px' }} list="subs-on-job"
                  onChange={(e) => setSubs((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
                <input className="form-input" aria-label="People on site" type="number" min="0" max="500" step="1" inputMode="numeric" placeholder="People"
                  value={s.headcount} style={{ flex: '0 1 100px' }}
                  onChange={(e) => setSubs((x) => x.map((y, j) => (j === i ? { ...y, headcount: e.target.value } : y)))} />
                <input className="form-input" aria-label="Sub hours" type="number" min="0" step="0.25" inputMode="decimal" placeholder="Hours"
                  value={s.hours} style={{ flex: '0 1 100px' }}
                  onChange={(e) => setSubs((x) => x.map((y, j) => (j === i ? { ...y, hours: e.target.value } : y)))} />
                <button type="button" className="secondary-btn" aria-label="Remove this sub" style={{ padding: 8 }}
                  onClick={() => setSubs((x) => x.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            <label className="form-label" htmlFor="dl-sign">Sign With Your Name</label>
            <input id="dl-sign" className="form-input" value={signedName} onChange={(e) => setSignedName(e.target.value)}
              placeholder="Type your full name to sign this log" autoComplete="name" />
          </div>

          {fix && (
            <div style={{ marginTop: 10, fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={12} />Your location goes with this log.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          {isMobile && (
            <button className="secondary-btn" onClick={saveAndClose} disabled={submitting || recording}
              style={{ padding: 10, minWidth: 44, minHeight: 44 }} title={recording ? STOP_VOICE_FIRST : 'Save and close'}
              aria-label="Save and close"><X size={18} /></button>
          )}
          <div style={{ flex: 1, minWidth: 90, fontSize: 13, color: 'var(--text-secondary)' }}>
            {recording ? STOP_VOICE_FIRST
              : pending > 0 ? `Uploading ${pending}…`
              : failed > 0 ? `${attached} attached, ${failed} failed`
                : attached > 0 ? `${attached} attached` : 'Nothing attached yet'}
          </div>
          {!isMobile && (
            <button className="secondary-btn" onClick={saveAndClose} disabled={submitting || recording}>
              {submitting ? 'Saving…' : 'Save & Close'}
            </button>
          )}
          {/* No inline background: .primary-btn already carries var(--pine) and
              dims itself at :disabled. */}
          <button className="primary-btn" onClick={submit} disabled={!canSubmit}
            title={recording ? STOP_VOICE_FIRST : pending ? 'Wait for uploads to finish' : !signedName.trim() ? 'Type your name to sign' : !canSubmit ? 'Attach something or write a note' : ''}>
            <Send size={15} />{submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
