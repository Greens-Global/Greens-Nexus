// Property Walkthrough (Neil, 10/05): walk a property, log every issue line by
// line, and file them all at once - each line its own ticket, all linked to
// the property. Built for a phone at the property:
//   - Enter on a title starts the next line (the "line by line" feel).
//   - Photos upload the moment they are taken; Create waits for them.
//   - The whole walkthrough is a draft on this device (localStorage) with the
//     same batch_id until it is filed, so a reload or a dead spot loses
//     nothing, and a retry after a lost response can never file twice (the
//     server replays the batch).
//   - A replay is only safe if the retry is the SAME request, so after an
//     ambiguous failure (no answer, or a 5xx that may have come after the
//     commit) the lines LOCK until a retry gets an answer - and the lock is
//     saved with the draft. If the lines changed anyway (another tab), the
//     server says batch_mismatch with what it filed, and the unfiled lines
//     move into a new walkthrough. A line is never silently dropped.
//   - The server files all lines or none; its per-line errors land on the
//     cards that caused them.
// Opened from a property in Asset Management (`property`), the property is
// fixed - it is not a choice there (Pranshu, 10/06).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, Plus, Trash2, Copy, X, CheckCircle2, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { filesFromPaste } from '../tasks/lib';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from '../tasks/theme';
import { Modal } from '../tasks/components';
import { useIsMobile } from '../lib/useIsMobile';
import { formatDateTime } from '../lib/datetime';
import { TicketSelect } from './TicketAtoms';
import { useTicketConfig, typeRequiresApproval } from './ticketConfig';
import {
  TICKET_TYPE_META, TICKET_TYPE_ORDER, OTHER_TOPIC, TOPIC_MAX_LEN, helpGroupFor, ticketNoShort,
  label as labelStyle, field as fieldStyle, requiredHint,
} from './ticketMeta';
import { uploadTicketEvidence } from './evidenceUpload';
import { PropertySelect } from './PropertySelect';
import { useTicketProperties, propertyLabel, groupTakesProperty, isBuildingGroup } from './propertyMeta';

const MAX_LINES = 50;
const MAX_PHOTOS = 6;
const DRAFT_KEY = 'nexus:walkthrough-draft';

const uid = () => Math.random().toString(36).slice(2, 10);
const newBatchId = () => (globalThis.crypto?.randomUUID?.()
  || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r % 4) + 8).toString(16);
  })).toLowerCase();
const blankLine = (base = {}) => ({
  key: uid(), subject: '', application: '', otherText: '', priority: base.priority || 'medium',
  type: base.type || 'incident', location: '', description: '', photos: [], more: false,
});
const topicOf = (l) => (l.application === OTHER_TOPIC ? l.otherText.trim() : l.application);
const hasContent = (l) => !!(l.subject.trim() || topicOf(l) || l.description.trim() || l.photos.length);

// Storage can be missing (private mode, blocked site data) - the form works without it.
function readDraft() { try { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function writeDraft(d) {
  try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); }
  catch { /* storage unavailable - nothing to do */ }
}
// Only finished uploads survive a reload; a photo mid-upload is gone with its File.
const revive = (lines) => (lines || []).map((l) => ({ ...blankLine(), ...l, key: l.key || uid(),
  photos: (l.photos || []).filter((p) => p.status === 'done' && p.url).map((p) => ({ ...p, preview: p.url })) }));

