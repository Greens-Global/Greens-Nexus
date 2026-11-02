// Fill a Form (Forms & Checklists, Neil 11/02/2026) - the phone-first renderer.
//
// One screen in the shared Modal (a phone's full sheet, a desktop's 60% sheet
// from the right): the form's sections as headings, TypedFieldInput for the
// document field types plus the form-only inputs here - PhotoField (camera
// first, several, each uploaded as it is taken, Ctrl+V on the web), GpsField
// (one tap stamps where you are and names the nearest work site), ScanField
// (a QR code read by the browser's BarcodeDetector, else by jsqr from a
// photo), RatingField, YesNoField and SignatureField (the Nexus Sign pad, its
// PNG uploaded). `showIf` is evaluated live, a formula is read-only, required
// and format problems sit under their field, and the answers live in a draft
// on this device (forms/formDraft.js) that is offered back on return.
//
// Submit sends ONCE: the entryKey the draft was started with travels with
// every try, so a retry after a dropped signal files the same entry - the
// server answers the first entry again, never a second row. Files go to the
// private task-files bucket under forms/<entryKey>/ (tasks/lib storeTaskFile).
// `preview` (the builder's Preview) renders the form with no send.
//
// Loaded lazily by every entry point (the Workday tile, the shift card) so
// the Workday page stays light; jsqr loads only when a code is scanned.
import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { Camera, Upload, X, MapPin, PenTool, QrCode, Star, Plus, Trash2, Check, RefreshCw, ExternalLink, Asterisk } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField, TimeField } from '../tasks/components';
import TypedFieldInput from '../components/TypedFieldInput';
import { storeTaskFile, filesFromPaste, dataUrlToFile } from '../tasks/lib';
import { getPosition } from '../lib/geoPosition';
import { useIsMobile } from '../lib/useIsMobile';
import { useVisualViewport } from '../lib/useVisualViewport';
import { ErrorBanner, Spinner } from '../components/AsyncState';
import { formatAccuracy, formatDistance } from '../lib/distance';
import { formatDateTime } from '../lib/datetime';
import { toText } from '../tasks/formula';
import { NX, FONT, btn } from '../tasks/theme';
import { groupDefs, isVisible, visibleAnswers, validateAnswers, computeFormulas, nearestSite } from './formRules';
import { groupLabel } from './formsModel';
import { loadDraft, saveDraft, clearDraft, newEntryKey, hasContent, draftNotice } from './formDraft';
import { useRole } from '../contexts/RoleContext';

// The signature pad is Nexus Sign's (components/ESign.jsx) - loaded when a
// signature field is tapped, so a form with none never fetches that chunk.
const SignaturePad = lazy(() => import('../components/ESign').then((m) => ({ default: m.SignaturePad })));

const FOLDER = (entryKey) => `forms/${entryKey}`;
const GPS_MS = 9000;
const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.ink, marginBottom: 5 };
const hint = { fontSize: 11.5, color: NX.dim, marginTop: 4, lineHeight: 1.45 };
const errStyle = { fontSize: 11.5, color: NX.red, fontWeight: 600, marginTop: 4 };
const chipBtn = { ...btn('outline'), padding: '8px 12px', fontSize: 12.5 };
// On a phone every tap target is at least 44px tall (a gloved thumb on a site).
const tap = (phone) => (phone ? { minHeight: 44 } : null);
const chip = (phone) => ({ ...chipBtn, ...tap(phone) });
const segBtn = (on, phone) => ({ ...btn('outline'), padding: '9px 18px', fontSize: 13, fontWeight: 700, background: on ? NX.primary : NX.surface, color: on ? '#fff' : NX.ink, borderColor: on ? NX.primary : NX.border, ...tap(phone) });

/** The server's "tires[1].psi" as this screen's error key "tires.1.psi". */
export const serverTokenKey = (token) => String(token || '').replace(/\[(\d+)\]\./g, '.$1.').replace(/\[(\d+)\]$/, '.$1');

/** Opens the entry in Documents > Forms. */
export const openEntry = (entry) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: `documents-forms:entry:${entry?.id || ''}` } }));

// ── Form-only inputs ──────────────────────────────────────────────────────────

function PhotoField({ value, onChange, entryKey, phone, disabled, label: name = 'Photos', onUploading }) {
  const urls = Array.isArray(value) ? value : [];
  const camRef = useRef(null);
  const fileRef = useRef(null);
  const [uploads, setUploads] = useState([]);   // [{id, name, progress, error}]
  const add = useCallback((files) => {
    for (const file of Array.from(files || [])) {
      if (!file.type?.startsWith('image/')) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setUploads((u) => [...u, { id, name: file.name, progress: 0 }]);
      onUploading?.(1);   // Send waits for it (FillForm)
      storeTaskFile(file, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))), FOLDER(entryKey))
        .then((url) => {
          setUploads((u) => u.filter((x) => x.id !== id));
          if (url) onChange((prev) => [...(Array.isArray(prev) ? prev : []), url]);
        })
        .catch((e) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: e?.message || 'upload failed' } : x))))
        .finally(() => onUploading?.(-1));
    }
  }, [entryKey, onChange, onUploading]);
  const onPaste = (e) => { const fs = filesFromPaste(e); if (fs.length) { e.preventDefault(); add(fs); } };
  return (
    // Focusable (Tab, or a click) so Ctrl+V pastes without pressing a button first; .nx-paste-zone rings it.
    <div onPaste={onPaste} tabIndex={0} className="nx-paste-zone" role="group" aria-label={phone ? name : `${name} - press Ctrl+V to paste a screenshot`}>
      {(urls.length > 0 || uploads.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8, marginBottom: 10 }}>
          {urls.map((u, i) => (
            <div key={u} style={{ position: 'relative', aspectRatio: '1', borderRadius: 10, overflow: 'hidden', border: `1px solid ${NX.border}` }}>
              <img src={u} alt={`Photo ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              {!disabled && (
                <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => onChange(urls.filter((x) => x !== u))}
                  style={{ position: 'absolute', top: 4, right: 4, width: phone ? 28 : 22, height: phone ? 28 : 22, padding: phone ? 6 : 0, borderRadius: '50%', border: 'none', background: 'rgba(17,24,39,0.7)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <X size={phone ? 14 : 12} />
                </button>
              )}
            </div>
          ))}
          {uploads.map((u) => (
            <div key={u.id} role="status" style={{ aspectRatio: '1', borderRadius: 10, border: `1px dashed ${u.error ? NX.red : NX.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11, color: u.error ? NX.red : NX.dim, padding: 6, textAlign: 'center' }}>
              {u.error ? <>Failed<button type="button" onClick={() => setUploads((l) => l.filter((x) => x.id !== u.id))} style={{ ...btn('ghost'), padding: '2px 6px', fontSize: 11 }}>Dismiss</button></>
                : <><Spinner size="inline" /> {Math.round((u.progress || 0) * 100)}%</>}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={chip(phone)} disabled={disabled} onClick={() => camRef.current?.click()}><Camera size={14} /> Take a Photo</button>
        <button type="button" style={chip(phone)} disabled={disabled} onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload</button>
      </div>
      {/* capture="environment" opens the rear camera on a phone and is an ordinary picker on a desktop. */}
      <input ref={camRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <div style={hint}>{phone ? 'Take photos as you go - each one uploads at once.' : 'Take or upload photos, or press Ctrl+V to paste a screenshot.'}</div>
    </div>
  );
}

function GpsField({ value, onChange, workSites, disabled, phone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const stamp = async () => {
    setBusy(true); setErr('');
    const pos = await getPosition(GPS_MS);
    setBusy(false);
    if (!pos) { setErr('Location is off or did not answer. Allow location for Nexus in your browser settings, then tap Stamp My Location again.'); return; }
    const lat = Number(pos.lat), lng = Number(pos.lng);
    const near = nearestSite(workSites, lat, lng);
    onChange({ lat, lng, accuracyM: Number(pos.accuracy_m) || 0, siteName: near?.name || '', siteId: near?.id || '', siteDistanceM: near?.distanceM ?? null, at: new Date().toISOString() });
  };
  return (
    <div>
      {value && Number.isFinite(Number(value.lat)) && (
        <div style={{ fontSize: 12.5, color: NX.ink, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <MapPin size={13} style={{ color: NX.green }} />
          <span>{Number(value.lat).toFixed(5)}, {Number(value.lng).toFixed(5)}</span>
          {value.accuracyM ? <span style={{ color: NX.dim }}>{formatAccuracy(value.accuracyM)}</span> : null}
          {value.siteName ? <span style={{ color: NX.dim }}>near {value.siteName}{value.siteDistanceM ? ` (${formatDistance(value.siteDistanceM)})` : ''}</span> : null}
        </div>
      )}
      <button type="button" style={chip(phone)} disabled={disabled || busy} onClick={stamp}>
        {busy ? <Spinner size="inline" /> : <MapPin size={14} />} {busy ? 'Finding You...' : value ? 'Stamp Again' : 'Stamp My Location'}
      </button>
      {err && <div style={errStyle}>{err}</div>}
    </div>
  );
}

async function decodeQr(file) {
  // The browser's own reader first (Chrome, Android, newer Safari)...
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
      if (codes?.[0]?.rawValue) return codes[0].rawValue;
    } catch { /* fall through to jsqr */ }
  }
  // ...else jsqr over the photo's pixels, fetched only now.
  const jsQR = (await import('jsqr')).default;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That photo could not be read.')); i.src = url; });
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const c = document.createElement('canvas');
    c.width = Math.round((img.naturalWidth || 1) * scale); c.height = Math.round((img.naturalHeight || 1) * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const r = jsQR(data.data, c.width, c.height);
    return r?.data || '';
  } finally { URL.revokeObjectURL(url); }
}

function ScanField({ def, value, onChange, disabled, inputId, phone }) {
  const camRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setErr('');
    try {
      const code = await decodeQr(file);
      if (code) onChange(code); else setErr('No QR code found in that photo - try again, closer and in better light.');
    } catch (ex) { setErr(ex?.message || 'That photo could not be read.'); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input id={inputId} type="text" className="form-input" style={{ flex: 1, minWidth: 0 }} value={value ?? ''} disabled={disabled}
          placeholder="Scan or type the code" onChange={(e) => onChange(e.target.value)} />
        <button type="button" style={{ ...chip(phone), whiteSpace: 'nowrap' }} disabled={disabled || busy} onClick={() => camRef.current?.click()} aria-label={`Scan a QR Code for ${def.label}`}>
          {busy ? <Spinner size="inline" /> : <QrCode size={14} />} {busy ? 'Reading...' : 'Scan'}
        </button>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      {err && <div style={errStyle}>{err}</div>}
    </div>
  );
}

function RatingField({ def, value, onChange, disabled, phone }) {
  const n = Number(value) || 0;
  return (
    <div role="group" aria-label={def.label} style={{ display: 'flex', gap: 4 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" aria-label={`${i} of 5`} aria-pressed={n === i} disabled={disabled} onClick={() => onChange(i === n ? 0 : i)}
          style={{ background: 'none', border: 'none', padding: phone ? 9 : 4, cursor: disabled ? 'default' : 'pointer', color: i <= n ? '#f59e0b' : NX.border2, display: 'flex', alignItems: 'center', ...tap(phone) }}>
          <Star size={26} fill={i <= n ? '#f59e0b' : 'none'} />
        </button>
      ))}
    </div>
  );
}

function YesNoField({ def, value, onChange, disabled, phone }) {
  const v = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
  return (
    <div role="group" aria-label={def.label} style={{ display: 'flex', gap: 8 }}>
      <button type="button" aria-pressed={v === true} disabled={disabled} style={segBtn(v === true, phone)} onClick={() => onChange(true)}>Yes</button>
      <button type="button" aria-pressed={v === false} disabled={disabled} style={segBtn(v === false, phone)} onClick={() => onChange(false)}>No</button>
    </div>
  );
}

function SignatureField({ value, onChange, entryKey, disabled, signerName, phone, onUploading }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const adopt = ({ data }) => {
    setOpen(false);
    const file = dataUrlToFile(data, `signature-${Date.now()}.png`);
    if (!file) { setErr('The signature could not be saved - try again.'); return; }
    setBusy(true); setErr('');
    onUploading?.(1);
    storeTaskFile(file, null, FOLDER(entryKey))
      .then((url) => { if (url) onChange(url); else setErr('The signature could not be uploaded - try again.'); })
      .catch((e) => setErr(e?.message || 'The signature could not be uploaded - try again.'))
      .finally(() => { setBusy(false); onUploading?.(-1); });
  };
  return (
    <div>
      {value && (
        <div style={{ marginBottom: 8, padding: 8, border: `1px solid ${NX.border}`, borderRadius: 10, background: '#fff', display: 'inline-block' }}>
          <img src={value} alt="Signature" style={{ height: 56, display: 'block', maxWidth: '100%' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" style={chip(phone)} disabled={disabled || busy} onClick={() => setOpen(true)}>
          {busy ? <Spinner size="inline" /> : <PenTool size={14} />} {busy ? 'Saving...' : value ? 'Sign Again' : 'Sign'}
        </button>
        {value && !disabled && <button type="button" style={{ ...btn('ghost'), fontSize: 12, ...tap(phone) }} onClick={() => onChange('')}>Clear</button>}
      </div>
      {err && <div style={errStyle}>{err}</div>}
      {open && (
        <Suspense fallback={null}>
          <SignaturePad name={signerName || ''} onAdopt={adopt} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

// ── One field with its label, hint and problem ───────────────────────────────

function Field({ def, value, error, onChange, ctx, idKey }) {
  const inputId = `ff-${idKey}`;
  const disabled = ctx.disabled;
  const required = !!def.required;
  let control;
  let ownLabel = true;    // the control carries the label itself
  switch (def.type) {
    case 'photo': control = <PhotoField value={value} onChange={onChange} entryKey={ctx.entryKey} phone={ctx.phone} disabled={disabled} label={def.label} onUploading={ctx.onUploading} />; break;
    case 'gps': control = <GpsField value={value} onChange={onChange} workSites={ctx.workSites} disabled={disabled} phone={ctx.phone} />; break;
    case 'scan': control = <ScanField def={def} value={value} onChange={onChange} disabled={disabled} inputId={inputId} phone={ctx.phone} />; break;
    case 'rating': control = <RatingField def={def} value={value} onChange={onChange} disabled={disabled} phone={ctx.phone} />; break;
    case 'yesno': control = <YesNoField def={def} value={value} onChange={onChange} disabled={disabled} phone={ctx.phone} />; break;
    case 'signature': control = <SignatureField value={value} onChange={onChange} entryKey={ctx.entryKey} disabled={disabled} signerName={ctx.signerName} phone={ctx.phone} onUploading={ctx.onUploading} />; break;
    case 'date': control = <DateField value={value || ''} onChange={(v) => onChange(v || '')} title={def.label} disabled={disabled} style={{ width: '100%' }} />; break;
    // The 12-hour picker, never the native time box (it follows the computer's region).
    case 'time': control = <TimeField value={value || ''} onChange={(v) => onChange(v || '')} ariaLabel={def.label} disabled={disabled} step={5} style={{ width: '100%' }} />; break;
    case 'checkbox': ownLabel = false; control = <TypedFieldInput def={def} value={value} onChange={onChange} error={!!error} />; break;
    default: control = <TypedFieldInput def={def} value={value} onChange={onChange} error={!!error} />;
  }
  if (def.formula) {
    const v = ctx.computed?.[def.token];
    control = (
      <div className="form-input" aria-readonly="true" style={{ width: '100%', background: NX.surface2, color: v === null || v === undefined ? NX.faint : NX.ink, minHeight: 36, display: 'flex', alignItems: 'center' }}>
        {v === null || v === undefined ? 'Worked out from the other answers' : toText(v)}
      </div>
    );
  }
  // The label wraps a simple control so a tap on it focuses the box (and the
  // control is found by its label); a composite control gets a plain heading.
  const simple = !['photo', 'gps', 'rating', 'yesno', 'signature', 'checkbox', 'scan'].includes(def.type) && !def.formula;
  const head = (
    <>
      {/* The required mark is an icon, not text, so the label reads as its words alone. */}
      <span style={{ ...label, display: 'flex', alignItems: 'center', gap: 3 }}>{def.label}{required && <Asterisk size={11} aria-label="Required" style={{ color: NX.red }} />}</span>
      {def.description && <div style={{ ...hint, marginTop: -2, marginBottom: 6 }}>{def.description}</div>}
    </>
  );
  return (
    <div data-field={def.token} data-error={error ? 'true' : undefined} style={{ marginBottom: 16 }}>
      {simple ? <label style={{ display: 'block' }}>{head}{control}</label>
        : <>{ownLabel && (def.type === 'scan' ? <label htmlFor={inputId} style={{ display: 'block' }}>{head}</label> : head)}{control}</>}
      {error && <div role="alert" style={errStyle}>{error}</div>}
    </div>
  );
}

function RepeatGroup({ item, rows, errors, ctx, onRow, onAdd, onRemove, groupError }) {
  const name = groupLabel(item.repeat, item.defs);   // the one rule (forms/formsModel.js)
  const atMax = rows.length >= (item.max || 10);
  return (
    <div style={{ marginBottom: 16 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, padding: '12px 12px 0', marginBottom: 10, background: NX.surface2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: NX.dim }}>{name} {i + 1}</span>
            {!ctx.disabled && (
              <button type="button" aria-label={`Remove ${name} ${i + 1}`} onClick={() => onRemove(i)} style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12, color: NX.red, ...tap(ctx.phone) }}>
                <Trash2 size={13} /> Remove
              </button>
            )}
          </div>
          {item.defs.filter((d) => isVisible(d, { ...ctx.answers, ...row })).map((d) => (
            <Field key={d.token} def={d} value={row?.[d.token]} error={errors[`${item.repeat}.${i}.${d.token}`]}
              onChange={(v) => onRow(i, d.token, v)} ctx={ctx} idKey={`${item.repeat}-${i}-${d.token}`} />
          ))}
        </div>
      ))}
      {!ctx.disabled && (
        <button type="button" style={chip(ctx.phone)} disabled={atMax} onClick={onAdd} title={atMax ? `Up to ${item.max} here` : undefined}>
          <Plus size={14} /> Add Another {name}
        </button>
      )}
      {groupError && <div role="alert" style={errStyle}>{groupError}</div>}
    </div>
  );
}

// ── The screen ────────────────────────────────────────────────────────────────

export default function FillForm({ templateId, template: given = null, preview = false, onClose, onSent, shiftId = '', workSiteId = '', signerName = '', zIndex = 4100 }) {
  const phone = useIsMobile();
  const tid = given?.id || templateId;
  const me = useRole()?.myEmail || '';   // the draft is this person's (formDraft.js)
  const [tpl, setTpl] = useState(given);
  const [loadErr, setLoadErr] = useState('');
  const load = useCallback(() => {
    if (given) return;
    setLoadErr('');
    api.formGet(templateId).then(setTpl).catch((e) => setLoadErr(e?.message || 'Could not load this form.'));
  }, [templateId, given]);
  useEffect(() => { load(); }, [load]);

  const [entryKey, setEntryKey] = useState(() => newEntryKey());
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [site, setSite] = useState(workSiteId || '');
  // Photos and signatures still uploading - Send waits for them, so an entry
  // never goes without a picture the person already took.
  const [uploading, setUploading] = useState(0);
  const onUploading = useCallback((d) => setUploading((n) => Math.max(0, n + d)), []);
  // The draft offered back - until Continue or Discard nothing is saved over it.
  const [offer, setOffer] = useState(() => { if (preview) return null; const d = loadDraft(tid, me); return d && hasContent(d.answers) ? d : null; });
  const sending = useRef(false);
  const bodyRef = useRef(null);

  const defs = useMemo(() => (Array.isArray(tpl?.fieldDefs) ? tpl.fieldDefs : []), [tpl]);
  const sections = useMemo(() => groupDefs(defs), [defs]);
  const computed = useMemo(() => computeFormulas(defs, answers), [defs, answers]);
  const sites = tpl?.workSites || [];
  // A company with one work site: the entry is at it, without a question.
  const onlySite = sites.length === 1 ? sites[0].id : '';
  useEffect(() => { if (onlySite) setSite((cur) => cur || onlySite); }, [onlySite]);

  // The draft: saved a beat after each change (not while the offer is open,
  // never in a preview, never after the send).
  useEffect(() => {
    if (preview || offer || sent || !hasContent(answers)) return undefined;
    const t = setTimeout(() => saveDraft(tid, { entryKey, answers, title: tpl?.title }, me), 300);
    return () => clearTimeout(t);
  }, [answers, entryKey, tid, me, tpl?.title, preview, offer, sent]);

  // With the keyboard up on a phone the focused box stays in view as the
  // visual viewport shrinks (iOS slides the keyboard over the page).
  const vv = useVisualViewport(phone);
  const vvHeight = vv?.height;
  useEffect(() => {
    if (!phone || !vvHeight) return;
    const el = document.activeElement;
    if (el && bodyRef.current?.contains(el) && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [phone, vvHeight]);

  const setValue = useCallback((token, v) => {
    setAnswers((a) => ({ ...a, [token]: typeof v === 'function' ? v(a[token]) : v }));
    setErrors((e) => (e[token] ? { ...e, [token]: undefined } : e));
  }, []);
  const setRow = useCallback((group, i, token, v) => {
    setAnswers((a) => {
      const rows = Array.isArray(a[group]) ? [...a[group]] : [];
      const row = { ...(rows[i] || {}) };
      row[token] = typeof v === 'function' ? v(row[token]) : v;
      rows[i] = row;
      return { ...a, [group]: rows };
    });
    setErrors((e) => { const k = `${group}.${i}.${token}`; return e[k] || e[group] ? { ...e, [k]: undefined, [group]: undefined } : e; });
  }, []);
  const addRow = (group) => setAnswers((a) => ({ ...a, [group]: [...(Array.isArray(a[group]) ? a[group] : []), {}] }));
  const removeRow = (group, i) => {
    setAnswers((a) => ({ ...a, [group]: (Array.isArray(a[group]) ? a[group] : []).filter((_, j) => j !== i) }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(`${group}.`))));
  };

  const continueDraft = () => { if (!offer) return; setAnswers((a) => ({ ...offer.answers, ...a })); setEntryKey(offer.entryKey); setOffer(null); };
  const discardDraft = () => { clearDraft(tid, me); setOffer(null); };

  const submit = async () => {
    if (preview || sending.current || sent || uploading > 0) return;
    const errs = validateAnswers(defs, answers);
    if (Object.keys(errs).length) {
      setErrors(errs);
      setBanner('Fill in the fields marked below.');
      setTimeout(() => bodyRef.current?.querySelector('[data-error]')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 0);
      return;
    }
    sending.current = true; setBusy(true); setBanner('');
    try {
      const body = visibleAnswers(defs, answers);
      const stamp = defs.find((d) => d.type === 'gps' && body[d.token]);
      const entry = await api.formSubmit(tid, {
        entryKey, answers: body, workSiteId: site || '', shiftId: shiftId || '',
        source: phone ? 'phone' : 'web', ...(stamp ? { gps: body[stamp.token] } : {}),
      });
      clearDraft(tid, me);
      setSent(entry || { id: '' });
      onSent?.(entry);
    } catch (e) {
      // Whatever went wrong, the answers are on this device now - not in
      // 300ms - so a browser closed in frustration still has them.
      if (hasContent(answers)) saveDraft(tid, { entryKey, answers, title: tpl?.title }, me);
      // The server's rule check (routers/forms.py): 400 with detail
      // {message, errors: [{token, message}]} - a repeat row's token reads
      // "tires[1].psi", a whole group's failure is the group name. (A 422
      // list of {token, message} is read the same way.)
      const refused = Array.isArray(e?.detail?.errors) ? e.detail.errors : Array.isArray(e?.detail) ? e.detail : null;
      if (refused && (e.status === 400 || e.status === 422)) {
        const m = {};
        refused.forEach((d) => { if (d?.token) m[serverTokenKey(d.token)] = d.message || d.msg || 'Check this field'; });
        if (Object.keys(m).length) {
          setErrors(m);
          setBanner(e.detail?.message && e.detail.message !== 'Check the form' ? e.detail.message : 'Some answers were refused - check the fields marked below.');
          setTimeout(() => bodyRef.current?.querySelector('[data-error]')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 0);
        } else setBanner(e.detail?.message || e.message || 'Some answers were refused.');
      } else {
        setBanner(e?.message || 'Could not send - check your signal and try again. Your answers are kept here.');
      }
    } finally { sending.current = false; setBusy(false); }
  };

  const fillAnother = () => { setSent(null); setAnswers({}); setErrors({}); setBanner(''); setEntryKey(newEntryKey()); };

  const ctx = { answers, computed, entryKey, phone, workSites: sites, disabled: busy || !!sent, signerName, onUploading };
  const title = tpl?.title || 'Fill a Form';

  const footer = sent ? (
    <>
      <button type="button" style={btn('outline')} onClick={fillAnother}>Fill Another</button>
      <button type="button" style={btn('primary')} onClick={() => onClose?.()}>Done</button>
    </>
  ) : preview ? (
    <button type="button" style={btn('primary')} onClick={() => onClose?.()}>Close</button>
  ) : (
    <>
      <button type="button" style={btn('outline')} disabled={busy} onClick={() => onClose?.()}>Cancel</button>
      <button type="button" style={{ ...btn('primary'), opacity: busy || !tpl || uploading ? 0.6 : 1 }} disabled={busy || !tpl || uploading > 0} onClick={submit}>
        {busy ? <><Spinner size="inline" color="#fff" /> Sending...</>
          : uploading ? <><Spinner size="inline" color="#fff" /> Waiting for {uploading} photo{uploading === 1 ? '' : 's'}...</>
          : 'Send'}
      </button>
    </>
  );

  return (
    <Modal title={title} onClose={() => onClose?.()} footer={footer} zIndex={zIndex} isDirty={false}>
      <div ref={bodyRef} className="nx-fill" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: FONT }}>
        {loadErr ? <ErrorBanner message={loadErr} onRetry={load} />
          : !tpl ? <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner size="section" label="Loading the form" /></div>
          : sent ? (
            <div style={{ textAlign: 'center', padding: '28px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 54, height: 54, borderRadius: '50%', background: 'hsla(var(--color-green),0.12)', color: NX.green, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={28} /></span>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: NX.ink }}>Sent</h3>
              <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.5 }}>
                Your {tpl.title} is in{sent.submittedAt ? ` - ${formatDateTime(sent.submittedAt)}` : ''}.
              </div>
              {sent.id && (
                <button type="button" style={{ ...btn('outline'), marginTop: 6 }} onClick={() => { openEntry(sent); onClose?.(); }}>
                  <ExternalLink size={14} /> Open the Entry
                </button>
              )}
            </div>
          ) : (
            <>
              {preview && (
                <div role="status" style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(217,119,6,0.10)', color: NX.amber, fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>
                  Preview - nothing you enter here is sent.
                </div>
              )}
              {offer && (
                <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)', border: `1px solid ${NX.border}`, marginBottom: 14, fontSize: 12.5, color: NX.ink }}>
                  <RefreshCw size={14} style={{ color: NX.blue, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 160 }}>{draftNotice(offer)}</span>
                  <button type="button" style={{ ...btn('primary'), padding: '6px 12px', fontSize: 12.5 }} onClick={continueDraft}>Continue</button>
                  <button type="button" style={{ ...btn('outline'), padding: '6px 12px', fontSize: 12.5 }} onClick={discardDraft}>Discard</button>
                </div>
              )}
              {tpl.description && <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.5, marginBottom: 14 }}>{tpl.description}</div>}
              {banner && <div role="alert" style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', color: NX.red, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>{banner}</div>}
              {!workSiteId && sites.length > 1 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block' }}>
                    <span style={label}>Work Site</span>
                    <select className="form-input" style={{ width: '100%' }} value={site} onChange={(e) => setSite(e.target.value)} disabled={ctx.disabled}>
                      <option value="">- Not at a site -</option>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                </div>
              )}
              {sections.map((s, si) => (
                <section key={s.section || `s${si}`} aria-label={s.section || undefined} style={{ marginBottom: 8 }}>
                  {s.section && <h3 style={{ fontSize: 13.5, fontWeight: 800, color: NX.ink, margin: '6px 0 12px', paddingBottom: 6, borderBottom: `1px solid ${NX.border2}` }}>{s.section}</h3>}
                  {s.items.map((item) => (item.repeat ? (
                    <RepeatGroup key={item.repeat} item={item} rows={Array.isArray(answers[item.repeat]) ? answers[item.repeat] : []} errors={errors} ctx={ctx}
                      groupError={errors[item.repeat]} onRow={(i, token, v) => setRow(item.repeat, i, token, v)} onAdd={() => addRow(item.repeat)} onRemove={(i) => removeRow(item.repeat, i)} />
                  ) : isVisible(item.def, answers) ? (
                    <Field key={item.def.token} def={item.def} value={answers[item.def.token]} error={errors[item.def.token]}
                      onChange={(v) => setValue(item.def.token, v)} ctx={ctx} idKey={item.def.token} />
                  ) : null))}
                </section>
              ))}
              {!defs.length && <div style={{ fontSize: 13, color: NX.dim, padding: 20, textAlign: 'center' }}>This form has no fields yet.</div>}
            </>
          )}
      </div>
    </Modal>
  );
}