export default function PropertyWalkthrough({ onClose, property = null, onDone = null }) {
  useTicketConfig();                                     // help topics + type switches from the server
  const isMobile = useIsMobile();
  const { properties } = useTicketProperties();
  const [depts, setDepts] = useState(null);

  // A saved draft resumes when it is for this property (or none was preset);
  // a draft for ANOTHER property is offered, never silently thrown away.
  const [saved] = useState(readDraft);
  const savedUsable = !!(saved && Array.isArray(saved.lines) && saved.lines.length);
  const resumeNow = savedUsable && (!property || saved.propertyId === property.id);
  const [offer, setOffer] = useState(savedUsable && !resumeNow ? saved : null);
  const [batchId, setBatchId] = useState(resumeNow ? saved.batchId : newBatchId());
  const [propertyId, setPropertyId] = useState(property?.id || (resumeNow ? saved.propertyId : '') || '');
  const [deptId, setDeptId] = useState(resumeNow ? (saved.deptId || '') : '');
  const [lines, setLines] = useState(() => (resumeNow ? revive(saved.lines) : [blankLine()]));
  const [restoredAt] = useState(resumeNow ? saved.savedAt : null);
  // Sent, but no answer came back: filed or not is unknown until a retry.
  const [unconfirmed, setUnconfirmed] = useState(resumeNow ? !!saved.unconfirmed : false);
  const [mismatch, setMismatch] = useState(null);     // { tickets, property, leftover[] }
  const [errors, setErrors] = useState({});           // { [lineKey]: { field: message } }
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const filesRef = useRef({});                         // photo id -> File, for Retry
  const titleRefs = useRef({});
  const focusKey = useRef(null);

  // Only the teams whose tickets sit on a property (the server enforces the
  // same); start on the one that handles buildings.
  useEffect(() => {
    api.getMyTicketDepartments()
      .then((d) => {
        const list = (d || []).filter((x) => x.enabled !== false && !x.removed && groupTakesProperty(helpGroupFor(x.name)));
        setDepts(list);
        const start = list.find((x) => isBuildingGroup(helpGroupFor(x.name))) || (list.length === 1 ? list[0] : null);
        if (start) setDeptId((cur) => cur || start.id);
      })
      .catch(() => setDepts([]));
  }, []);

  const prop = properties.find((p) => p.id === propertyId) || (property && property.id === propertyId ? property : null);
  const dept = (depts || []).find((d) => d.id === deptId);
  const group = helpGroupFor(dept?.name || '');
  const topicOptions = useMemo(() => [
    ...((group?.topics || []).map((tp) => [tp.name, tp.name])), [OTHER_TOPIC, 'Other'],
  ], [group]);
  const typeOptions = TICKET_TYPE_ORDER.map((k) => ({
    id: k, label: TICKET_TYPE_META[k]?.label || k,
    desc: typeRequiresApproval(k) ? 'Needs approval before anyone can be assigned.' : undefined,
  }));

  // Autosave (no File objects, no blob previews - finished upload URLs only).
  useEffect(() => {
    if (done || offer) return;
    if (!lines.some(hasContent)) return;
    writeDraft({
      batchId, propertyId, deptId, unconfirmed, savedAt: new Date().toISOString(),
      lines: lines.map(({ photos, ...l }) => ({ ...l, photos: photos.filter((p) => p.status === 'done').map(({ id, url, name, status }) => ({ id, url, name, status })) })),
    });
  }, [batchId, propertyId, deptId, lines, done, offer, unconfirmed]);

  useEffect(() => {
    if (focusKey.current && titleRefs.current[focusKey.current]) {
      titleRefs.current[focusKey.current].focus();
      focusKey.current = null;
    }
  }, [lines.length]);

  const patch = (key, p) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const clearErr = (key, field) => setErrors((e) => (e[key]?.[field] ? { ...e, [key]: { ...e[key], [field]: undefined } } : e));
  const addLine = (after = null) => {
    if (lines.length >= MAX_LINES) return;
    const base = after ? lines.find((l) => l.key === after) : lines[lines.length - 1];
    const next = blankLine({ priority: base?.priority, type: base?.type });
    focusKey.current = next.key;
    setLines((ls) => {
      const i = after ? ls.findIndex((l) => l.key === after) : ls.length - 1;
      return [...ls.slice(0, i + 1), next, ...ls.slice(i + 1)];
    });
  };
  const duplicate = (key) => {
    if (lines.length >= MAX_LINES) return;
    const src = lines.find((l) => l.key === key);
    const copy = { ...src, key: uid(), photos: [] };
    focusKey.current = copy.key;
    setLines((ls) => { const i = ls.findIndex((l) => l.key === key); return [...ls.slice(0, i + 1), copy, ...ls.slice(i + 1)]; });
  };
  const remove = (key) => setLines((ls) => (ls.length === 1 ? [blankLine()] : ls.filter((l) => l.key !== key)));

  const upload = (key, photo, file) => {
    filesRef.current[photo.id] = file;
    uploadTicketEvidence(file, 'image')
      .then((url) => setLines((ls) => ls.map((l) => (l.key !== key ? l : {
        ...l, photos: l.photos.map((p) => (p.id === photo.id ? { ...p, url, status: 'done' } : p)) }))))
      .catch(() => setLines((ls) => ls.map((l) => (l.key !== key ? l : {
        ...l, photos: l.photos.map((p) => (p.id === photo.id ? { ...p, status: 'failed' } : p)) }))));
  };
  const addFiles = (key, files) => {
    const line = lines.find((l) => l.key === key);
    const room = MAX_PHOTOS - (line?.photos.length || 0);
    const images = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room));
    if (!images.length) return;
    const added = images.map((f) => ({ id: uid(), name: f.name, status: 'uploading', url: '', preview: URL.createObjectURL(f) }));
    patch(key, { photos: [...line.photos, ...added] });
    clearErr(key, 'photos');
    added.forEach((p, i) => upload(key, p, images[i]));
  };
  const retryPhoto = (key, photo) => {
    const file = filesRef.current[photo.id];
    if (!file) return;
    patch(key, { photos: lines.find((l) => l.key === key).photos.map((p) => (p.id === photo.id ? { ...p, status: 'uploading' } : p)) });
    upload(key, photo, file);
  };

  const filled = lines.filter(hasContent);
  const uploading = filled.some((l) => l.photos.some((p) => p.status === 'uploading'));

  const validate = () => {
    const errs = {};
    for (const l of filled) {
      const e = {};
      if (!l.subject.trim()) e.subject = 'Describe the issue.';
      if (!topicOf(l)) e.application = 'Pick what it is.';
      if (l.photos.some((p) => p.status === 'failed')) e.photos = 'A photo did not upload - retry or remove it.';
      if (Object.keys(e).length) errs[l.key] = e;
    }
    return errs;
  };

  const submit = async () => {
    if (busy) return;
    setFormError('');
    if (!propertyId) { setFormError('Pick the property you are walking.'); return; }
    if (!deptId) { setFormError('Pick the team that will handle these.'); return; }
    if (!filled.length) { setFormError('Add at least one issue.'); return; }
    if (uploading) { setFormError('Photos are still uploading - this takes a moment on a slow connection.'); return; }
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) {
      const n = Object.keys(errs).length;
      setFormError(`${n} line${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention.`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.createTicketWalkthrough({
        batch_id: batchId, property_asset_id: propertyId, hr_department_id: deptId,
        lines: filled.map((l) => ({
          subject: l.subject.trim(), application: topicOf(l), priority: l.priority, type: l.type,
          location: l.location.trim(), description: l.description.trim(),
          images: l.photos.filter((p) => p.status === 'done').map((p) => p.url),
        })),
      });
      writeDraft(null);
      setUnconfirmed(false);
      setDone(r);
      window.dispatchEvent(new CustomEvent('nexus:tickets-changed', { detail: { propertyId } }));
      onDone?.(r);
    } catch (e) {
      const perLine = e?.detail?.lines;
      if (e?.status === 409 && e?.detail?.code === 'batch_mismatch') {
        // Filed earlier with different lines. Show what landed; every line
        // not among them goes into a NEW walkthrough (new batch id).
        const filedSubjects = (e.detail.tickets || []).map((t) => t.subject.trim().toLowerCase());
        const leftover = filled.filter((l) => {
          const i = filedSubjects.indexOf(l.subject.trim().toLowerCase());
          if (i === -1) return true;
          filedSubjects.splice(i, 1);                    // each filed ticket matches one line
          return false;
        });
        writeDraft(null);
        setUnconfirmed(false);
        setMismatch({ tickets: e.detail.tickets || [], property: e.detail.property, leftover });
        window.dispatchEvent(new CustomEvent('nexus:tickets-changed', { detail: { propertyId } }));
      } else if (!e?.status || e.status >= 500) {
        // No answer, or a gateway error that may have come after the commit:
        // filed or not is unknown. Lock the lines so the retry is the same
        // request - the server then either files it or returns it.
        setUnconfirmed(true);
        setFormError("We couldn't confirm these were filed. Try again when you have signal - nothing will be filed twice.");
      } else if (e?.status === 422 && Array.isArray(perLine) && perLine.length) {
        setUnconfirmed(false);                           // the server answered: nothing was filed
        const map = {};
        for (const { index, field, error } of perLine) {
          const key = filled[index]?.key;
          if (key) map[key] = { ...(map[key] || {}), [field === 'images' ? 'photos' : field]: error };
        }
        setErrors(map);
        setFormError(e.message);
      } else {
        setUnconfirmed(false);                           // a definite refusal: nothing was filed
        setFormError(e?.message || 'Could not create the tickets.');
      }
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    writeDraft(null);
    setDone(null); setMismatch(null); setUnconfirmed(false); setErrors({}); setFormError('');
    setBatchId(newBatchId());
    setLines([blankLine()]);
  };
  const continueLeftover = () => {
    const rest = mismatch.leftover.map((l) => ({ ...l, key: uid() }));
    setMismatch(null); setErrors({}); setFormError('');
    setBatchId(newBatchId());                          // a NEW walkthrough - never the filed id
    setLines(rest.length ? rest : [blankLine()]);
  };
  const discard = () => {
    if (filled.length && !window.confirm(unconfirmed
      ? 'Discard this walkthrough? If it was already filed, the tickets stay filed - check Tickets.'
      : 'Discard this walkthrough? Lines not yet created are lost.')) return;
    writeDraft(null);
    onClose();
  };
  const resumeOffered = () => {
    setBatchId(offer.batchId); setPropertyId(property?.id || offer.propertyId || ''); setDeptId(offer.deptId || '');
    setLines(revive(offer.lines)); setUnconfirmed(!!offer.unconfirmed); setOffer(null);
  };
  const dropOffered = () => { writeDraft(null); setOffer(null); };

  const chip = (on) => ({ ...btn(on ? 'primary' : 'outline'), padding: '5px 10px', fontSize: 12.5 });
  const err = (l, f) => errors[l.key]?.[f];
  const unitsListId = `wt-units-${propertyId || 'none'}`;
  const ticketRows = (tickets, showTopic) => (
    <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
      {tickets.map((t) => (
        <div key={t.id} style={{ display: 'flex', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13 }}>
          <b style={{ color: NX.ink, minWidth: 64 }}>{ticketNoShort(t.code)}</b>
          <span style={{ color: NX.ink, flex: 1 }}>{t.subject}</span>
          {showTopic && <span style={{ color: NX.faint }}>{t.application}</span>}
        </div>
      ))}
    </div>
  );

  // ── Filed earlier with different lines (batch_mismatch) ──
  if (mismatch) {
    const n = mismatch.tickets.length;
    const left = mismatch.leftover.length;
    return (
      <Modal title="Property Walkthrough" onClose={onClose} width={560} footer={<>
        {left > 0 && <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={continueLeftover}>
          Start a Walkthrough With the {left} Unfiled Line{left === 1 ? '' : 's'}</button>}
        <button style={{ ...btn(left > 0 ? 'outline' : 'primary'), ...(left > 0 ? null : { marginLeft: 'auto' }) }} onClick={onClose}>Done</button>
      </>}>
        <div role="status" style={{ fontSize: 14, color: NX.ink, marginBottom: 12, fontFamily: FONT }}>
          This walkthrough was already filed with <b>{n} ticket{n === 1 ? '' : 's'}</b> at <b>{mismatch.property?.name}</b>.
          {left > 0
            ? <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 4 }}>{left} line{left === 1 ? ' was' : 's were'} added or changed after that and {left === 1 ? 'was' : 'were'} not filed yet.</div>
            : <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 4 }}>Every line is among them - nothing was duplicated.</div>}
        </div>
        {ticketRows(mismatch.tickets, false)}
      </Modal>
    );
  }

  // ── Finished ──
  if (done) {
    const n = done.tickets?.length || 0;
    return (
      <Modal title="Property Walkthrough" onClose={onClose} width={560} footer={<>
        <button style={{ ...btn('outline'), marginLeft: 'auto' }} onClick={startOver}>Start Another Walkthrough</button>
        <button style={btn('primary')} onClick={onClose}>Done</button>
      </>}>
        <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14, fontFamily: FONT }}>
          <CheckCircle2 size={22} style={{ color: NX.green, flexShrink: 0 }} />
          <div style={{ fontSize: 14, color: NX.ink }}>
            <b>{n} ticket{n === 1 ? '' : 's'}</b> created at <b>{done.property?.name}</b>.
            {done.replayed && <div style={{ fontSize: 12.5, color: NX.dim, marginTop: 4 }}>These were already filed - nothing was duplicated.</div>}
          </div>
        </div>
        {ticketRows(done.tickets || [], true)}
      </Modal>
    );
  }

  return (
    <Modal title="Property Walkthrough" onClose={onClose} footer={<>
      <button style={{ ...btn('ghost'), color: NX.dim }} onClick={discard}>Discard Walkthrough</button>
      <span style={{ marginLeft: 'auto', fontSize: 12.5, color: NX.dim }}>{filled.length} line{filled.length === 1 ? '' : 's'}</span>
      <button style={{ ...btn('primary'), opacity: busy || uploading ? 0.6 : 1 }} onClick={submit} disabled={busy}>
        {busy ? (unconfirmed ? 'Checking…' : 'Creating…')
          : unconfirmed ? 'Try Again'
            : filled.length ? `Create ${filled.length} Ticket${filled.length === 1 ? '' : 's'}` : 'Create Tickets'}
      </button>
    </>}>
      <div style={{ fontFamily: FONT }}>
        {unconfirmed && (
          <div role="status" style={{ border: `1px solid ${NX.border}`, background: NX.surface2, borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 12.5, color: NX.dim }}>
            These lines were sent but we couldn't confirm they were filed, so they're locked until Try Again gets an answer. Nothing will be filed twice.
          </div>
        )}
        {offer && (
          <div role="status" style={{ border: `1px solid ${NX.border}`, background: NX.surface2, borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 12.5, color: NX.dim }}>
            You have an unsent walkthrough ({offer.lines.length} line{offer.lines.length === 1 ? '' : 's'}) from {formatDateTime(offer.savedAt)}.
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button style={btn('primary')} onClick={resumeOffered}>Resume It</button>
              <button style={btn('outline')} onClick={dropOffered}>Discard It</button>
            </div>
          </div>
        )}
        {restoredAt && (
          <div style={{ fontSize: 12, color: NX.faint, marginBottom: 10 }}>Restored your unsent walkthrough from {formatDateTime(restoredAt)}.</div>
        )}
        {/* Locked while unconfirmed: a disabled fieldset disables every input,
            select, file picker and button inside it, so the retry is the same request. */}
        <fieldset disabled={unconfirmed} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, opacity: unconfirmed ? 0.65 : 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Property <span style={{ color: NX.red }}>*</span></label>
              {property ? (
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', background: NX.surface2 }}>{propertyLabel(prop) || property.name}</div>
              ) : (
                <PropertySelect value={propertyId} onChange={(v) => { setPropertyId(v); setFormError(''); }} />
              )}
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Team <span style={{ color: NX.red }}>*</span></label>
              <TicketSelect value={deptId} onChange={(v) => { setDeptId(v); setLines((ls) => ls.map((l) => ({ ...l, application: '', otherText: '' }))); }}
                placeholder={depts === null ? 'Loading…' : 'Select team'} searchPlaceholder="Search teams…"
                emptyText="No building or site team is set up for tickets."
                options={(depts || []).map((d) => [d.id, d.name])} />
            </div>
          </div>
          <datalist id={unitsListId}>{(prop?.units || []).map((u) => <option key={u} value={u} />)}</datalist>

          {lines.map((l, i) => (
            <div key={l.key} data-line={i} onPaste={(e) => { if (unconfirmed) return; const f = filesFromPaste(e); if (f.length) { e.preventDefault(); addFiles(l.key, f); } }}
              style={{ border: `1px solid ${errors[l.key] && Object.values(errors[l.key]).some(Boolean) ? NX.red : NX.border}`, borderRadius: 12, padding: 12, marginBottom: 10, background: NX.surface }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <b style={{ fontSize: 12, color: NX.faint, minWidth: 22 }}>{i + 1}.</b>
                <input ref={(el) => { titleRefs.current[l.key] = el; }} value={l.subject} maxLength={200}
                  aria-label={`Issue ${i + 1}`} placeholder="What is the issue? e.g. Broken handrail on stairwell B"
                  onChange={(e) => { patch(l.key, { subject: e.target.value }); clearErr(l.key, 'subject'); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addLine(l.key); } }}
                  style={{ ...inputStyle, flex: 1, fontFamily: FONT, ...(err(l, 'subject') ? { borderColor: NX.red } : null) }} />
                <button type="button" title="Duplicate line" aria-label="Duplicate line" onClick={() => duplicate(l.key)} style={{ ...btn('ghost'), padding: 6 }}><Copy size={15} /></button>
                <button type="button" title="Remove line" aria-label="Remove line" onClick={() => remove(l.key)} style={{ ...btn('ghost'), padding: 6, color: NX.dim }}><Trash2 size={15} /></button>
              </div>
              {err(l, 'subject') && <div style={requiredHint}>{err(l, 'subject')}</div>}

              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.2fr 1fr', gap: 10, marginTop: 6 }}>
                <div>
                  <label style={labelStyle}>What Is It? <span style={{ color: NX.red }}>*</span></label>
                  {group ? (
                    <TicketSelect value={l.application} invalid={!!err(l, 'application')} searchPlaceholder="Search…"
                      onChange={(v) => { patch(l.key, { application: v }); clearErr(l.key, 'application'); }}
                      placeholder="HVAC, Plumbing, Painting…" options={topicOptions} />
                  ) : null}
                  {(!group || l.application === OTHER_TOPIC) && (
                    <input value={l.otherText} maxLength={TOPIC_MAX_LEN} placeholder="Name it in a few words"
                      onChange={(e) => { patch(l.key, { otherText: e.target.value, ...(group ? {} : { application: OTHER_TOPIC }) }); clearErr(l.key, 'application'); }}
                      style={{ ...inputStyle, marginTop: group ? 6 : 0, fontFamily: FONT, ...(err(l, 'application') ? { borderColor: NX.red } : null) }} />
                  )}
                  {err(l, 'application') && <div style={requiredHint}>{err(l, 'application')}</div>}
                </div>
                <div>
                  <label style={labelStyle}>Location</label>
                  <input value={l.location} list={unitsListId} maxLength={120} placeholder="Unit, building or area"
                    onChange={(e) => patch(l.key, { location: e.target.value })} style={{ ...inputStyle, fontFamily: FONT }} />
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }} role="radiogroup" aria-label="Priority">
                {PRIORITY_ORDER.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={l.priority === p} onClick={() => patch(l.key, { priority: p })} style={chip(l.priority === p)}>
                    {PRIORITY_META[p]?.label || p}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 }}>
                {l.photos.map((p) => (
                  <div key={p.id} style={{ position: 'relative', width: 56, height: 56, borderRadius: 8, overflow: 'hidden', border: `1px solid ${p.status === 'failed' ? NX.red : NX.border}` }}>
                    <img src={p.preview || p.url} alt={p.name || 'Photo'} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: p.status === 'done' ? 1 : 0.5 }} />
                    {p.status === 'failed' && (
                      <button type="button" title="Retry upload" aria-label="Retry upload" onClick={() => retryPhoto(l.key, p)}
                        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.35)', border: 'none', color: '#fff', cursor: 'pointer' }}><RotateCcw size={16} /></button>
                    )}
                    <button type="button" title="Remove photo" aria-label="Remove photo" onClick={() => patch(l.key, { photos: l.photos.filter((x) => x.id !== p.id) })}
                      style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 9, border: 'none', background: 'rgba(0,0,0,.55)', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0 }}><X size={11} /></button>
                  </div>
                ))}
                {l.photos.length < MAX_PHOTOS && (<>
                  <label style={{ ...btn('outline'), padding: '6px 10px', fontSize: 12.5, gap: 6, cursor: 'pointer' }}>
                    <Camera size={15} /> Take Photo
                    <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { addFiles(l.key, e.target.files || []); e.target.value = ''; }} />
                  </label>
                  <label style={{ ...btn('ghost'), padding: '6px 8px', fontSize: 12.5, gap: 6, cursor: 'pointer' }}>
                    <ImagePlus size={15} /> Choose
                    <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(l.key, e.target.files || []); e.target.value = ''; }} />
                  </label>
                  {!isMobile && <span style={{ fontSize: 11.5, color: NX.faint }}>or press Ctrl+V to paste a photo</span>}
                </>)}
              </div>
              {err(l, 'photos') && <div style={requiredHint}>{err(l, 'photos')}</div>}

              <button type="button" onClick={() => patch(l.key, { more: !l.more })} style={{ ...btn('ghost'), padding: '4px 0', marginTop: 6, fontSize: 12.5, color: NX.dim, gap: 4 }}>
                {l.more ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {l.more ? 'Hide Details' : 'Add Details'}
              </button>
              {l.more && (
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 200px', gap: 10, marginTop: 6 }}>
                  <textarea value={l.description} rows={3} maxLength={4000} placeholder="Anything the team should know - size, how bad, access notes"
                    onChange={(e) => patch(l.key, { description: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
                  <div>
                    <label style={labelStyle}>Type</label>
                    <TicketSelect value={l.type} onChange={(v) => patch(l.key, { type: v })} options={typeOptions} />
                  </div>
                </div>
              )}
            </div>
          ))}

          <button type="button" onClick={() => addLine()} disabled={lines.length >= MAX_LINES}
            style={{ ...btn('outline'), width: '100%', justifyContent: 'center', gap: 6, opacity: lines.length >= MAX_LINES ? 0.5 : 1 }}>
            <Plus size={15} /> Add Line
          </button>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
            {lines.length >= MAX_LINES
              ? `A walkthrough takes up to ${MAX_LINES} lines - create these, then start another.`
              : 'Press Enter in a title to start the next line. Your lines are kept on this device until you create them.'}
          </div>
        </fieldset>
        {formError && <div role="alert" style={{ ...requiredHint, fontSize: 12.5, marginTop: 10 }}>{formError}</div>}
      </div>
    </Modal>
  );
}
