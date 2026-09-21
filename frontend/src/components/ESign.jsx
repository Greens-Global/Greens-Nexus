import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import {
  FileSignature, Plus, X, Loader2, CheckCircle, XCircle, Clock, Send, Trash2,
  Pencil, FileText, Download, ShieldCheck, Bell, ChevronRight, ChevronLeft,
  ChevronUp, ChevronDown, Eraser, Type, PenTool, Users, AlertTriangle,
  RefreshCw, Ban, UploadCloud, ZoomIn, ZoomOut, ArrowRight,
  CalendarDays, CheckSquare, ALargeSmall, GripVertical, Copy, Search, CopyPlus,
  User, CircleDot, Check, Paperclip, Printer, Cloud, Info,
} from 'lucide-react';
import { api } from '../api';
import { PdfEditor } from './PdfEditor';
import { isDocx } from '../lib/docxFile';
import { RESERVED_TYPES as RESERVED_FIELD_TYPES, validateFieldValue, formatFieldValue } from '../lib/mergeFieldTypes';
import TypedFieldInput from './TypedFieldInput';
import EgnyteBrowser from './EgnyteBrowser';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import { useIsMobile } from '../lib/useIsMobile';
import { formatDate, formatDateTime } from '../lib/datetime';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import { useRole } from '../contexts/RoleContext';

// ── HR Section C - Native E-Sign (DocuSign-style UX) ──────────────────────────
// Send wizard (Document → Recipients → Fields → Review) with color-coded
// recipients and a drag/resize field editor; guided signing with a START/NEXT
// tab, progress bar and adopt-signature modal. Wizard + signing render INSIDE
// the Nexus shell (in-flow panels via useFillHeight), never as full-screen
// overlays. Backend contracts unchanged. PublicSign.jsx reuses SignaturePad +
// SigningDoc for /sign/{token}.

const FIELD_RE = /\[\[(sign|initials|date|text|check):([a-z0-9_]+)(?::([^\]]*))?\]\]/g;
const MERGE_RE = /\{\{([a-z0-9_]+)\}\}/g;

// "Fully Executed" rather than "Completed": on a legal record the distinction
// that matters is whether EVERY required signer has signed, and that is the
// word the business uses for it (review section 14). An envelope with some but
// not all signatures in is "Partially Executed" - never "Pending", which reads
// as though nobody has done anything.
const REQ_STATUS = {
  pending:   { label: 'Awaiting Signatures', fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
  partial:   { label: 'Partially Executed',  fg: 'hsl(var(--color-blue))',   bg: 'hsla(var(--color-blue),0.12)' },
  completed: { label: 'Fully Executed',      fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)' },
  declined:  { label: 'Declined',            fg: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)' },
  voided:    { label: 'Voided',              fg: 'var(--muted)',             bg: 'var(--mist)' },
  expired:   { label: 'Expired',             fg: 'var(--muted)',             bg: 'var(--mist)' },
};

// An envelope's badge key. `pending` splits in two depending on whether any
// signature is actually in, so a half-signed document never looks untouched.
const reqStatusKey = (r) => {
  if ((r?.status || '') !== 'pending') return r?.status || 'pending';
  const signers = (r?.parties || []).filter(p => ['signer', 'countersigner', 'witness']
    .includes(p.partyRole || 'signer'));
  return signers.some(p => p.status === 'signed') ? 'partial' : 'pending';
};
const PARTY_STATUS = {
  waiting:      { label: 'Waiting',      fg: 'var(--muted)' },
  notified:     { label: 'Notified',     fg: 'hsl(var(--color-blue))' },
  viewed:       { label: 'Viewed',       fg: 'hsl(var(--color-orange))' },
  signed:       { label: 'Signed',       fg: 'hsl(var(--color-green))' },
  approved:     { label: 'Approved',     fg: 'hsl(var(--color-green))' },
  acknowledged: { label: 'Acknowledged', fg: 'hsl(var(--color-green))' },
  declined:     { label: 'Declined',     fg: 'hsl(var(--color-red))' },
};
const KIND_LABEL = {
  offer: 'Offer Letter', nda: 'NDA', direct_deposit: 'Direct Deposit',
  handbook_ack: 'Handbook Ack', w9: 'W-9 / TIN', contractor_agreement: 'Contractor Agreement',
  sow: 'SOW', custom: 'Custom',
};
const MERGE_TOKENS = ['first_name', 'last_name', 'full_name', 'email', 'job_title',
  'department', 'start_date', 'salary', 'company', 'company_legal', 'company_address',
  'signatory', 'manager', 'today'];

// DocuSign-style recipient colors - each signer owns one; their fields inherit it.
const RCOLORS = [
  { solid: '#f59e0b', soft: 'rgba(245,158,11,0.16)' },   // amber
  { solid: '#3b82f6', soft: 'rgba(59,130,246,0.14)' },   // blue
  { solid: '#10b981', soft: 'rgba(16,185,129,0.14)' },   // emerald
  { solid: '#ec4899', soft: 'rgba(236,72,153,0.13)' },   // pink
  { solid: '#8b5cf6', soft: 'rgba(139,92,246,0.14)' },   // violet
  { solid: '#f97316', soft: 'rgba(249,115,22,0.15)' },   // orange
];
const rcolor = (i) => RCOLORS[i % RCOLORS.length];
const _ord = (n) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;

const FIELD_META = {
  sign:     { label: 'Signature',   Icon: PenTool,      w: 0.24, h: 0.055 },
  initials: { label: 'Initials',    Icon: Type,         w: 0.07, h: 0.035 },
  name:     { label: 'Name',        Icon: User,         w: 0.16, h: 0.03 },   // auto-filled from the recipient
  date:     { label: 'Date signed', Icon: CalendarDays, w: 0.12, h: 0.03 },
  text:     { label: 'Text',        Icon: ALargeSmall,  w: 0.2,  h: 0.032 },
  check:    { label: 'Checkbox',    Icon: CheckSquare,  w: 0.03, h: 0.022 },
  dropdown: { label: 'Dropdown',    Icon: ChevronDown,  w: 0.16, h: 0.032, opts: true },
  radio:    { label: 'Radio',       Icon: CircleDot,    w: 0.16, h: 0.09,  opts: true },
  // The signer attaches a file here - a certificate of insurance, a voided
  // check, a scanned license. The file is stored against the envelope and
  // hashed onto the certificate; the page itself records the filename.
  upload:   { label: 'File upload',  Icon: Paperclip,    w: 0.22, h: 0.04, labeled: true },
};

// Mirrors services/sign_uploads.ALLOWED - the server is the authority and
// rejects anything else, but the file picker should not offer what will bounce.
const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.tif,.tiff';

// The signature canvas's LOGICAL size - what gets exported as the PNG and
// stamped into the document, independent of how wide the modal renders. Both
// axes scale together: growing only the width would stretch every new
// signature against the field box it lands in.
const SIG_W = 660;
const SIG_H = 216;

const SIG_FONTS = ['"Segoe Script"', '"Brush Script MT"', '"Lucida Handwriting"'];

const FL = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.05em', textTransform: 'uppercase' };
const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = (maxWidth, maxHeight = 'min(94dvh, 880px)') => ({ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth, maxHeight, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' });

// Name box that auto-fills the email: type a teammate's name, matching people
// drop down beneath, picking one populates name + email. Free text stays as a
// custom (external) name. The Egnyte-Sign "add recipient" interaction.
function NameCombo({ value, employees, onChange, onPick, placeholder, style }) {
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = String(value || '').trim().toLowerCase();
    if (!q) return [];
    return (employees || []).filter(e => e.workEmail &&
      (`${e.firstName} ${e.lastName}`.toLowerCase().includes(q) || String(e.workEmail).toLowerCase().includes(q))).slice(0, 6);
  }, [value, employees]);
  return (
    <div style={{ position: 'relative', ...style }}>
      <input className="form-input" style={{ width: '100%' }} placeholder={placeholder || 'Full name - type to search teammates'}
        value={value} onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', overflow: 'hidden', marginTop: 4 }}>
          {matches.map(e => (
            <button key={e.id} onMouseDown={ev => ev.preventDefault()} onClick={() => { onPick(e); setOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{e.firstName} {e.lastName}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>{e.workEmail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Egnyte-Sign-style right panel: numbered recipient list, a "place fields for"
// dropdown, and a 2-column field grid (drag onto the page, or select + click).
// Shared by the template-attachment placer and the send wizard's field step.
// `recipientsSlot` swaps the static list for an editable recipients section.
function FieldsPanel({ recipients, activeIdx, onPick, activeType, setActiveType, placed, recipientsSlot, width = 330 }) {
  const c = (recipients[activeIdx] || recipients[0] || { color: rcolor(0) }).color;
  const initials = (s) => (s || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{ width, borderLeft: '1px solid var(--line)', background: 'var(--card)', overflowY: 'auto', padding: '16px 18px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 10 }}>Recipients &amp; Fields</div>
      {recipientsSlot}
      <div style={{ display: 'grid', gap: 8 }}>
        {!recipientsSlot && recipients.map((r, i) => (
          <button key={i} onClick={() => onPick(i)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 0', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif', overflow: 'hidden',
              border: i === activeIdx ? `2px solid ${r.color.solid}` : '1.5px solid var(--line)', background: i === activeIdx ? r.color.soft : 'var(--card)' }}>
            <span style={{ width: 4, alignSelf: 'stretch', background: r.color.solid, borderRadius: '0 2px 2px 0', flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--muted)', flexShrink: 0 }}>{i + 1}</span>
            <span style={{ width: 30, height: 30, borderRadius: '50%', background: r.color.soft, border: `1.5px solid ${r.color.solid}`, color: r.color.solid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{initials(r.label)}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
              {r.sub && <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</span>}
            </span>
          </button>
        ))}
      </div>
      <div style={{ margin: '18px 0 6px' }}><label style={{ ...FL, marginBottom: 0 }}>Drag and drop fields on the document for</label></div>
      <select className="form-input" value={activeIdx} onChange={e => onPick(+e.target.value)} style={{ width: '100%', fontWeight: 700 }}>
        {recipients.map((r, i) => <option key={i} value={i}>{r.label}</option>)}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
        {Object.entries(FIELD_META).map(([ft, M]) => (
          <button key={ft} draggable onDragStart={e => e.dataTransfer.setData('field', ft)} onClick={() => setActiveType(ft)}
            title="Drag onto the document, or select and click the page"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 7, borderRadius: 10, cursor: 'grab', textAlign: 'left', fontFamily: 'Inter,sans-serif',
              border: activeType === ft ? `2px solid ${c.solid}` : '1.5px solid var(--line)', background: activeType === ft ? c.soft : 'var(--card)' }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <M.Icon size={14} style={{ color: c.solid }} />
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink)' }}>{M.label}</span>
          </button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ marginTop: 14, fontSize: 11.5, fontWeight: 700, color: placed ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
        {placed} field{placed === 1 ? '' : 's'} placed
      </div>
      <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
        Drag placed fields to move · corner handle resizes · × removes · ✎ edits choices.
      </p>
    </div>
  );
}

// Options editor for dropdown / radio fields (shared by both field placers).
function FieldOptionsModal({ field, onSave, onClose }) {
  const initial = field.options?.length ? [...field.options] : ['', ''];
  const [opts, setOpts] = useState(initial);
  // Deduped - twin values make radio selection ambiguous (both rows tick) and
  // the sealed PDF would fill both circles.
  const clean = [...new Set(opts.map(o => o.trim()).filter(Boolean))];
  const dirty = JSON.stringify(opts) !== JSON.stringify(initial);
  const guard = useUnsavedGuard(dirty, onClose, clean.length >= 2 ? () => { onSave(clean); onClose(); } : undefined);
  return (
    <div style={{ ...overlayStyle, zIndex: 1500 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={cardStyle(520)}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>{FIELD_META[field.type]?.label} options</h3>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={16} /></button>
        </div>
        <div style={{ padding: '14px 20px', overflowY: 'auto' }}>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 10px' }}>The values the signer can choose from - at least two.</p>
          {opts.map((o, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <input className="form-input" value={o} placeholder={`Option ${i + 1}`} autoFocus={i === opts.length - 1 && !o}
                onChange={e => setOpts(os => os.map((x, j) => j === i ? e.target.value : x))} style={{ flex: 1 }} />
              <button onClick={() => setOpts(os => os.filter((_, j) => j !== i))} disabled={opts.length <= 2}
                style={{ background: 'none', border: 'none', color: opts.length <= 2 ? 'var(--line)' : 'hsl(var(--color-red))', cursor: opts.length <= 2 ? 'default' : 'pointer', display: 'flex', padding: 4 }}><Trash2 size={13} /></button>
            </div>
          ))}
          <button className="secondary-btn" onClick={() => setOpts(os => [...os, ''])}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Option</button>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={clean.length < 2} onClick={() => { onSave(clean); onClose(); }}
            style={{ opacity: clean.length < 2 ? 0.5 : 1 }}>Save Options</button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={guard.keepEditing}
          onDiscard={onClose}
          onSave={clean.length >= 2 ? guard.saveAndClose : undefined}
        />
      )}
    </div>
  );
}
// Label editor for upload fields (shared by both field placers). An upload box
// is the one field whose label the signer MUST read - "Field 3" tells nobody
// which certificate to attach - so it is editable at placement rather than
// defaulting to the type name forever.
function FieldLabelModal({ field, onSave, onClose }) {
  const initial = field.label || '';
  const [label, setLabel] = useState(initial);
  const [required, setRequired] = useState(field.required !== false);
  const dirty = label !== initial || required !== (field.required !== false);
  const save = () => { onSave({ label: label.trim(), required }); onClose(); };
  const guard = useUnsavedGuard(dirty, onClose, save);
  return (
    <div style={{ ...overlayStyle, zIndex: 1500 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={cardStyle(480)}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Attachment Field</h3>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={16} /></button>
        </div>
        <div style={{ padding: '16px 20px' }}>
          <label style={FL}>What should the signer attach?</label>
          <input className="form-input" autoFocus value={label} style={{ width: '100%' }}
            placeholder="Certificate of insurance" onChange={e => setLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); }} />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '8px 0 14px' }}>
            Shown on the box the signer clicks, and named on the signing certificate.
          </p>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)}
              style={{ width: 15, height: 15, marginTop: 1, accentColor: 'var(--pine)' }} />
            <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              Required - the signer cannot finish without attaching a file.
            </span>
          </label>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save}>Save</button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} />
      )}
    </div>
  );
}
const chip = (m) => ({ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: 'nowrap' });
const initialsOf = (name) => (name || '').split(' ').slice(0, 3).map(w => w[0]?.toUpperCase() || '').join('') || '-';

// Full-page E-Sign screens (send wizard, signing) render IN the Nexus shell -
// an in-flow panel sized to the space under the header/HR tabs, not a
// fixed overlay that hides the sidebar (Neil: "keep it within Nexus").
// Measured because the chrome above varies (HR tabs, banners, mobile bar).
function useFillHeight(minH = 420) {
  const ref = useRef(null);
  const [h, setH] = useState(minH);
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    const measure = () => {
      if (!ref.current) return;
      const bottomPad = window.matchMedia('(max-width: 900px)').matches ? 80 : 14;
      setH(Math.max(minH, window.innerHeight - ref.current.getBoundingClientRect().top - bottomPad));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [minH]);
  return [ref, h];
}
const fillPanelStyle = (h) => ({ height: h, display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 14, background: 'var(--bg, #f3f4f6)', overflow: 'hidden' });

// ── Signature pad - draw or type (with font styles), DocuSign "adopt" flow ────
export function SignaturePad({ name = '', onAdopt, onClose }) {
  const [tab, setTab] = useState('type');
  const [typed, setTyped] = useState(name);
  const [font, setFont] = useState(0);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef(null);
  const strokes = useRef([]);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const scale = window.devicePixelRatio || 1;
    c.width = SIG_W * scale; c.height = SIG_H * scale;
    c.getContext('2d').scale(scale, scale);
    redraw();
  }, [tab]);

  function redraw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, SIG_W, SIG_H);
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes.current) {
      ctx.beginPath();
      s.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
    setHasInk(strokes.current.length > 0);
  }
  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (SIG_W / r.width), y: (e.clientY - r.top) * (SIG_H / r.height) };
  };
  const down = (e) => { drawing.current = true; strokes.current.push([pos(e)]); e.target.setPointerCapture?.(e.pointerId); };
  const move = (e) => { if (!drawing.current) return; strokes.current[strokes.current.length - 1].push(pos(e)); redraw(); };
  const up = () => { drawing.current = false; redraw(); };

  function adopt() {
    if (tab === 'draw') {
      if (!strokes.current.length) return;
      onAdopt({ kind: 'drawn', data: canvasRef.current.toDataURL('image/png') });
    } else {
      if (!typed.trim()) return;
      // Typed signatures render the chosen style to a PNG so the sealed PDF
      // shows exactly what the signer adopted (not a generic oblique).
      const c = document.createElement('canvas');
      const scale = 2;
      c.width = SIG_W * scale; c.height = Math.round(SIG_H * 0.82) * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#111827';
      ctx.font = `52px ${SIG_FONTS[font]}, cursive`;
      ctx.textBaseline = 'middle';
      ctx.fillText(typed.trim(), 12, 70);
      onAdopt({ kind: 'drawn', data: c.toDataURL('image/png'), typedName: typed.trim() });
    }
  }

  const seg = (id, label, Icon) => (
    <button key={id} onClick={() => setTab(id)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 20px', borderRadius: 9, fontSize: 13, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', border: '1px solid var(--line)', background: tab === id ? 'var(--pine)' : 'var(--card)', color: tab === id ? '#fff' : 'var(--ink)' }}>
      <Icon size={14} /> {label}
    </button>
  );

  // A drawn stroke or a typed name beyond the pre-filled default would
  // otherwise be silently lost on an outside click - a legally meaningful
  // loss for a signature specifically.
  const dirty = tab === 'draw' ? hasInk : typed.trim() !== (name || '').trim();
  const guard = useUnsavedGuard(dirty, onClose, (tab === 'draw' ? hasInk : typed.trim()) ? adopt : undefined);

  return (
    <div style={{ ...overlayStyle, zIndex: 1400 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={cardStyle(760)}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <PenTool size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Adopt Your Signature</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>This becomes your legal signature on this document.</div>
          </div>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '18px 24px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>{seg('type', 'Type', Type)}{seg('draw', 'Draw', PenTool)}</div>
          {tab === 'draw' ? (
            <>
              <div style={{ position: 'relative' }}>
                <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up}
                  style={{ width: '100%', height: SIG_H, border: '1.5px dashed var(--line)', borderRadius: 12, touchAction: 'none', cursor: 'crosshair', background: '#fff' }} />
                {!hasInk && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13, pointerEvents: 'none' }}>Draw your signature with your mouse or finger</span>}
                <span style={{ position: 'absolute', left: 20, bottom: 26, right: 20, borderBottom: '1px solid #d1d5db', pointerEvents: 'none' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="secondary-btn" onClick={() => { strokes.current.pop(); redraw(); }} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={12} /> Undo</button>
                <button className="secondary-btn" onClick={() => { strokes.current = []; redraw(); }} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eraser size={12} /> Clear</button>
              </div>
            </>
          ) : (
            <>
              <input className="form-input" style={{ width: '100%', fontSize: 15 }} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type your full legal name" autoFocus />
              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                {SIG_FONTS.map((ff, i) => (
                  <button key={i} onClick={() => setFont(i)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'left', background: '#fff', border: font === i ? '2px solid var(--pine)' : '1.5px solid var(--line)' }}>
                    <span style={{ width: 16, height: 16, borderRadius: '50%', border: font === i ? '5px solid var(--pine)' : '2px solid var(--line)', flexShrink: 0, boxSizing: 'border-box' }} />
                    <span style={{ fontFamily: `${ff}, cursive`, fontSize: 26, color: '#111827', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{typed || 'Your name'}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, color: 'var(--muted)', maxWidth: 300 }}>By adopting, you agree this is the electronic equivalent of your handwritten signature.</span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="secondary-btn" onClick={onClose}>Cancel</button>
            <button className="primary-btn" onClick={adopt} disabled={tab === 'draw' ? !hasInk : !typed.trim()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (tab === 'draw' ? hasInk : typed.trim()) ? 1 : 0.55 }}>
              <CheckCircle size={14} /> Adopt &amp; sign
            </button>
          </div>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={guard.keepEditing}
          onDiscard={onClose}
          onSave={(tab === 'draw' ? hasInk : typed.trim()) ? guard.saveAndClose : undefined}
        />
      )}
    </div>
  );
}

// ── PDF renderer (pdfjs) - takes a File OR a URL; overlay via render-prop ─────
// Passing the File's bytes directly (not fetch(blobUrl)) sidesteps CSP blocks
// on blob: fetches - the "Failed to fetch" bug in v1.
function PdfDoc({ url, file, zoom = 1, renderOverlay, onPageSeen, onPageCount }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState('');
  // Which pages were actually SCROLLED INTO VIEW. The certificate may only say
  // "all pages viewed before signing" if that really happened, so this watches
  // the rendered elements rather than assuming a signature implies reading.
  const seenRef = useRef(new Set());
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        const buf = file ? await file.arrayBuffer() : await (await fetch(url)).arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: buf }).promise;
        const out = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          out.push({ dataUrl: canvas.toDataURL() });
        }
        if (live) { setPages(out); onPageCount?.(out.length); }
      } catch (e) { if (live) setError(e?.message || 'Could not render the PDF.'); }
    })();
    return () => { live = false; };
  }, [url, file]);

  if (error) return <div style={{ fontSize: 13, color: 'hsl(var(--color-red))', padding: 16, display: 'flex', gap: 8, alignItems: 'center' }}><AlertTriangle size={15} /> {error}</div>;
  if (!pages) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
      <div style={{ fontSize: 12, marginTop: 10 }}>Rendering document…</div>
      {/* An indeterminate bar, not a bare spinner: "everything has a loading
          bar on it, so you're not just looking at an empty screen." */}
      <div style={{ margin: '12px auto 0', width: 220, height: 3, borderRadius: 2, background: 'var(--line)', overflow: 'hidden' }}>
        <div style={{ width: '38%', height: '100%', borderRadius: 2, background: 'var(--pine, #166534)', animation: 'nexus-sign-slide 1.15s ease-in-out infinite' }} />
      </div>
      <style>{'@keyframes nexus-sign-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}'}</style>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 26, justifyItems: 'center' }}>
      {pages.map((p, i) => (
        <div key={i}
          ref={el => {
            if (!el || !onPageSeen || seenRef.current.has(i)) return;
            const io = new IntersectionObserver(entries => {
              if (entries.some(e => e.isIntersecting) && !seenRef.current.has(i)) {
                seenRef.current.add(i);
                onPageSeen(i, pages.length);
                io.disconnect();
              }
            }, { threshold: 0.35 });
            io.observe(el);
          }}
          style={{ position: 'relative', width: `${Math.round(zoom * 100)}%`, maxWidth: 980, boxShadow: '0 2px 12px rgba(0,0,0,0.14)', borderRadius: 4, background: '#fff' }}>
          <img src={p.dataUrl} alt={`Page ${i + 1}`} style={{ width: '100%', display: 'block', borderRadius: 4 }} draggable={false} />
          {renderOverlay?.(i)}
          <span style={{ position: 'absolute', top: -19, right: 2, fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>Page {i + 1} of {pages.length}</span>
        </div>
      ))}
    </div>
  );
}

// ── Guided signing screen - progress, START/NEXT tab, yellow sign-here tabs ───
// Shared by the internal modal AND the public /sign/{token} page.
// ── ESIGN consumer disclosures (15 U.S.C. 7001(c)) ───────────────────────────
// These have to be AVAILABLE TO READ BEFORE the signer consents, not hidden in
// a tooltip: 7001(c) is the one part of US e-signature law that prescribes
// content (paper copy, withdrawal, scope, how to get copies, hardware/software
// requirements), and the Certificate of Completion states they were shown.
// The backend ships them with the signing payload so this panel and the
// certificate always quote the same version.
function ConsentDisclosures({ payload }) {
  const [open, setOpen] = useState(false);
  const items = payload.disclosures || [];
  if (!items.length) return null;
  return (
    <>
      <button type="button" onClick={(e) => { e.preventDefault(); setOpen(o => !o); }}
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {open ? 'Hide disclosures' : 'Read disclosures'}
      </button>
      {open && (
        <div style={{ flexBasis: '100%', order: 9, marginTop: 4, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--mist)', padding: '12px 14px', maxHeight: 260, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>Electronic Records and Signatures Disclosure</div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Version {payload.consentVersion}</div>
          </div>
          {items.map(d => (
            <div key={d.heading} style={{ marginBottom: 9 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 2 }}>{d.heading}</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--ink)' }}>{d.body}</div>
            </div>
          ))}
          <div style={{ fontSize: 11.5, lineHeight: 1.55, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <b>By checking the box you confirm:</b> {payload.consentText}
          </div>
          <button type="button" onClick={() => window.print()}
            style={{ marginTop: 10, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            Print or Save a Copy
          </button>
        </div>
      )}
    </>
  );
}

// ── Step 1 of signing: consent, on its own screen, before the document ──────
// Cal. Civ. Code 1633.5(b) is where this started - California will not treat an
// agreement to conduct business electronically as given if it is bundled into
// the transaction itself, and a checkbox beside the contract is exactly that
// bundling. The Nexus Sign review asked for the same ordering everywhere, so
// this is now the first screen of EVERY envelope, not just Californian ones.
// Declining is offered as plainly as accepting: the deal must not be
// conditioned on consenting.
//
// The server withholds the document until this posts, so the gate is not a
// convention the client could skip - there is simply nothing to render yet.
// That is also why the 7001(c)(1)(C)(ii) demonstration cannot be captured here:
// the format the signer can open is reported later, by the viewer that
// actually rendered it (see format_demonstrated in the sign call).
function ConsentGate({ payload, busy, onAccept, onDecline }) {
  const [read, setRead] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const items = payload.disclosures || [];
  const scrollRef = useRef(null);

  // "Read" means the disclosure was actually scrolled to the end - not that a
  // box was ticked next to a collapsed panel.
  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setRead(true);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setRead(true);   // short enough to be fully visible
  }, [items.length]);

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '18px 4px' }}>
      <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
          <StepRail current={1} />
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: '10px 0 4px' }}>Before You Sign</h2>
          <p style={{ fontSize: 12.5, color: 'var(--muted, #6b7280)', margin: 0, lineHeight: 1.55 }}>
            Signing electronically is something you agree to separately from the agreement
            itself.{' '}
            Please read the disclosure below. Agreeing is your choice - if you would rather sign on
            paper, say so and we will arrange it. The agreement itself is not affected either way.
          </p>
        </div>

        <div ref={scrollRef} onScroll={onScroll}
          style={{ padding: '16px 22px', maxHeight: 340, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Electronic Records and Signatures Disclosure</div>
            <div style={{ fontSize: 10.5, color: 'var(--muted, #6b7280)' }}>Version {payload.consentVersion}</div>
          </div>
          {items.map(d => (
            <div key={d.heading} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{d.heading}</div>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>{d.body}</div>
            </div>
          ))}
          <div style={{ fontSize: 12, lineHeight: 1.6, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 10 }}>
            <b>What you are agreeing to:</b> {payload.consentText}
          </div>
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line, #e5e7eb)', background: 'var(--mist, #f6f7f9)' }}>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: read ? 'pointer' : 'not-allowed', opacity: read ? 1 : 0.55 }}>
            <input type="checkbox" checked={agreed} disabled={!read}
              onChange={e => setAgreed(e.target.checked)}
              style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0, accentColor: 'var(--pine, #166534)' }} />
            <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              I have read the disclosure and I agree to use electronic records and signatures for
              this document.
            </span>
          </label>
          {!read && (
            <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)', marginTop: 8, marginLeft: 24 }}>
              Scroll to the end of the disclosure to continue.
            </div>
          )}
          {/* Electronic signing is the primary path; paper stays available but
              must not compete with it visually (review section 12). */}
          <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="primary-btn" disabled={!agreed || busy} onClick={onAccept}
              style={{ opacity: agreed && !busy ? 1 : 0.5, fontSize: 13.5, padding: '11px 26px', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
              Sign Electronically
            </button>
            <button onClick={onDecline}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--muted, #6b7280)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif', textDecoration: 'underline' }}>
              I would rather sign on paper
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted, #6b7280)', marginTop: 10 }}>
            You can withdraw this agreement at any time before you sign - see the disclosure above.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Where the signer is, in three steps ─────────────────────────────────────
// Shown on the gates, not on the document: once someone is filling fields the
// progress that matters is how many fields are left, and two competing
// progress indicators is one too many.
const STEPS = ['Consent', 'Verify', 'Review & Sign'];

function StepRail({ current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current, active = n === current;
        return (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: active ? 800 : 600,
              color: active ? 'var(--ink, #111827)' : 'var(--muted, #6b7280)' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800, background: done ? 'hsl(142,60%,35%)' : active ? '#14532d' : 'var(--line, #e5e7eb)',
                color: done || active ? '#fff' : 'var(--muted, #6b7280)' }}>
                {done ? <Check size={11} /> : n}
              </span>
              {label}
            </span>
            {n < STEPS.length && <span style={{ width: 18, height: 1, background: 'var(--line, #e5e7eb)' }} />}
          </span>
        );
      })}
    </div>
  );
}

// ── Step 2 of signing: the one-time code ────────────────────────────────────
// Mandatory for every signature (review section 5). The link arrives by email,
// so an emailed code is a weaker second factor than a texted one - which is
// exactly why the sender can put a phone number on a recipient and why the
// channel actually used is named on the certificate rather than glossed.
function OtpGate({ payload, busy, onRequest, onVerify, error }) {
  const channels = payload.otpChannels || [];
  const [channel, setChannel] = useState(channels[0]?.channel || 'email');
  const [sent, setSent] = useState(null);      // { channel, masked } once a code is out
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async (ch) => {
    const got = await onRequest(ch);
    if (got) { setSent(got); setCooldown(30); setCode(''); }
  };

  const chLabel = (c) => (c === 'sms' ? 'Text message' : 'Email');

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '18px 4px' }}>
      <div style={{ background: 'var(--card, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
          <StepRail current={2} />
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: '10px 0 4px' }}>Verify It's You</h2>
          <p style={{ fontSize: 12.5, color: 'var(--muted, #6b7280)', margin: 0, lineHeight: 1.55 }}>
            We send a single-use code before showing you the document. This is recorded on the
            signing certificate as part of how your signature was verified.
          </p>
        </div>
        <div style={{ padding: '18px 22px' }}>
          {!sent ? (
            <>
              {channels.length > 1 && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                  {channels.map(c => (
                    <label key={c.channel} style={{ display: 'flex', alignItems: 'center', gap: 9, flex: '1 1 190px', cursor: 'pointer',
                      border: `1.5px solid ${channel === c.channel ? 'var(--pine, #166534)' : 'var(--line, #e5e7eb)'}`,
                      background: channel === c.channel ? 'rgba(22,101,52,0.06)' : 'transparent',
                      borderRadius: 10, padding: '11px 13px' }}>
                      <input type="radio" name="otp-channel" checked={channel === c.channel}
                        onChange={() => setChannel(c.channel)}
                        style={{ width: 15, height: 15, accentColor: 'var(--pine, #166534)' }} />
                      <span>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700 }}>{chLabel(c.channel)}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted, #6b7280)' }}>{c.masked}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {channels.length === 1 && (
                <p style={{ fontSize: 13, margin: '0 0 16px' }}>
                  We'll send your code to <b>{channels[0].masked}</b>.
                </p>
              )}
              <button className="primary-btn" disabled={busy} onClick={() => send(channel)}
                style={{ fontSize: 13.5, padding: '11px 26px', display: 'inline-flex', alignItems: 'center', gap: 7, opacity: busy ? 0.6 : 1 }}>
                {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
                Send Code
              </button>
            </>
          ) : (
            <form onSubmit={e => { e.preventDefault(); if (code.trim().length === 6) onVerify(code.trim()); }}>
              <p style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.6 }}>
                We sent a 6-digit code to <b>{sent.masked}</b>. It expires in 10 minutes.
              </p>
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                style={{ width: 200, textAlign: 'center', fontSize: 26, fontWeight: 700, letterSpacing: 10,
                  padding: '12px 10px', borderRadius: 10, border: '1.5px solid var(--line, #d1d5db)',
                  fontFamily: 'Inter,sans-serif', background: 'var(--card, #fff)', color: 'var(--ink, #111827)' }} />
              {error && (
                <p style={{ fontSize: 12.5, color: 'hsl(350,65%,48%)', margin: '10px 0 0', fontWeight: 600 }}>{error}</p>
              )}
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                <button type="submit" className="primary-btn" disabled={code.length !== 6 || busy}
                  style={{ fontSize: 13.5, padding: '11px 26px', opacity: code.length === 6 && !busy ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldCheck size={14} />}
                  Verify &amp; Continue
                </button>
                <button type="button" disabled={cooldown > 0 || busy} onClick={() => send(sent.channel)}
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: 12.5, fontWeight: 600,
                    color: 'var(--muted, #6b7280)', cursor: cooldown > 0 ? 'default' : 'pointer',
                    fontFamily: 'Inter,sans-serif', textDecoration: cooldown > 0 ? 'none' : 'underline' }}>
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ── The two gates, driven by what the server says is outstanding ────────────
// `payload.gate` is authoritative: the document URLs are simply absent until it
// is empty, so this component cannot be bypassed by a client that ignores it.
export function SigningGate({ payload, gateApi, onCleared, onDecline }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setBusy(true); setError('');
    try { return await fn(); }
    catch (e) { setError(e.message || 'Something went wrong'); return null; }
    finally { setBusy(false); }
  };

  if (payload.gate === 'otp') {
    return (
      <OtpGate payload={payload} busy={busy} error={error}
        onRequest={(channel) => run(() => gateApi.otpRequest(channel))}
        onVerify={(code) => run(async () => { await gateApi.otpVerify(code); onCleared(); })} />
    );
  }
  return (
    <>
      {error && (
        <div style={{ maxWidth: 680, margin: '0 auto 12px', padding: '10px 14px', borderRadius: 10,
          background: 'hsla(350,65%,48%,0.08)', color: 'hsl(350,65%,48%)', fontSize: 12.5, fontWeight: 600 }}>
          {error}
        </div>
      )}
      <ConsentGate payload={payload} busy={busy} onDecline={onDecline}
        onAccept={() => run(async () => { await gateApi.consent(); onCleared(); })} />
    </>
  );
}


// ── Upload field ────────────────────────────────────────────────────────────
// A signer attaching evidence - an insurance certificate, a voided check - at
// a field the sender placed. Three ways in, because this is the one field an
// external signer is most likely to be filling on a phone: the picker, a drop,
// and Ctrl+V (the house rule for every image-upload widget in Nexus - see
// imageFromPaste in InventoryManagement.jsx). Paste is bound while the field
// has focus, so two upload fields on one page cannot both claim the clipboard.
// -- Envelope history --------------------------------------------------------
// Neil, Sep 16, on DocuSign's equivalent: "This is actually excellent ... you
// need to get this exactly right." What makes it right is that it reads as a
// story - created, sent, received, verified, opened, opened again, signed -
// rather than a status word. The server already keeps every one of those as an
// append-only event; this just tells it back in order.
function HistoryPanel({ loadHistory, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    loadHistory()
      .then(d => { if (live) setRows(d.events || []); })
      .catch(e => { if (live) setError(e.message || 'Could not load the history.'); });
    return () => { live = false; };
  }, [loadHistory]);

  return (
    <div style={{ ...overlayStyle, zIndex: 1450 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(620)}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Clock size={17} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1 }}>History</h3>
          <button onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: '6px 24px 18px', overflowY: 'auto' }}>
          {error ? (
            <p style={{ fontSize: 13, color: 'hsl(var(--color-red))', margin: '14px 0' }}>{error}</p>
          ) : !rows ? (
            <div style={{ padding: '26px 0', textAlign: 'center', color: 'var(--muted)' }}>
              <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
              <div style={{ fontSize: 12, marginTop: 8 }}>Loading history…</div>
            </div>
          ) : !rows.length ? (
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '14px 0' }}>Nothing recorded yet.</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
              {rows.map((r, i) => (
                <li key={i} style={{ display: 'grid', gridTemplateColumns: '14px 1fr', gap: 12, paddingBottom: 14 }}>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                      background: r.you ? 'var(--pine, #166534)' : 'var(--line)' }} />
                    {i < rows.length - 1 && <span style={{ flex: 1, width: 1, background: 'var(--line)', marginTop: 3 }} />}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'baseline' }}>
                      <b style={{ fontSize: 13.5, fontWeight: 700 }}>{r.label}</b>
                      {r.you && (
                        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase',
                          color: 'var(--pine, #166534)' }}>You</span>
                      )}
                      <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                        {formatDateTime(r.at)}
                      </span>
                    </span>
                    {r.actor && (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{r.actor}</span>
                    )}
                    {r.detail && (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>
                        {r.detail}
                      </span>
                    )}
                    {(r.ip || r.device) && (
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        {[r.ip, r.device].filter(Boolean).join(' \u00b7 ')}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function UploadField({ field, style, innerRef, record, busy, disabled, error,
                      accept, hint, onFile }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const boxRef = useRef(null);

  const onPaste = (e) => {
    const file = [...(e.clipboardData?.files || [])][0]
      || [...(e.clipboardData?.items || [])]
        .filter(i => i.kind === 'file').map(i => i.getAsFile())[0];
    if (file) { e.preventDefault(); onFile(file); }
  };

  const done = !!record;
  const border = error ? 'hsl(var(--color-red))' : done ? '#10b981' : '#fbbf24';
  const bg = error ? 'rgba(220,38,38,0.08)'
    : done ? 'rgba(16,185,129,0.08)' : over ? 'rgba(251,191,36,0.4)' : 'rgba(251,191,36,0.22)';

  return (
    <div ref={el => { boxRef.current = el; innerRef?.(el); }}
      tabIndex={disabled ? -1 : 0}
      onPaste={onPaste}
      onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault(); setOver(false);
        const file = e.dataTransfer?.files?.[0];
        if (file && !disabled) onFile(file);
      }}
      onClick={() => !disabled && !busy && inputRef.current?.click()}
      title={done ? `${record.name} - click to replace`
        : `Attach a file${hint ? ` (${hint})` : ''}. You can also drop one here or press Ctrl+V.`}
      style={{
        ...style, border: `1.5px dashed ${border}`, background: bg, borderRadius: 6,
        display: 'flex', alignItems: 'center', gap: 5, padding: '0 6px', overflow: 'hidden',
        cursor: disabled ? 'default' : 'pointer', fontFamily: 'Inter,sans-serif',
        fontSize: 10.5, fontWeight: 700, color: done ? '#065f46' : '#78350f',
      }}>
      <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
      {busy ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
        : done ? <Check size={11} style={{ flexShrink: 0 }} />
          : <Paperclip size={11} style={{ flexShrink: 0 }} />}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {busy ? 'Uploading…' : done ? record.name : (field.label || 'Attach a file')}
      </span>
    </div>
  );
}

export function SigningDoc({ payload, busy, onSubmit, onDecline, gateApi, onCleared, uploadApi, paperApi, historyApi }) {
  const [sig, setSig] = useState(null);
  const [padOpen, setPadOpen] = useState(false);
  // Consent is no longer a checkbox beside the contract - it is step 1, taken
  // on its own screen and recorded server-side before the document is sent to
  // this browser. By the time anything below renders, it is an accomplished
  // fact, which is why this reads the timestamp instead of holding state.
  const consent = !!payload.consentAt;
  const needsGate = !!payload.gate;
  // What the signer's browser actually rendered, reported to the server as the
  // 7001(c)(1)(C)(ii) demonstration - never assumed, so a template-bodied
  // envelope reports HTML and a PDF one reports PDF.
  const formatDemonstrated = payload.source === 'template'
    ? 'html_rendered_in_session' : 'pdf_rendered_in_session';
  // Pages this session actually displayed. Reported verbatim to the server; a
  // partial count is recorded as a partial count, never rounded up.
  const seenPages = useRef(new Set());
  const [pagesTotal, setPagesTotal] = useState(0);
  const notePageSeen = useCallback((index, total) => {
    seenPages.current.add(index);
    setPagesTotal(t => (total > t ? total : t));
  }, []);
  const [values, setValues] = useState({});
  // Upload fields, keyed by field id. Seeded from the server so a signer who
  // comes back to the link sees what they already attached rather than an
  // empty box they would dutifully fill again; the server row is the truth,
  // this is just what is on screen.
  const [uploads, setUploads] = useState(
    () => Object.fromEntries((payload.uploads || []).map(u => [u.fieldId, u])));
  const [uploading, setUploading] = useState('');    // field id currently in flight
  const [uploadErr, setUploadErr] = useState(null);  // { fieldId, message }
  useEffect(() => {
    setUploads(Object.fromEntries((payload.uploads || []).map(u => [u.fieldId, u])));
  }, [payload.uploads]);

  const limit = payload.uploadLimit || {};
  // One place that takes a File and puts it on a field. Everything that can
  // produce a file - the picker, a drop, Ctrl+V - funnels through here so the
  // size check, the busy state and the error message cannot drift apart.
  const takeFile = async (fieldId, file) => {
    if (!file || !uploadApi) return;
    setUploadErr(null);
    if (limit.maxBytes && file.size > limit.maxBytes) {
      setUploadErr({ fieldId, message: `That file is ${(file.size / 1048576).toFixed(1)} MB. `
        + `Please upload something under ${Math.round(limit.maxBytes / 1048576)} MB.` });
      return;
    }
    setUploading(fieldId);
    try {
      const rec = await uploadApi(fieldId, file);
      setUploads(u => ({ ...u, [fieldId]: rec }));
    } catch (e) {
      setUploadErr({ fieldId, message: e.message || 'That file could not be uploaded.' });
    }
    setUploading('');
  };

  // Document viewer controls. Neil, Sep 16: zoom in, zoom out, download, print
  // and seeing every page are "super important" on the signer's side - an
  // external signer is reading a contract, often on a laptop screen at 100%.
  const [zoom, setZoom] = useState(1);
  const [docPages, setDocPages] = useState(0);
  const printDoc = () => {
    // Print the SOURCE pdf, not the screen: the browser's print of a canvas
    // stack is unreliable and drops the overlay anyway.
    const target = payload.copyUrl || payload.pdfUrl;
    if (target) window.open(target, '_blank', 'noopener');
  };

  const [listOpen, setListOpen] = useState(false);   // outstanding-fields popover
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  // Declining is itself a consequential, one-way action - Save Changes isn't
  // offered on this guard (only Keep Editing / Discard); the modal's own
  // primary "Decline" button is the deliberate way to actually submit it.
  const declineGuard = useUnsavedGuard(!!declineReason.trim(), () => setDeclineOpen(false), undefined);
  const fieldRefs = useRef({});
  const myRole = payload.myRole;
  const isTemplate = payload.source === 'template';
  const setVal = (k, v) => setValues(p => ({ ...p, [k]: v }));

  // Every actionable field of mine, in document order, with a completion check.
  const ACTIONABLE = ['sign', 'check', 'text', 'dropdown', 'radio', 'upload'];
  // What a field is CALLED when it is listed as outstanding. A signer chasing
  // the last empty box on page 5 needs a name for it, not "field 7".
  const taskName = (t) => t.label?.trim()
    || ({ sign: 'Signature', check: 'Checkbox', text: 'Text field',
          dropdown: 'Selection', radio: 'Selection', upload: 'File upload' }[t.type] || 'Field');

  const tasks = useMemo(() => {
    const out = [];
    // The placer marks each field required or optional; that flag is carried
    // on the envelope and is what decides whether Finish may proceed. It used
    // to be ignored entirely - every text field was treated as optional, so a
    // mandatory one could be left blank and the document signed anyway. Older
    // envelopes have no flag, and default to required, which is how the placer
    // creates them.
    const push = (f, page) => {
      if (!ACTIONABLE.includes(f.type)) return;
      out.push({ id: f.id, type: f.type, label: f.label || '',
                 required: f.required !== false, page });
    };
    if (isTemplate) {
      (payload.body || []).forEach((para, pi) => {
        for (const m of String(para).matchAll(FIELD_RE)) {
          const [, type, , label = ''] = m;
          const role = m[2];
          if (role !== myRole) continue;
          // The [[token]] syntax has no way to mark a field optional, so an
          // authored signature or checkbox is required and authored text is
          // not - unchanged behavior, now stated rather than implied.
          if (type === 'sign') out.push({ id: `sig-${pi}-${m.index}`, type: 'sign', required: true });
          else if (type === 'check') out.push({ id: `check:${label}`, type: 'check', label, required: true });
          else if (type === 'text') out.push({ id: `text:${label}`, type: 'text', label, required: false });
        }
      });
    } else {
      (payload.fields || []).filter(f => f.role === myRole).forEach(f => push(f, f.page));
    }
    // Packet documents (template attachments) carry their own fields
    (payload.documents || []).forEach((d, di) => {
      (d.fields || []).filter(f => f.role === myRole)
        .forEach(f => push(f, f.page, di));
    });
    return out;
  }, [payload, myRole, isTemplate]);

  const isDone = (t) => t.type === 'sign' ? !!sig
    : t.type === 'check' ? !!values[t.id]
      : t.type === 'upload' ? !!uploads[t.id]
        : String(values[t.id] || '').trim() !== '';
  const required = tasks.filter(t => t.required);
  const outstanding = required.filter(t => !isDone(t));
  const doneCount = required.length - outstanding.length;
  const allDone = outstanding.length === 0;
  const canFinish = payload.myTurn && consent && allDone;
  const nextTask = outstanding[0];

  const jumpTo = (task) => {
    const el = task && fieldRefs.current[task.id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 380 });
      el.focus?.({ preventScroll: true });
    }
  };
  const jumpNext = () => jumpTo(nextTask);

  const sigPreview = (h = 40) => sig?.kind === 'drawn'
    ? <img src={sig.data} alt="signature" style={{ maxHeight: h, maxWidth: '100%', display: 'block' }} />
    : <span style={{ fontFamily: '"Segoe Script","Brush Script MT",cursive', fontSize: h * 0.55 }}>{sig?.data}</span>;

  const signHereTab = (key) => (
    <button ref={el => { fieldRefs.current[key] = el; }} onClick={() => payload.myTurn && setPadOpen(true)} disabled={!payload.myTurn}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 22px', borderRadius: 8,
        background: '#fbbf24', color: '#78350f', border: 'none', fontWeight: 800, fontSize: 13.5,
        cursor: payload.myTurn ? 'pointer' : 'default', fontFamily: 'Inter,sans-serif',
        boxShadow: '0 2px 6px rgba(245,158,11,0.45)', position: 'relative' }}>
      <span style={{ position: 'absolute', left: -7, top: '50%', transform: 'translateY(-50%)', width: 0, height: 0, borderTop: '7px solid transparent', borderBottom: '7px solid transparent', borderRight: '7px solid #fbbf24' }} />
      <PenTool size={14} /> Sign here
    </button>
  );

  function renderPara(para, pi) {
    const parts = [];
    let last = 0, m;
    const re = new RegExp(FIELD_RE.source, 'g');
    while ((m = re.exec(para)) !== null) {
      if (m.index > last) parts.push(<span key={`${pi}-t${last}`}>{para.slice(last, m.index)}</span>);
      const [, type, role, label = ''] = m;
      const mine = role === myRole;
      const key = `${pi}-${m.index}`;
      if (type === 'sign') {
        parts.push(
          <span key={key} style={{ display: 'block', margin: '12px 0' }}>
            {mine ? (
              sig ? (
                <button onClick={() => setPadOpen(true)} title="Change signature"
                  style={{ display: 'inline-block', minWidth: 200, background: 'rgba(16,185,129,0.06)', border: '1.5px solid #10b981', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', textAlign: 'left' }}>
                  {sigPreview(44)}
                  <span style={{ display: 'block', borderTop: '1px solid #111827', marginTop: 5, paddingTop: 3, fontSize: 10, color: 'var(--muted)', fontFamily: 'Inter,sans-serif' }}>{payload.myName}</span>
                </button>
              ) : signHereTab(`sig-${pi}-${m.index}`)
            ) : (
              <span style={{ display: 'inline-block', padding: '9px 18px', borderRadius: 8, border: '1.5px dashed var(--line)', color: 'var(--muted)', fontSize: 12, background: 'var(--mist)' }}>
                <Clock size={11} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                {(payload.parties || []).find(p => p.roleKey === role)?.name || role} signs here
              </span>
            )}
          </span>);
      } else if (type === 'date') {
        parts.push(<span key={key} style={{ color: 'var(--muted)', fontSize: 12.5, fontStyle: 'italic', borderBottom: '1px dotted var(--line)' }}>{mine && sig ? new Date().toISOString().slice(0, 10) : 'date signed'}</span>);
      } else if (type === 'initials') {
        parts.push(<span key={key} style={{ fontFamily: '"Segoe Script",cursive', fontWeight: 700, padding: '0 4px', borderBottom: '1px solid var(--line)' }}>{mine ? initialsOf(payload.myName) : '··'}</span>);
      } else if (type === 'check') {
        const k = `check:${label}`;
        parts.push(
          <label key={key} ref={el => { fieldRefs.current[k] = el; }}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '10px 0', cursor: mine && payload.myTurn ? 'pointer' : 'default', fontSize: 14,
              padding: '8px 12px', borderRadius: 8, background: mine ? (values[k] ? 'rgba(16,185,129,0.07)' : 'rgba(251,191,36,0.12)') : 'transparent',
              border: mine ? `1.5px solid ${values[k] ? '#10b981' : '#fbbf24'}` : '1px solid transparent' }}>
            <input type="checkbox" disabled={!mine || !payload.myTurn} checked={!!values[k]}
              onChange={e => setVal(k, e.target.checked)} style={{ width: 17, height: 17, marginTop: 2, accentColor: '#10b981' }} />
            <span>{label}{mine && !values[k] && <span style={{ color: '#b45309', fontWeight: 700, fontSize: 11, marginLeft: 8, fontFamily: 'Inter,sans-serif' }}>REQUIRED</span>}</span>
          </label>);
      } else if (type === 'text') {
        const k = `text:${label}`;
        parts.push(mine
          ? <input key={key} ref={el => { fieldRefs.current[k] = el; }} className="form-input" placeholder={label} value={values[k] || ''} disabled={!payload.myTurn}
              onChange={e => setVal(k, e.target.value)} style={{ display: 'inline-block', width: 220, margin: '2px 0', borderColor: '#fbbf24' }} />
          : <span key={key} style={{ borderBottom: '1px solid var(--line)', minWidth: 130, display: 'inline-block', color: 'var(--muted)', fontSize: 12 }}>{label}</span>);
      }
      last = m.index + m[0].length;
    }
    if (last < para.length) parts.push(<span key={`${pi}-end`}>{para.slice(last)}</span>);
    // pre-wrap: the template editor lets authors put line breaks inside a
    // paragraph - signers must see them too, not a collapsed single line.
    return <div key={pi} style={{ margin: '0 0 13px', fontSize: 14.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{parts}</div>;
  }

  const signingOverlay = (docFields) => (pageIdx) => (
    <>
      {(docFields || []).filter(f => f.page === pageIdx).map(f => {
        const mine = f.role === myRole;
        const st = { position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
        if (f.type === 'sign' && mine) {
          return (
            <button key={f.id} ref={el => { fieldRefs.current[f.id] = el; }} onClick={() => payload.myTurn && setPadOpen(true)}
              style={{ ...st, border: `2px solid ${sig ? '#10b981' : '#fbbf24'}`, background: sig ? 'rgba(16,185,129,0.08)' : 'rgba(251,191,36,0.28)', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', fontFamily: 'Inter,sans-serif', boxShadow: sig ? 'none' : '0 2px 8px rgba(245,158,11,0.4)' }}>
              {sig ? sigPreview(28) : <span style={{ fontSize: 11, fontWeight: 800, color: '#78350f', display: 'inline-flex', alignItems: 'center', gap: 4 }}><PenTool size={11} /> Sign</span>}
            </button>);
        }
        if (f.type === 'check' && mine) {
          return <input key={f.id} ref={el => { fieldRefs.current[f.id] = el; }} type="checkbox" checked={!!values[f.id]} disabled={!payload.myTurn}
            onChange={e => setVal(f.id, e.target.checked)} style={{ ...st, accentColor: '#10b981', cursor: 'pointer' }} />;
        }
        if (f.type === 'text' && mine) {
          return <input key={f.id} ref={el => { fieldRefs.current[f.id] = el; }} value={values[f.id] || ''} disabled={!payload.myTurn} onChange={e => setVal(f.id, e.target.value)}
            placeholder="Text" style={{ ...st, border: '1.5px dashed #fbbf24', background: 'rgba(251,191,36,0.1)', borderRadius: 4, fontSize: 11, padding: '0 4px' }} />;
        }
        if (f.type === 'dropdown' && mine) {
          return (
            <select key={f.id} ref={el => { fieldRefs.current[f.id] = el; }} value={values[f.id] || ''} disabled={!payload.myTurn}
              onChange={e => setVal(f.id, e.target.value)}
              style={{ ...st, border: `1.5px solid ${values[f.id] ? '#10b981' : '#fbbf24'}`, borderRadius: 4, fontSize: 11,
                fontFamily: 'Inter,sans-serif', background: values[f.id] ? 'rgba(16,185,129,0.07)' : 'rgba(251,191,36,0.12)', cursor: 'pointer' }}>
              <option value="">- select -</option>
              {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
            </select>);
        }
        if (f.type === 'radio' && mine) {
          return (
            <div key={f.id} ref={el => { fieldRefs.current[f.id] = el; }}
              style={{ ...st, display: 'flex', flexDirection: 'column', justifyContent: 'space-around',
                border: `1.5px solid ${values[f.id] ? '#10b981' : '#fbbf24'}`, borderRadius: 4, padding: '1px 4px', overflow: 'hidden',
                background: values[f.id] ? 'rgba(16,185,129,0.05)' : 'rgba(251,191,36,0.1)', fontFamily: 'Inter,sans-serif' }}>
              {(f.options || []).map(o => (
                <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', cursor: payload.myTurn ? 'pointer' : 'default' }}>
                  <input type="radio" name={f.id} checked={values[f.id] === o} disabled={!payload.myTurn}
                    onChange={() => setVal(f.id, o)} style={{ width: 11, height: 11, accentColor: '#10b981', flexShrink: 0 }} />
                  {o}
                </label>
              ))}
            </div>);
        }
        if (f.type === 'upload' && mine) {
          return <UploadField key={f.id} field={f} style={st}
            innerRef={el => { fieldRefs.current[f.id] = el; }}
            record={uploads[f.id]} busy={uploading === f.id} disabled={!payload.myTurn}
            error={uploadErr?.fieldId === f.id ? uploadErr.message : ''}
            accept={UPLOAD_ACCEPT} hint={limit.hint}
            onFile={file => takeFile(f.id, file)} />;
        }
        if (f.type === 'name') {
          const nm = mine ? payload.myName : ((payload.parties || []).find(p => p.roleKey === f.role)?.name || '');
          return <span key={f.id} style={{ ...st, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--muted)', border: '1px dotted #d1d5db', borderRadius: 4, paddingLeft: 4, background: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden' }}>{nm}</span>;
        }
        if (f.type === 'date' && mine) {
          return <span key={f.id} style={{ ...st, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--muted)', border: '1px dotted #d1d5db', borderRadius: 4, paddingLeft: 4, background: 'rgba(255,255,255,0.6)' }}>{sig ? formatDate(new Date()) : 'date signed'}</span>;
        }
        if (f.type === 'initials' && mine) {
          return <span key={f.id} style={{ ...st, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '"Segoe Script",cursive', fontSize: 12, border: '1px dotted #d1d5db', borderRadius: 4, background: 'rgba(255,255,255,0.6)' }}>{initialsOf(payload.myName)}</span>;
        }
        return <span key={f.id} style={{ ...st, border: '1px dashed #d1d5db', borderRadius: 4, background: 'rgba(0,0,0,0.03)' }} title={`${f.type} - ${(payload.parties || []).find(p => p.roleKey === f.role)?.name || 'other signer'}`} />;
      })}
    </>
  );

  // -- Paper flow -----------------------------------------------------------
  // Neil, Sep 16: the paper option must carry the signer the whole way -
  // "how would you like to return it? ... first download this and then scan
  // it in" - instead of dropping them back in their inbox. Three steps:
  // choose how to return it, download and print, upload the scan. Fax was
  // explicitly ruled out, so upload is the only return method offered.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [paperStep, setPaperStep] = useState(0);   // 0 = closed, 1..3
  const [paperFile, setPaperFile] = useState(null);
  const [paperBusy, setPaperBusy] = useState(false);
  const [paperErr, setPaperErr] = useState('');

  const submitPaper = async () => {
    if (!paperFile || !paperApi) return;
    setPaperBusy(true); setPaperErr('');
    try {
      await paperApi(paperFile);
      setPaperStep(0);
    } catch (e) { setPaperErr(e.message || 'That file could not be uploaded.'); }
    setPaperBusy(false);
  };

  const paperModal = (
    <div style={{ ...overlayStyle, zIndex: 1400 }} onClick={e => e.target === e.currentTarget && setPaperStep(0)}>
      <div style={cardStyle(560)}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Printer size={17} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1 }}>Sign on Paper</h3>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Step {paperStep} of 3</span>
        </div>

        {paperStep === 1 && (
          <>
            <div style={{ padding: '18px 24px' }}>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '0 0 16px' }}>
                How would you like to return the signed document?
              </p>
              <label style={{ display: 'flex', gap: 11, alignItems: 'flex-start', border: '1.5px solid var(--pine)',
                background: 'rgba(22,101,52,0.06)', borderRadius: 10, padding: '13px 15px', cursor: 'pointer' }}>
                <input type="radio" name="paper-return" defaultChecked
                  style={{ width: 15, height: 15, marginTop: 2, accentColor: 'var(--pine)' }} />
                <span>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>Upload a scan</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>
                    Print it, sign it, then scan or photograph it and upload it here. Your signed
                    copy goes straight onto this request.
                  </span>
                </span>
              </label>
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setPaperStep(0)}>Cancel</button>
              <button className="primary-btn" onClick={() => setPaperStep(2)}>Continue</button>
            </div>
          </>
        )}

        {paperStep === 2 && (
          <>
            <div style={{ padding: '18px 24px' }}>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '0 0 14px' }}>
                Download the document, print it, and sign it by hand. Come back to this page when
                you have a scan ready - this link stays valid.
              </p>
              {payload.copyUrl && (
                <a className="primary-btn" href={payload.copyUrl} target="_blank" rel="noreferrer" download
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5 }}>
                  <Download size={14} /> Download the Document
                </a>
              )}
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setPaperStep(1)}>Back</button>
              <button className="primary-btn" onClick={() => setPaperStep(3)}>I Have Signed It</button>
            </div>
          </>
        )}

        {paperStep === 3 && (
          <>
            <div style={{ padding: '18px 24px' }}>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '0 0 14px' }}>
                Upload your signed copy. Make sure every signed page is included and readable.
              </p>
              <label style={{ display: 'block', border: `1.5px dashed ${paperFile ? '#10b981' : 'var(--line)'}`,
                borderRadius: 10, padding: '20px 16px', textAlign: 'center', cursor: 'pointer',
                background: paperFile ? 'rgba(16,185,129,0.06)' : 'var(--mist)' }}>
                <input type="file" accept={UPLOAD_ACCEPT} style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setPaperFile(f); setPaperErr(''); } }} />
                {paperFile
                  ? <span style={{ fontSize: 13, fontWeight: 700, color: '#065f46', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <Check size={14} /> {paperFile.name}
                    </span>
                  : <span style={{ fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <UploadCloud size={15} /> Choose your scanned copy
                    </span>}
              </label>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.55 }}>
                {payload.uploadLimit?.hint || 'PDF or an image'}. Once uploaded, your signature is
                recorded on this request as a wet signature and the sender is notified.
              </p>
              {paperErr && (
                <p style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', margin: '10px 0 0', fontWeight: 600 }}>{paperErr}</p>
              )}
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setPaperStep(2)}>Back</button>
              <button className="primary-btn" disabled={!paperFile || paperBusy} onClick={submitPaper}
                style={{ opacity: paperFile && !paperBusy ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                {paperBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />}
                Submit Signed Copy
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // Hoisted out of the return so the consent/OTP gates can render it too: a
  // signer who would rather use paper says so on the FIRST screen, long before
  // the document exists to decline from.
  const declineModal = (
    <div style={{ ...overlayStyle, zIndex: 1400 }} onClick={e => e.target === e.currentTarget && declineGuard.requestClose()}>
      <div style={cardStyle(560)}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Sign on Paper Instead</h3>
        </div>
        <div style={{ padding: '18px 24px' }}>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: '0 0 14px', color: 'var(--muted)' }}>
            Tell the sender you would rather sign on paper and they will arrange it - download a
            copy above, print and sign it, then return the scan to them directly. Nothing is
            signed electronically.
          </p>
          <label style={FL}>Reason (shared with the sender)</label>
          <textarea className="form-input" rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
            value={declineReason} onChange={e => setDeclineReason(e.target.value)} autoFocus />
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={() => setDeclineOpen(false)}>Back</button>
          <button className="primary-btn" disabled={busy} onClick={() => onDecline(declineReason)}
            style={{ background: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <XCircle size={14} /> Decline to Sign Electronically
          </button>
        </div>
      </div>
      {declineGuard.confirming && (
        <UnsavedChangesPrompt
          onKeepEditing={declineGuard.keepEditing}
          onDiscard={() => { setDeclineReason(''); setDeclineOpen(false); }}
        />
      )}
    </div>
  );

  if (needsGate) return (
    <>
      <SigningGate payload={payload} gateApi={gateApi} onCleared={onCleared}
        onDecline={() => (paperApi ? setPaperStep(1) : setDeclineOpen(true))} />
      {declineOpen && declineModal}
      {paperStep > 0 && paperModal}
      {historyOpen && historyApi && (
        <HistoryPanel loadHistory={historyApi} onClose={() => setHistoryOpen(false)} />
      )}
    </>
  );

  return (
    <div>
      {/* Sticky action bar - consent + progress + Finish, DocuSign style */}
      {payload.myTurn && (
        <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flex: 1, minWidth: 240, color: 'var(--muted)' }}>
            <ShieldCheck size={14} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
            <span>Consent recorded and identity verified. Complete the highlighted fields, then Finish.</span>
          </span>
          <ConsentDisclosures payload={payload} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* The counter is the way IN to the list of what is left. A bare
                "3/8" tells a signer they are not finished but not what is
                missing - on a six-page packet that is the difference between
                finishing and giving up (review section 7). */}
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => setListOpen(o => !o)}
                aria-expanded={listOpen}
                title={allDone ? 'All required fields complete' : `${outstanding.length} required field${outstanding.length === 1 ? '' : 's'} left`}
                style={{ background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                  fontSize: 11.5, fontWeight: 700, color: allDone ? 'hsl(var(--color-green))' : 'var(--muted)',
                  display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 90, height: 5, borderRadius: 4, background: 'var(--line)', overflow: 'hidden', display: 'inline-block' }}>
                  <span style={{ display: 'block', height: '100%', width: `${required.length ? (doneCount / required.length) * 100 : 100}%`, background: allDone ? 'hsl(var(--color-green))' : '#fbbf24', transition: 'width .3s' }} />
                </span>
                {doneCount}/{required.length}
                {allDone ? <CheckCircle size={12} /> : <ChevronDown size={12} style={{ transform: listOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />}
              </button>
              {listOpen && (
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 30, minWidth: 250, maxWidth: 320,
                  maxHeight: 280, overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--line)',
                  borderRadius: 10, boxShadow: 'var(--shadow-lg, 0 8px 28px rgba(0,0,0,0.18))', padding: '8px 0' }}>
                  <div style={{ padding: '4px 14px 8px', fontSize: 11, fontWeight: 700, letterSpacing: '.05em',
                    textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--line)', marginBottom: 4 }}>
                    {allDone ? 'Nothing left to fill' : `${outstanding.length} required field${outstanding.length === 1 ? '' : 's'} left`}
                  </div>
                  {allDone ? (
                    <div style={{ padding: '10px 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                      Every required field is complete. Select Finish to submit your signature.
                    </div>
                  ) : outstanding.map(t => (
                    <button key={t.id} type="button"
                      onClick={() => { setListOpen(false); jumpTo(t); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                        background: 'none', border: 'none', padding: '8px 14px', cursor: 'pointer',
                        fontFamily: 'Inter,sans-serif', fontSize: 12.5, color: 'var(--ink)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fbbf24', flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskName(t)}</span>
                      {Number.isInteger(t.page) && (
                        <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>p. {t.page + 1}</span>
                      )}
                      <ArrowRight size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* UETA section 8: the signer must be able to keep a copy of what
                they are being asked to sign, while they are deciding - not
                only after everyone has signed. Never gated on consent. */}
            {payload.copyUrl && (
              <a href={payload.copyUrl} target="_blank" rel="noreferrer" download
                style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Download size={12} /> Download a copy
              </a>
            )}
            {historyApi && (
              <button onClick={() => setHistoryOpen(true)} disabled={busy}
                title="Everything that has happened to this envelope"
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                History
              </button>
            )}
            {paperApi && (
              <button onClick={() => setPaperStep(1)} disabled={busy}
                title="Print it, sign it by hand, and upload the scan"
                style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                Sign on Paper
              </button>
            )}
            <button onClick={() => setDeclineOpen(true)} disabled={busy} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>Decline</button>
            <button className="primary-btn" disabled={!canFinish || busy}
              onClick={() => onSubmit({ consent, signature_kind: sig?.kind === 'drawn' ? 'drawn' : 'typed', signature_data: sig?.data || payload.myName, field_values: values, format_demonstrated: formatDemonstrated, pages_viewed: seenPages.current.size, pages_total: pagesTotal })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: canFinish && !busy ? 1 : 0.5, fontSize: 13 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Finish
            </button>
          </div>
        </div>
      )}

      {payload.status === 'pending' && (payload.myPartyRole || 'signer') === 'signer'
        && !payload.myTurn && payload.myStatus !== 'signed' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '11px 15px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)', color: 'hsl(var(--color-blue))', fontSize: 13, marginBottom: 14 }}>
          <Clock size={15} /> It isn't your turn yet - you'll be notified when it is. You can review the document below.
        </div>
      )}
      {payload.message && (
        <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', marginBottom: 14 }}>“{payload.message}”</div>
      )}
      {/* An upload field is a small box on a page; a rejected file needs to say
          why somewhere the signer will actually read it. */}
      {uploadErr && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '11px 15px', borderRadius: 10,
          background: 'hsla(var(--color-red),0.08)', color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 14 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{uploadErr.message}</span>
        </div>
      )}
      {tasks.some(t => t.type === 'upload') && payload.myTurn && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Paperclip size={12} />
          Click an attachment box to choose a file - or drop one on it, or press Ctrl+V to paste
          {payload.uploadLimit?.hint ? ` (${payload.uploadLimit.hint})` : ''}.
        </div>
      )}

      <div style={{ position: 'relative' }}>
        {/* Floating START / NEXT guide tab */}
        {payload.myTurn && nextTask && (
          <button onClick={jumpNext}
            style={{ position: 'sticky', top: 76, zIndex: 15, float: 'left', marginLeft: -14, display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fbbf24', color: '#78350f', border: 'none', fontWeight: 800, fontSize: 12, padding: '8px 14px 8px 10px', cursor: 'pointer', fontFamily: 'Inter,sans-serif', borderRadius: '0 8px 8px 0', boxShadow: '0 2px 8px rgba(245,158,11,0.5)' }}>
            {doneCount === 0 ? 'START' : 'NEXT'}
            <span style={{ fontWeight: 600, opacity: .85, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {taskName(nextTask)}
            </span>
            <ArrowRight size={13} />
          </button>
        )}
        {!isTemplate && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', marginBottom: 8,
            border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', position: 'sticky',
            top: 'calc(env(safe-area-inset-top, 0px) + 8px)', zIndex: 16 }}>
            <button className="secondary-btn" title="Zoom out" aria-label="Zoom out"
              onClick={() => setZoom(z => Math.max(0.6, +(z - 0.15).toFixed(2)))}
              style={{ padding: '5px 9px' }}><ZoomOut size={13} /></button>
            <span style={{ fontSize: 12, fontWeight: 700, minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(zoom * 100)}%
            </span>
            <button className="secondary-btn" title="Zoom in" aria-label="Zoom in"
              onClick={() => setZoom(z => Math.min(2, +(z + 0.15).toFixed(2)))}
              style={{ padding: '5px 9px' }}><ZoomIn size={13} /></button>
            {docPages > 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginLeft: 4 }}>
                {docPages} page{docPages === 1 ? '' : 's'}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {payload.copyUrl && (
              <a className="secondary-btn" href={payload.copyUrl} target="_blank" rel="noreferrer" download
                title="Download a copy of this document"
                style={{ padding: '5px 11px', fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Download size={13} /> Download
              </a>
            )}
            <button className="secondary-btn" onClick={printDoc} title="Open a printable copy"
              style={{ padding: '5px 11px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Printer size={13} /> Print
            </button>
          </div>
        )}
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: isTemplate ? '30px 38px' : '24px 12px', background: isTemplate ? '#fff' : 'var(--mist)', color: '#111827' }}>
          {isTemplate
            ? (payload.body || []).map(renderPara)
            : <PdfDoc url={payload.pdfUrl} zoom={zoom} onPageCount={setDocPages}
                renderOverlay={signingOverlay(payload.fields)} onPageSeen={notePageSeen} />}
        </div>
        {/* Packet documents - attached PDFs signed in the same session */}
        {(payload.documents || []).map((d, di) => (
          <div key={di} style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FileText size={13} /> {d.name || `Document ${di + 2}`}
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '24px 12px', background: 'var(--mist)' }}>
              <PdfDoc url={d.pdfUrl} zoom={zoom} renderOverlay={signingOverlay(d.fields)} onPageSeen={notePageSeen} />
            </div>
          </div>
        ))}
      </div>

      {/* Who's-signed progress strip */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        {(payload.parties || []).map((p, i) => {
          const m = PARTY_STATUS[p.status] || PARTY_STATUS.waiting;
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '5px 12px', borderRadius: 16, border: '1px solid var(--line)', color: m.fg, background: 'var(--card)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: rcolor(i).solid, flexShrink: 0 }} />
              {p.status === 'signed' ? <CheckCircle size={12} /> : <Clock size={12} />}
              {p.name} · {m.label}
            </span>);
        })}
      </div>

      {padOpen && <SignaturePad name={payload.myName} onClose={() => setPadOpen(false)}
        onAdopt={(s) => { setSig(s); setPadOpen(false); }} />}

      {declineOpen && declineModal}
      {paperStep > 0 && paperModal}
      {historyOpen && historyApi && (
        <HistoryPanel loadHistory={historyApi} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}

// ── Internal signing - in-shell panel replacing the E-Sign tab content ────────
function SignModal({ partyId, onClose, onDone, toastOk, toastErr }) {
  const [payload, setPayload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [boxRef, boxH] = useFillHeight();
  const load = useCallback(
    () => api.mySignRender(partyId).then(setPayload),
    [partyId]);
  useEffect(() => {
    load().catch(e => { toastErr(e?.message || 'Could not load the document.'); onClose(); });
  }, [partyId]);

  // An internal signer clears the same two gates an external one does. An
  // Entra session says who someone is; it does not say they consented to
  // electronic records, and the review asked for a code on EVERY signature.
  const gateApi = {
    consent:    ()        => api.mySignConsent(partyId, { agreed: true }),
    otpRequest: (channel) => api.mySignOtpRequest(partyId, { channel }),
    otpVerify:  (code)    => api.mySignOtpVerify(partyId, { code }),
  };

  async function submit(data) {
    setBusy(true);
    try {
      const r = await api.mySignSubmit(partyId, data);
      toastOk(r.status === 'completed' ? 'Signed - all parties done, document sealed.' : `Signed. Next: ${r.next}.`);
      onDone();
    } catch (e) { toastErr(e?.message || 'Could not sign.'); setBusy(false); }
  }
  async function decline(reason) {
    setBusy(true);
    try { await api.mySignDecline(partyId, { reason }); toastOk('Declined.'); onDone(); }
    catch (e) { toastErr(e?.message || 'Could not decline.'); setBusy(false); }
  }
  const uploadApi = (fieldId, file) => {
    const fd = new FormData();
    fd.append('field_id', fieldId);
    fd.append('file', file);
    return api.mySignUpload(partyId, fd);
  };
  const historyApi = useCallback(() => api.mySignHistory(partyId), [partyId]);

  return (
    <div ref={boxRef} style={fillPanelStyle(boxH)}>
      <div style={{ padding: '12px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', flexShrink: 0 }}>
        <button className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}><ChevronLeft size={14} /> Back</button>
        <FileSignature size={18} style={{ color: 'var(--pine)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{payload?.title || 'Loading…'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Review &amp; sign</div>
        </div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '20px clamp(12px, 6vw, 60px)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          {!payload
            ? <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /></div>
            : <SigningDoc payload={payload} busy={busy} onSubmit={submit} onDecline={decline}
                gateApi={gateApi} onCleared={() => load().catch(() => {})} uploadApi={uploadApi}
                historyApi={historyApi} />}
        </div>
      </div>
    </div>
  );
}

// ── Template editor - human block editor, no raw tokens to type ───────────────
// The body is edited as BLOCKS (paragraphs + visual field rows) and serialized
// back to the same paragraph/token format the backend already understands.
// Templates can also carry ATTACHED PDFs (handbook, policies…) with fields
// placed once here - every send bundles them into one signed packet.

const FRIENDLY_MERGE = {
  first_name: 'First name', last_name: 'Last name', full_name: 'Full name',
  email: 'Email', job_title: 'Job title', department: 'Department',
  start_date: 'Start date', salary: 'Salary', company: 'Company',
  company_legal: 'Company legal name', company_address: 'Company address',
  signatory: 'Company signatory', manager: 'Manager', today: "Today's date",
};
const BLOCK_ONLY_RE = /^\[\[(sign|initials|date|text|check):([a-z0-9_]+)(?::([^\]]*))?\]\]$/;

const parseBlocks = (body) => (body || []).map(para => {
  const m = String(para).trim().match(BLOCK_ONLY_RE);
  return m ? { type: m[1], role: m[2], label: m[3] || '' } : { type: 'para', text: String(para) };
});
const blocksToBody = (blocks) => blocks
  .map(b => b.type === 'para' ? b.text
    : `[[${b.type}:${b.role}${(b.type === 'check' || b.type === 'text') ? `:${b.label || ''}` : ''}]]`)
  .filter(s => String(s).trim());

// Paragraphs edit in place on the paper as contentEditable text; {{merge}}
// tokens display as friendly non-editable chips ("Full name") and serialize
// back to the exact same token format the backend understands.
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chipEl = (k) => {
  const span = document.createElement('span');
  span.className = 'tpl-chip'; span.contentEditable = 'false'; span.dataset.k = k;
  span.textContent = FRIENDLY_MERGE[k] || k;
  return span;
};
const paraToHtml = (text) => String(text || '').split('\n').map(line =>
  line.split(/(\{\{\w+\}\})/).map(part => {
    const m = part.match(/^\{\{(\w+)\}\}$/);
    return m ? chipEl(m[1]).outerHTML : escHtml(part);
  }).join('')
).join('<br>');
function paraFromDom(root) {
  let out = '';
  const walk = (n) => {
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3) { out += ch.textContent; continue; }
      if (ch.nodeType !== 1) continue;
      if (ch.tagName === 'BR') { out += '\n'; continue; }
      if (ch.dataset?.k) { out += `{{${ch.dataset.k}}}`; continue; }
      if (/^(DIV|P)$/.test(ch.tagName) && out && !out.endsWith('\n')) out += '\n';
      walk(ch);
    }
  };
  walk(root);
  return out;
}
function MergePara({ text, onChange, onFocus, innerRef }) {
  const ref = useRef(null);
  // Push external changes (mount, block reorder) into the DOM. Layout effect +
  // focus guard: a passive effect can flush DURING the next keystroke and see
  // DOM that is newer than the prop, and rewriting then would eat the keystroke
  // and collapse the caret. While the user is typing here, the DOM is truth.
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    if (document.activeElement === el) return;
    if (paraFromDom(el) !== String(text || '')) el.innerHTML = paraToHtml(text);
  }, [text]);
  return (
    <div ref={el => { ref.current = el; innerRef?.(el); }}
      className="tpl-para tpl-rich" contentEditable suppressContentEditableWarning
      data-ph="Write a paragraph…" onFocus={onFocus}
      onInput={() => onChange(paraFromDom(ref.current))}
      onPaste={e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); } }} />
  );
}

// Place fields on an attached PDF - same interaction as the send wizard's
// editor, but saved onto the template so every send reuses the placement.
function AttachmentPlacer({ attachment, roles, onSave, onClose, toastErr }) {
  const [url, setUrl] = useState('');
  const [fields, setFields] = useState(attachment.fields || []);
  const [activeRole, setActiveRole] = useState(0);
  const [activeType, setActiveType] = useState('sign');
  const [optsFor, setOptsFor] = useState(null);   // field id whose options are being edited
  const [labelFor, setLabelFor] = useState(null); // upload field whose label is being edited
  const dragState = useRef(null);

  useEffect(() => {
    api.getSignAttachmentUrl(attachment.path).then(r => setUrl(r.url))
      .catch(e => { toastErr(e?.message || 'Could not load the PDF.'); onClose(); });
  }, [attachment.path]);

  const roleKey = (i) => roles[i]?.key || roles[0]?.key || 'employee';
  function place(page, x, y, type = activeType) {
    const meta = FIELD_META[type] || FIELD_META.sign;
    const id = `a${Date.now()}`;
    setFields(fs => [...fs, { id, role: roleKey(activeRole), type, page,
      x: Math.min(0.98 - meta.w, Math.max(0, x - meta.w / 2)),
      y: Math.min(0.98 - meta.h, Math.max(0, y - meta.h / 2)), w: meta.w, h: meta.h, required: true,
      ...(meta.opts ? { options: ['Option 1', 'Option 2'] } : {}) }]);
    if (meta.opts) setOptsFor(id); // choices matter more than position - edit them right away
  }
  const onDrag = useCallback((e) => {
    const s = dragState.current; if (!s) return;
    const dx = (e.clientX - s.startX) / s.rect.width, dy = (e.clientY - s.startY) / s.rect.height;
    setFields(fs => fs.map(f => f.id !== s.fieldId ? f
      : s.mode === 'move'
        ? { ...f, x: Math.min(0.99 - f.w, Math.max(0, s.orig.x + dx)), y: Math.min(0.99 - f.h, Math.max(0, s.orig.y + dy)) }
        : { ...f, w: Math.min(0.9, Math.max(0.02, s.orig.w + dx)), h: Math.min(0.4, Math.max(0.012, s.orig.h + dy)) }));
  }, []);
  const endDrag = useCallback(() => { dragState.current = null; window.removeEventListener('pointermove', onDrag); }, [onDrag]);
  const startDrag = (e, f, mode) => {
    e.stopPropagation(); e.preventDefault();
    const pageEl = e.currentTarget.closest('[data-atpage]'); if (!pageEl) return;
    dragState.current = { fieldId: f.id, mode, rect: pageEl.getBoundingClientRect(), startX: e.clientX, startY: e.clientY, orig: { ...f } };
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag, { once: true });
  };
  const roleIdx = (key) => Math.max(0, roles.findIndex(r => r.key === key));
  const overlay = (pageIdx) => (
    <div data-atpage style={{ position: 'absolute', inset: 0 }}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); place(pageIdx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }}
      onDragOver={e => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const t = e.dataTransfer.getData('field'); if (t) { const r = e.currentTarget.getBoundingClientRect(); place(pageIdx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, t); } }}>
      {fields.filter(f => f.page === pageIdx).map(f => {
        const c = rcolor(roleIdx(f.role));
        const M = FIELD_META[f.type];
        return (
          <div key={f.id} onPointerDown={(e) => startDrag(e, f, 'move')} onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`,
              border: `2px solid ${c.solid}`, background: c.soft, borderRadius: 5, cursor: 'grab', touchAction: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter,sans-serif' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: c.solid, display: 'inline-flex', alignItems: 'center', gap: 4, pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <M.Icon size={10} /> {(M.labeled && f.label) || M.label}
            </span>
            {(M.opts || M.labeled) && (
              <button onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); (M.labeled ? setLabelFor : setOptsFor)(f.id); }}
                title={M.labeled ? (f.label ? `"${f.label}" - click to edit` : 'Name this attachment')
                  : `Edit choices (${(f.options || []).length})`}
                style={{ position: 'absolute', top: -9, right: 12, width: 18, height: 18, borderRadius: '50%', background: '#fff', color: c.solid, border: `2px solid ${c.solid}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                <Pencil size={9} />
              </button>
            )}
            <button onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setFields(fs => fs.filter(x => x.id !== f.id)); }}
              style={{ position: 'absolute', top: -9, right: -9, width: 18, height: 18, borderRadius: '50%', background: c.solid, color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
              <X size={11} />
            </button>
            <span onPointerDown={(e) => startDrag(e, f, 'resize')}
              style={{ position: 'absolute', bottom: -6, right: -6, width: 12, height: 12, borderRadius: 3, background: '#fff', border: `2px solid ${c.solid}`, cursor: 'nwse-resize', touchAction: 'none' }} />
          </div>
        );
      })}
    </div>
  );

  return (
    <div style={{ ...overlayStyle, zIndex: 1350 }}>
      <div style={{ background: 'var(--bg, #f3f4f6)', borderRadius: 16, width: '100%', maxWidth: 1400, height: 'min(94dvh, 940px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', flexShrink: 0 }}>
        <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Signing template · place the fields once, every send reuses them</div>
        </div>
        <button className="secondary-btn" onClick={onClose} style={{ fontSize: 12.5 }}>Cancel</button>
        <button className="primary-btn" onClick={() => { onSave(fields); onClose(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <CheckCircle size={13} /> Save fields
        </button>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: 180, borderRight: '1px solid var(--line)', background: 'var(--card)', padding: '14px 12px', flexShrink: 0, overflowY: 'auto' }}>
          <label style={FL}>Included documents</label>
          <div style={{ border: '1.5px solid var(--pine)', borderRadius: 10, padding: '14px 10px', textAlign: 'center', background: 'var(--mist)' }}>
            <FileText size={26} style={{ color: 'var(--pine)' }} />
            <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 6, wordBreak: 'break-word' }}>{attachment.name}</div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>{attachment.pages || '–'} page{attachment.pages === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '26px 20px', minWidth: 0 }}>
          {url ? <PdfDoc url={url} renderOverlay={overlay} />
               : <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>}
        </div>
        <FieldsPanel recipients={roles.map((r, i) => ({ label: r.label || r.key, sub: `Signs ${_ord(i + 1)}`, color: rcolor(i) }))}
          activeIdx={activeRole} onPick={setActiveRole}
          activeType={activeType} setActiveType={setActiveType} placed={fields.length} />
      </div>
      </div>
      {labelFor && fields.find(f => f.id === labelFor) && (
        <FieldLabelModal field={fields.find(f => f.id === labelFor)} onClose={() => setLabelFor(null)}
          onSave={(patch) => setFields(fs => fs.map(f => f.id === labelFor ? { ...f, ...patch } : f))} />
      )}
      {optsFor && fields.find(f => f.id === optsFor) && (
        <FieldOptionsModal field={fields.find(f => f.id === optsFor)} onClose={() => setOptsFor(null)}
          onSave={(options) => setFields(fs => fs.map(f => f.id === optsFor ? { ...f, options } : f))} />
      )}
    </div>
  );
}

function TemplateEditorModal({ template, entities, onClose, onSaved, toastOk, toastErr }) {
  const t0 = template || {};
  const [name, setName] = useState(t0.name || '');
  const [kind, setKind] = useState(t0.kind || 'custom');
  const [entityId, setEntityId] = useState(t0.entityId || '');
  const [roles, setRoles] = useState(t0.roles?.length ? t0.roles : [{ key: 'employee', label: 'Employee', order: 1 }]);
  const [blocks, setBlocks] = useState(() => {
    const b = parseBlocks(t0.body);
    return b.length ? b : [{ type: 'para', text: '' }];
  });
  const [attachments, setAttachments] = useState(t0.attachments || []);
  const [placerIdx, setPlacerIdx] = useState(null);
  const [editPdf, setEditPdf] = useState(null);   // { idx, url } - attachment open in the PDF editor
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusPara, setFocusPara] = useState(null); // paragraph whose Insert dropdown is showing
  const [egnyteFolder, setEgnyteFolder] = useState(t0.egnyteFolder || '');
  const paraRefs = useRef({});
  const rolesInitial = t0.roles?.length ? t0.roles : [{ key: 'employee', label: 'Employee', order: 1 }];
  const blocksInitial = (() => { const b = parseBlocks(t0.body); return b.length ? b : [{ type: 'para', text: '' }]; })();
  const dirty = name !== (t0.name || '') || kind !== (t0.kind || 'custom') || entityId !== (t0.entityId || '')
    || JSON.stringify(roles) !== JSON.stringify(rolesInitial)
    || JSON.stringify(blocks) !== JSON.stringify(blocksInitial)
    || JSON.stringify(attachments) !== JSON.stringify(t0.attachments || [])
    || egnyteFolder !== (t0.egnyteFolder || '');

  const setBlock = (i, patch) => setBlocks(bs => bs.map((b, j) => j === i ? { ...b, ...patch } : b));
  // focusPara is an INDEX - remap it on reorder/removal, or the Insert dropdown
  // reattaches to whichever block slides into the old index and merge tokens
  // land in the wrong paragraph.
  const rmBlock = (i) => {
    if (blocks.length <= 1) return;
    setBlocks(bs => bs.filter((_, j) => j !== i));
    setFocusPara(fp => fp === null ? null : fp === i ? null : fp > i ? fp - 1 : fp);
  };
  const movBlock = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    setBlocks(bs => { const next = [...bs]; [next[i], next[j]] = [next[j], next[i]]; return next; });
    setFocusPara(fp => fp === i ? j : fp === j ? i : fp);
  };
  const addBlock = (type) => setBlocks(bs => [...bs,
    type === 'para' ? { type: 'para', text: '' }
      : { type, role: roles[0]?.key || 'employee', label: type === 'check' ? 'I agree' : type === 'text' ? 'Label' : '' }]);
  // Drop a merge CHIP at the caret of the paragraph's contentEditable (falls
  // back to the end when the caret is elsewhere), then re-serialize to tokens.
  const insertMerge = (i, token) => {
    const el = paraRefs.current[i]; if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range = sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : null;
    if (!range) { range = document.createRange(); range.selectNodeContents(el); range.collapse(false); }
    const chip = chipEl(token);
    range.deleteContents(); range.insertNode(chip);
    range.setStartAfter(chip); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    setBlock(i, { text: paraFromDom(el) });
  };
  const setRole = (i, k, v) => setRoles(rs => rs.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const roleIdx = (key) => Math.max(0, roles.findIndex(r => r.key === key));

  async function uploadAttachment(fl) {
    if (!fl) return;
    setUploading(true);
    try {
      // Same rule as the send wizard: a template attachment is signed too, so
      // it is converted by a real Word engine on the server or not at all.
      if (isDocx(fl)) fl = await api.convertDocxToPdf(fl);
      const form = new FormData();
      form.append('file', fl);
      const a = await api.uploadSignAttachment(form);
      setAttachments(as => [...as, a]);
      toastOk(`Attached ${a.name} (${a.pages} page${a.pages === 1 ? '' : 's'}). Now place its signature fields.`);
    } catch (e) { toastErr(e?.message || 'Upload failed.'); }
    setUploading(false);
  }

  async function openPdfEditor(i) {
    try {
      const r = await api.getSignAttachmentUrl(attachments[i].path);
      setEditPdf({ idx: i, url: r.url });
    } catch (e) { toastErr(e?.message || 'Could not load the PDF.'); }
  }
  // The editor hands back a brand-new PDF: re-upload it and swap the attachment.
  // Fields survive only if the page count didn't shrink (geometry may differ -
  // the placer is one click away); page indexes are clamped defensively.
  async function savePdfEdit(edited) {
    const form = new FormData();
    form.append('file', edited);
    const a = await api.uploadSignAttachment(form);
    setAttachments(as => as.map((old, j) => {
      if (j !== editPdf.idx) return old;
      const fields = (a.pages >= (old.pages || 0))
        ? (old.fields || []).map(f => ({ ...f, page: Math.min(f.page || 0, a.pages - 1) }))
        : [];
      return { ...a, fields };
    }));
    const shrunk = a.pages < (attachments[editPdf.idx]?.pages || 0);
    toastOk(shrunk ? 'PDF updated - pages changed, place its fields again.' : 'PDF updated.');
  }

  async function save() {
    if (busy) return; setBusy(true);
    const data = { name, kind, entity_id: entityId, roles: roles.filter(r => r.key.trim()),
      body: blocksToBody(blocks), attachments, egnyte_folder: egnyteFolder.trim() };
    try {
      const saved = template?.id ? await api.updateSignTemplate(template.id, data) : await api.createSignTemplate(data);
      toastOk('Template saved.'); onSaved(saved); onClose();
    } catch (e) { toastErr(e?.message || 'Could not save template.'); setBusy(false); }
  }
  const guard = useUnsavedGuard(dirty, onClose, name.trim() ? save : undefined);

  const fieldBlockMeta = { sign: ['Signature', PenTool], date: ['Date signed', CalendarDays],
    initials: ['Initials', Type], check: ['Checkbox', CheckSquare], text: ['Text field', ALargeSmall] };

  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={cardStyle(1100, 'min(94dvh, 1020px)')}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileText size={17} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{template?.id ? 'Edit Template' : 'New Template'}</h3>
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <div><label style={FL}>Name *</label><input className="form-input" style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
            <div><label style={FL}>Kind</label>
              <select className="form-input" style={{ width: '100%' }} value={kind} onChange={e => setKind(e.target.value)}>
                {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><label style={FL}>Company</label>
              <select className="form-input" style={{ width: '100%' }} value={entityId} onChange={e => setEntityId(e.target.value)}>
                <option value="">Any</option>
                {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select></div>
          </div>

          <div style={{ margin: '16px 0 6px' }}><label style={FL}>Who signs (in order)</label></div>
          {roles.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: rcolor(i).solid, flexShrink: 0 }} />
              <input className="form-input" style={{ flex: 1 }} value={r.label} placeholder="e.g. Employee, Hiring manager…"
                onChange={e => {
                  const label = e.target.value;
                  let key = r.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `signer${i + 1}`;
                  // Keep it unique - two roles labelled the same must not share a
                  // key (duplicate keys mis-stamp signatures in the sealed PDF).
                  const used = new Set(roles.filter((_, j) => j !== i).map(x => x.key));
                  if (!r.key) { let base = key, n = 2; while (used.has(key)) key = `${base}_${n++}`; }
                  setRole(i, 'label', label); if (!r.key) setRole(i, 'key', key);
                }} />
              <button onClick={() => setRoles(rs => rs.filter((_, j) => j !== i).map((x, j) => ({ ...x, order: j + 1 })))}
                disabled={roles.length === 1}
                style={{ background: 'none', border: 'none', color: roles.length === 1 ? 'var(--line)' : 'hsl(var(--color-red))', cursor: roles.length === 1 ? 'default' : 'pointer', display: 'flex', padding: 4 }}><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="secondary-btn" onClick={() => setRoles(rs => {
            // Unique key - `signer{length+1}` collides after a delete (delete
            // signer1 from [signer1,signer2] → length 1 → 'signer2' dup), and a
            // duplicate role key stamps one signer's signature into another's slot.
            const used = new Set(rs.map(x => x.key));
            let n = rs.length + 1;
            while (used.has(`signer${n}`)) n++;
            return [...rs, { key: `signer${n}`, label: '', order: rs.length + 1 }];
          })}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Signer Role</button>

          <div style={{ margin: '18px 0 6px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <label style={{ ...FL, marginBottom: 0 }}>Document</label>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>shown exactly as signers will read it - click any text to edit</span>
          </div>
          {/* The paper matches the signing screen (same padding + typography), so
              what you compose here is literally what the signer gets. */}
          <div style={{ background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 12, padding: '20px 16px 12px' }}>
            <div style={{ background: '#fff', borderRadius: 4, boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 5px 18px rgba(0,0,0,0.07)', padding: '30px 38px', maxWidth: 620, margin: '0 auto', color: '#111827', minHeight: 140 }}>
              {blocks.map((b, i) => {
                const ctl = (dis) => ({ background: 'none', border: 'none', cursor: dis ? 'default' : 'pointer', color: dis ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 2 });
                const c = b.type !== 'para' ? rcolor(roleIdx(b.role)) : null;
                const meta = b.type !== 'para' && (() => { const [lbl, Icon] = fieldBlockMeta[b.type]; return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', fontFamily: 'Inter,sans-serif', flexShrink: 0 }}>
                    <Icon size={12} style={{ color: c.solid }} />
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: c.solid, letterSpacing: '.03em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{lbl}</span>
                    <select value={b.role} onChange={e => setBlock(i, { role: e.target.value })} title="Who fills this in"
                      style={{ border: `1.5px solid ${c.solid}`, color: c.solid, background: c.soft, borderRadius: 14, fontSize: 11, fontWeight: 800, padding: '2px 8px', fontFamily: 'Inter,sans-serif', cursor: 'pointer', outline: 'none' }}>
                      {roles.filter(r => r.key).map(r => <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
                    </select>
                  </span>); })();
                return (
                  <div key={i} className="tpl-block">
                    <div className="tpl-ctl" style={{ position: 'absolute', left: -32, top: 1, display: 'flex', flexDirection: 'column' }}>
                      <button onClick={() => movBlock(i, -1)} disabled={i === 0} style={ctl(i === 0)} title="Move up"><ChevronUp size={13} /></button>
                      <button onClick={() => movBlock(i, 1)} disabled={i === blocks.length - 1} style={ctl(i === blocks.length - 1)} title="Move down"><ChevronDown size={13} /></button>
                    </div>
                    <button className="tpl-ctl" onClick={() => rmBlock(i)} disabled={blocks.length === 1} title="Remove"
                      style={{ ...ctl(blocks.length === 1), position: 'absolute', right: -30, top: 3, color: blocks.length === 1 ? 'var(--line)' : 'hsl(var(--color-red))' }}><Trash2 size={13} /></button>
                    {b.type === 'para' ? (
                      <>
                        <MergePara text={b.text} innerRef={el => { paraRefs.current[i] = el; }}
                          onFocus={() => setFocusPara(i)} onChange={t => setBlock(i, { text: t })} />
                        {focusPara === i && (
                          <select value="" onChange={e => e.target.value && insertMerge(i, e.target.value)}
                            style={{ display: 'block', margin: '0 0 10px', fontSize: 11, padding: '2px 6px', height: 24, width: 200, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 6, background: 'transparent', fontFamily: 'Inter,sans-serif', cursor: 'pointer', outline: 'none' }}>
                            <option value="">✨ Insert auto-filled detail…</option>
                            {Object.entries(FRIENDLY_MERGE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select>
                        )}
                      </>
                    ) : b.type === 'sign' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 20px', borderRadius: 8, background: '#fbbf24', color: '#78350f', fontWeight: 800, fontSize: 13, fontFamily: 'Inter,sans-serif', boxShadow: '0 2px 6px rgba(245,158,11,0.35)', position: 'relative', marginLeft: 7 }}>
                          <span style={{ position: 'absolute', left: -7, top: '50%', transform: 'translateY(-50%)', width: 0, height: 0, borderTop: '7px solid transparent', borderBottom: '7px solid transparent', borderRight: '7px solid #fbbf24' }} />
                          <PenTool size={13} /> Sign here
                        </span>
                        {meta}
                      </div>
                    ) : b.type === 'date' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
                        <span style={{ color: 'var(--muted)', fontSize: 12.5, fontStyle: 'italic', borderBottom: '1px dotted var(--line)', padding: '0 2px' }}>date signed</span>
                        {meta}
                      </div>
                    ) : b.type === 'initials' ? (
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, margin: '8px 0' }}>
                        <span style={{ fontFamily: '"Segoe Script",cursive', fontWeight: 700, fontSize: 15, borderBottom: '1px solid #9ca3af', padding: '0 14px' }}>··</span>
                        {meta}
                      </div>
                    ) : b.type === 'check' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
                        <input type="checkbox" disabled style={{ width: 16, height: 16, accentColor: '#10b981', flexShrink: 0 }} />
                        <input className="tpl-inline" value={b.label} placeholder="Checkbox text…"
                          onChange={e => setBlock(i, { label: e.target.value })}
                          style={{ flex: 1, minWidth: 120, fontSize: 14, color: '#111827' }} />
                        {meta}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, margin: '10px 0' }}>
                        <input className="tpl-inline" value={b.label} placeholder="Field label…"
                          onChange={e => setBlock(i, { label: e.target.value })}
                          style={{ width: 220, borderBottom: '1px solid #9ca3af', fontSize: 12.5, color: 'var(--muted)' }} />
                        {meta}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, justifyContent: 'center' }}>
              <button className="secondary-btn" onClick={() => addBlock('para')} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px' }}><Plus size={11} /> Paragraph</button>
              {Object.entries(fieldBlockMeta).map(([ft, [lbl, Icon]]) => (
                <button key={ft} className="secondary-btn" onClick={() => addBlock(ft)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px' }}>
                  <Icon size={11} /> {lbl}
                </button>
              ))}
            </div>
          </div>

          <div style={{ margin: '18px 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ ...FL, marginBottom: 0, flex: 1 }}>Attached documents - signed together as one packet</label>
            <label className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              {uploading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <UploadCloud size={13} />} Attach PDF / Word
              <input type="file" accept="application/pdf,.docx" style={{ display: 'none' }}
                onChange={e => { uploadAttachment(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {attachments.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 10, padding: '12px 14px' }}>
              None yet - attach the handbook, NDA or policy PDFs and this template sends them all as one signature packet.
            </div>
          ) : attachments.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 6 }}>
              <FileText size={14} style={{ color: 'var(--pine)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                <div style={{ fontSize: 11, color: (a.fields || []).length ? 'var(--muted)' : '#b45309' }}>
                  {a.pages} page{a.pages === 1 ? '' : 's'} · {(a.fields || []).length
                    ? `${a.fields.length} field${a.fields.length === 1 ? '' : 's'} placed`
                    : 'no fields yet - signers will only view it'}
                </div>
              </div>
              <button className="secondary-btn" onClick={() => openPdfEditor(i)} title="Fix the PDF itself - text, pages, images - before placing fields"
                style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px' }}>
                <Pencil size={11} /> Edit PDF
              </button>
              <button className="secondary-btn" onClick={() => setPlacerIdx(i)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px' }}>
                <PenTool size={11} /> Place fields
              </button>
              <button onClick={() => setAttachments(as => as.filter((_, j) => j !== i))}
                style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 4 }}><Trash2 size={13} /></button>
            </div>
          ))}

          <div style={{ margin: '18px 0 6px' }}><label style={FL}>Signed document location - Egnyte (optional)</label></div>
          <input className="form-input" value={egnyteFolder} onChange={e => setEgnyteFolder(e.target.value)}
            placeholder="/Shared/Human Resources/Signed Documents" style={{ width: '100%' }} />
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '5px 0 0' }}>
            When an envelope from this template completes, a copy of the sealed PDF is filed to this Egnyte folder.
          </p>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save Template
          </button>
        </div>
      </div>
      {placerIdx !== null && attachments[placerIdx] && (
        <AttachmentPlacer attachment={attachments[placerIdx]} roles={roles.filter(r => r.key)}
          toastErr={toastErr} onClose={() => setPlacerIdx(null)}
          onSave={(fields) => setAttachments(as => as.map((a, j) => j === placerIdx ? { ...a, fields } : a))} />
      )}
      {editPdf !== null && attachments[editPdf.idx] && (
        <PdfEditor url={editPdf.url} fileName={attachments[editPdf.idx].name} toastErr={toastErr}
          onClose={() => setEditPdf(null)} onSave={savePdfEdit} />
      )}
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={name.trim() ? guard.saveAndClose : undefined} saving={guard.saving} />
      )}
    </div>
  );
}

// ── Send wizard - in-shell, DocuSign-style: Doc → Recipients → Fields → Send ──
/** The company a new envelope defaults to: the SENDER's own company from their
 *  People record, else Greens Global, else whatever is first. It used to be
 *  simply the first entity - alphabetically "Aarav Construction" - so every
 *  request went out under a sister company unless someone noticed and changed
 *  it (Sagar, Sep 19). Exported for the unit test. */
export function defaultSendEntityId(entities, employees, senderEmail) {
  const list = entities || [];
  const me = (senderEmail || '').toLowerCase();
  const mine = me && (employees || []).find((e) => (e.workEmail || '').toLowerCase() === me);
  if (mine?.company && list.some((en) => en.id === mine.company)) return mine.company;
  const greens = list.find((en) => /^greens global\b/i.test((en.name || '').trim()));
  return greens?.id || list[0]?.id || '';
}

/** Everything a template asks a human for, in the order the form shows them:
 *  its typed field definitions, then any {{token}} in its text that has no
 *  definition. A template typed by hand, pasted, or imported from Word carries
 *  tokens but no defs - those were never asked for, so the generated document
 *  went out saying "Dear {{full_name}}" (Sagar, Sep 21 2026). Signature /
 *  initials / image / file are placed on the document, never typed, and
 *  `tokens` (computed server-side, documents._template_tokens) already leaves
 *  out the self-filling ones (today, template.*).
 *
 *  Every answer is optional: a field left blank is filled from the person in
 *  About and the selected Company when the document is generated. */
export function templateAskFields(t) {
  const prettyLabel = (token) => token.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const defs = (t?.fieldDefs || []).filter(fd => !RESERVED_FIELD_TYPES.includes(fd.type));
  const declared = new Set((t?.fieldDefs || []).map(fd => fd.token));
  const loose = (t?.tokens || []).filter(tk => !declared.has(tk))
    .map(tk => ({ token: tk, label: prettyLabel(tk), type: 'text' }));
  return [...defs, ...loose];
}

function SendWizard({ templates, employees, entities, prefill, onPrefillConsumed, onClose, onSent, toastOk, toastErr }) {
  const { myEmail } = useRole() || {};
  const [boxRef, boxH] = useFillHeight();
  const isMobile = useIsMobile();
  const [step, setStep] = useState(0);
  // Excluded-record acknowledgment (ESIGN 15 U.S.C. 7003 / Cal. Civ. Code
  // 1633.3). The list comes from the server so this checklist and the
  // guardrail that enforces it can never drift apart.
  const [excludedAck, setExcludedAck] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [excludedCats, setExcludedCats] = useState([]);
  // Document class drives the HARD block (the server refuses a class the law
  // does not allow); governing law routes the signer's consent flow.
  const [docClasses, setDocClasses] = useState([]);
  const [documentClass, setDocumentClass] = useState('');
  // Empty = not tied to one jurisdiction, and that is the default. The
  // certificate then cites ESIGN and UETA generally, which is accurate without
  // anyone choosing; a sender with an actual governing-law clause names it.
  const [governingLaw, setGoverningLaw] = useState('');
  useEffect(() => { api.getEsignExcludedCategories().then(setExcludedCats).catch(() => setExcludedCats([])); }, []);
  useEffect(() => { api.getEsignDocumentClasses().then(setDocClasses).catch(() => setDocClasses([])); }, []);
  const pickedClass = docClasses.find(c => c.code === documentClass);
  const classBlocked = !!pickedClass && !pickedClass.electronicPermitted;
  const [source, setSource] = useState(prefill?.source === 'pdf' ? 'pdf' : (prefill ? 'template' : ''));
  const [templateId, setTemplateId] = useState('');
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [subjectId, setSubjectId] = useState(prefill?.candidateId ? `c:${prefill.candidateId}` : '');
  const [candidates, setCandidates] = useState([]);
  const [entityId, setEntityIdRaw] = useState(() => defaultSendEntityId(entities, employees, myEmail));
  // Entities and employees arrive asynchronously (react-query / a separate
  // fetch), so the first render often has neither. Keep applying the default
  // as they land - until the sender picks a company themselves.
  const entityTouched = useRef(false);
  const setEntityId = (id) => { entityTouched.current = true; setEntityIdRaw(id); };
  useEffect(() => {
    if (entityTouched.current) return;
    const d = defaultSendEntityId(entities, employees, myEmail);
    if (d) setEntityIdRaw(d);
  }, [entities, employees, myEmail]);
  const [title, setTitle] = useState(prefill?.title || '');
  const [message, setMessage] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [routing, setRouting] = useState('sequential');   // sequential | parallel
  const [merge, setMerge] = useState({});
  const [parties, setParties] = useState(prefill?.parties?.map(p => ({ ...p })) || []);
  const [busy, setBusy] = useState(false);
  // Field editor state (pdf mode)
  const [fields, setFields] = useState([]);
  const [activeRecipient, setActiveRecipient] = useState(0); // index into signerParties
  const [activeType, setActiveType] = useState('sign');
  const [zoom, setZoom] = useState(1);
  const [pdfEditOpen, setPdfEditOpen] = useState(false);
  const [optsFor, setOptsFor] = useState(null);   // field id whose options are being edited
  const [labelFor, setLabelFor] = useState(null); // upload field whose label is being edited
  const dragState = useRef(null);   // {fieldId, mode:'move'|'resize', rect, startX, startY, orig}
  const rkCounter = useRef(0);      // stable per-party field keys - survive removal/reorder

  useEffect(() => { api.getCandidates().then(setCandidates).catch(() => setCandidates([])); }, []);

  const tpl = templates.find(t => t.id === templateId);
  const isPdf = source === 'pdf';
  // "No fields to place" - a CC, an approver and a certified-delivery
  // recipient all receive the document without signing it, so none of them
  // gets a signature field or a recipient color.
  const NON_SIGNING_ROLES = ['cc', 'approver', 'certified_delivery'];
  const isCC = (p) => NON_SIGNING_ROLES.includes(p.party_role || 'signer');
  // Signers with their party-array index (colors key off the array index)
  const signerParties = parties.map((p, i) => ({ p, i })).filter(x => !isCC(x.p));

  // PDF-mode recipients get invisible auto role keys - fields belong to PEOPLE,
  // not typed role strings (the v1 mistake). The key (_rk) is assigned once at
  // add time and never re-derived from position, so removing a recipient can't
  // silently re-point everyone else's fields.
  const withRoles = parties.map((p, i) => ({
    ...p,
    role_key: isCC(p) ? (p._rk || `cc${i + 1}`) : (isPdf ? p._rk : p.role_key),
    ordinal: i + 1,
  }));

  const mergeTokens = useMemo(() => {
    if (!tpl) return [];
    const found = new Set();
    for (const para of tpl.body || []) for (const m of String(para).matchAll(MERGE_RE)) found.add(m[1]);
    found.delete('today');
    return [...found];
  }, [tpl]);

  // Client-side merge preview (the server is authoritative at send)
  const previewMerge = useMemo(() => {
    const d = { today: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) };
    const emp = subjectId.startsWith('e:') ? employees.find(x => x.id === subjectId.slice(2)) : null;
    const cand = subjectId.startsWith('c:') ? candidates.find(x => x.id === subjectId.slice(2)) : null;
    const en = entities.find(x => x.id === entityId);
    if (emp) Object.assign(d, { first_name: emp.firstName, last_name: emp.lastName, full_name: `${emp.firstName} ${emp.lastName}`.trim(), email: emp.workEmail || emp.personalEmail, job_title: emp.jobTitle, department: emp.department, start_date: emp.startDate, manager: emp.managerEmail });
    if (cand) Object.assign(d, { first_name: cand.firstName, last_name: cand.lastName, full_name: `${cand.firstName} ${cand.lastName}`.trim(), email: cand.email, job_title: cand.roleTitle, department: cand.department, start_date: cand.expectedStart });
    if (en) Object.assign(d, { company: en.name, company_legal: en.legalName || en.name, company_address: en.registeredAddress, signatory: en.signatory });
    for (const [k, v] of Object.entries(merge)) if (String(v).trim()) d[k] = v;
    Object.keys(d).forEach(k => { if (!d[k]) delete d[k]; });
    return d;
  }, [subjectId, entityId, merge, employees, candidates, entities]);

  function pickTemplate(t) {
    setTemplateId(t.id); setSource('template'); setTitle(t.name);
    setParties(prev => (t.roles || []).map(r => {
      // Preserve anything the user already typed for this role, then prefill,
      // then blank - re-clicking a template (or picking another) must not wipe
      // recipient names/emails/CCs/access codes entered at the next step.
      const kept = prefill?.parties?.find(p => p.role_key === r.key);
      const existing = prev.find(p => p.role_key === r.key);
      return { party_role: 'signer', access_code: '', phone: '', name: '', email: '', kind: 'internal',
               ...(kept || {}), ...(existing || {}), role_key: r.key, roleLabel: r.label || r.key };
    }));
  }
  // The Documents template library, most-used first. Nexus Sign selects from
  // it; it never manages it (requirement 25).
  const [docTemplates, setDocTemplates] = useState(null);
  const [tplQuery, setTplQuery] = useState('');
  const [docTemplateId, setDocTemplateId] = useState('');
  const [generating, setGenerating] = useState('');
  useEffect(() => {
    api.getDocTemplates({ status: 'active', sort: 'usage' })
      .then(setDocTemplates).catch(() => setDocTemplates([]));
  }, []);
  const shownDocTemplates = useMemo(() => {
    const q = tplQuery.trim().toLowerCase();
    const all = docTemplates || [];
    if (!q) return all.slice(0, 12);       // the most-used handful, not all 60
    return all.filter(t => t.name.toLowerCase().includes(q)
                        || (t.department || '').toLowerCase().includes(q)
                        || (t.category || '').toLowerCase().includes(q));
  }, [docTemplates, tplQuery]);

  // Picking a template GENERATES the document from it and sends that - the
  // same path Documents' own "Send for Signature" takes, so there is one
  // generation engine and one set of approved language. Recipients are
  // pre-filled from the template's default signers.
  // Picking a template with variables opens its form HERE. Sending someone to
  // another tab to fill it in and come back is not a flow, it is a detour -
  // and the inputs are the shared TypedFieldInput/validateFieldValue the
  // Documents wizard uses, so this is the same form, not a second one.
  const [pendingTpl, setPendingTpl] = useState(null);
  const [fillValues, setFillValues] = useState({});
  const [fillErrors, setFillErrors] = useState({});
  const askableFields = templateAskFields;

  const pickDocTemplate = async (t) => {
    if (generating) return;
    const fields = askableFields(t);
    if (fields.length) {
      setPendingTpl(t);
      setFillErrors({});
      // Defaults the template already carries, so common values are pre-filled.
      setFillValues(Object.fromEntries(fields.map(fd => [fd.token, fd.default || ''])));
      return;
    }
    await generateFromTemplate(t, {});
  };

  const submitTemplateFill = async () => {
    const t = pendingTpl;
    const errs = {};
    for (const fd of askableFields(t)) {
      const err = validateFieldValue(fd, fillValues[fd.token]);
      if (err) errs[fd.token] = err;
    }
    setFillErrors(errs);
    if (Object.keys(errs).length) return;
    const values = Object.fromEntries(
      askableFields(t)
        .filter(fd => fillValues[fd.token] !== undefined && fillValues[fd.token] !== '')
        .map(fd => [fd.token, formatFieldValue(fd, fillValues[fd.token])]));
    const ok = await generateFromTemplate(t, values);
    if (ok) setPendingTpl(null);
  };

  // What was generated last, so changing About / Company below regenerates the
  // same template with the same answers instead of silently leaving a document
  // whose {{tokens}} were resolved against the old pair.
  const lastGen = useRef(null);   // { tpl, values }

  const generateFromTemplate = async (t, fillValuesPayload) => {
    setGenerating(t.id);
    lastGen.current = { tpl: t, values: fillValuesPayload };
    try {
      // The document is born with its subject and company, so the server
      // resolves {{full_name}}, {{job_title}}, {{company_address}}… while
      // generating. Without them the PDF keeps the raw tokens.
      // A candidate is not an employee row, so their details ride along as
      // fill values (same precedence as any typed-in value).
      const emp = subjectId.startsWith('e:') ? subjectId.slice(2) : '';
      const cand = subjectId.startsWith('c:') ? candidates.find(x => x.id === subjectId.slice(2)) : null;
      const values = { ...fillValuesPayload };
      if (cand) Object.assign(values, {
        first_name: cand.firstName || '', last_name: cand.lastName || '',
        full_name: `${cand.firstName || ''} ${cand.lastName || ''}`.trim(),
        email: cand.email || '', job_title: cand.roleTitle || '',
        department: cand.department || '', start_date: cand.expectedStart || '',
      });
      const doc = await api.createDocument({
        title: t.name, templateId: t.id,
        ...(emp ? { employeeId: emp } : {}),
        ...(entityId ? { entityId } : {}),
        ...(Object.keys(values).length ? { fillValues: values } : {}) });
      const { blob, filename } = await api.exportDocumentPdf(doc.id);
      const file = new File([blob], (filename || `${t.name}.pdf`).replace(/\.pdf$/i, '') + '.pdf',
                            { type: 'application/pdf' });
      await pickFile(file);
      setDocTemplateId(t.id);
      setTitle(t.name);
      if ((t.signerRoles || []).length) {
        setParties((t.signerRoles || []).map(r => ({
          _rk: newRk(), name: '', email: '', kind: 'internal', party_role: 'signer',
          access_code: '', phone: '', roleLabel: r.label || r.key,
        })));
      }
      toastOk(`Generated from "${t.name}" - add recipients and place the fields.`);
      return true;
    } catch (e) {
      toastErr(e?.message || `Could not generate a document from "${t.name}"`);
      return false;
    } finally { setGenerating(''); }
  };

  // Re-generate when the subject or company changes after a template was
  // picked - they are chosen beside the template list, usually AFTER it, and
  // the first document was built without them. Only on the Document step: past
  // it, fields have been placed on the PDF and replacing it would drop them.
  useEffect(() => {
    const gen = lastGen.current;
    if (!gen || !docTemplateId || step !== 0 || generating) return;
    generateFromTemplate(gen.tpl, gen.values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId, entityId]);

  const [egnyteOpen, setEgnyteOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const newRk = () => `p${++rkCounter.current}`;
  async function pickFile(fl) {
    if (!fl) return;
    if (isDocx(fl)) {
      // A Word file is converted on the SERVER, by a real Word layout engine,
      // or not at all. The old client-side path (mammoth -> pdf-lib reflow)
      // rewrote the document to fit US Letter with 56pt margins and the two
      // standard PDF fonts, so an A4 contract in Calibri came out as a Letter
      // page in Helvetica with the characters it could not encode replaced by
      // "?" - and then that was what people signed. Sagar, Sep 16: "0
      // alterations means 0." Refusing beats silently reflowing a contract.
      setConverting(true);
      try {
        fl = await api.convertDocxToPdf(fl);
        toastOk('Word document converted - layout preserved.');
      } catch (e) {
        toastErr(e?.status === 501
          ? 'Word conversion is not available on this deployment yet. Please save the '
            + 'document as PDF in Word (File - Save As - PDF) and upload that, so the '
            + 'signed copy matches your original exactly.'
          : (e?.message || 'Could not convert that Word file - is it a valid .docx?'));
        setConverting(false);
        return;
      }
      setConverting(false);
    } else if (fl.type !== 'application/pdf') { toastErr('Choose a PDF or Word (.docx) file.'); return; }
    setFile(fl); setSource('pdf'); setTemplateId(''); setFields([]);
    setTitle(t => t || fl.name.replace(/\.pdf$/i, ''));
    // Switching INTO pdf mode: fields belong to people via _rk. Parties carried
    // over from a template pick or candidate prefill have no _rk - without one,
    // placeField no-ops and role_key sends as undefined. Backfill it here.
    setParties(ps => ps.length
      ? ps.map(p => p._rk ? p : { party_role: 'signer', access_code: '', phone: '', ...p, _rk: newRk() })
      : [{ _rk: newRk(), name: '', email: '', kind: 'internal', party_role: 'signer', access_code: '', phone: '' }]);
  }

  // Documents module handoff (Phase 5): a Document Builder export lands here
  // as a synthetic File on prefill.file - feed it through the exact same
  // pickFile() path a real file-picker selection would take.
  //
  // Then tell the owner to let go of it. A prefill is a ONE-SHOT handoff, and
  // the parent used to hold it until this wizard closed: <ESign> is mounted on
  // the Nexus Sign tab, so leaving the tab and coming back remounted it, saw a
  // prefill still sitting there, reopened the wizard and re-applied
  // prefill.file - silently putting the ORIGINAL export back over whatever the
  // sender had done since, Edit PDF changes included. Releasing it here (after
  // this component's state initializers have already read it) means a remount
  // finds nothing to re-apply.
  useEffect(() => {
    if (prefill?.file) pickFile(prefill.file);
    if (prefill) onPrefillConsumed?.();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const setParty = (i, k, v) => setParties(ps => ps.map((p, j) => j === i ? { ...p, [k]: v } : p));
  const movParty = (i, dir) => setParties(ps => {
    const j = i + dir; if (j < 0 || j >= ps.length) return ps;
    const next = [...ps]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const rmParty = (i) => {
    const gone = parties[i];
    setParties(ps => ps.filter((_, j) => j !== i));
    if (isPdf && gone?._rk) setFields(fs => fs.filter(f => f.role !== gone._rk));
    setActiveRecipient(0);
  };
  // Flipping someone to CC drops their placed fields - CC recipients never sign.
  const setPartyRole = (i, role) => {
    const p = parties[i];
    // Approvers and certified-delivery recipients never sign, so any field
    // already placed for them is meaningless - drop it, exactly as for a CC.
    const nonSigning = ['cc', 'approver', 'certified_delivery'].includes(role);
    if (nonSigning && isPdf && p?._rk) setFields(fs => fs.filter(f => f.role !== p._rk));
    setParty(i, 'party_role', role);
    setActiveRecipient(0);
  };
  const pickEmployee = (i, id) => {
    const e = employees.find(x => x.id === id);
    if (e) setParties(ps => ps.map((p, j) => j === i
      ? { ...p, name: `${e.firstName} ${e.lastName}`.trim(), email: e.workEmail, kind: 'internal' } : p));
  };

  // ── Field placement (click OR drag from palette; move + resize on page) ─────
  function placeField(page, x, y, type = activeType) {
    const owner = signerParties[activeRecipient]?.p;
    if (!owner?._rk) return;
    const meta = FIELD_META[type] || FIELD_META.sign;
    const id = `f${Date.now()}`;
    setFields(fs => [...fs, {
      id, role: owner._rk, type, page,
      x: Math.min(0.98 - meta.w, Math.max(0, x - meta.w / 2)),
      y: Math.min(0.98 - meta.h, Math.max(0, y - meta.h / 2)),
      w: meta.w, h: meta.h, required: true,
      ...(meta.opts ? { options: ['Option 1', 'Option 2'] } : {}),
    }]);
    if (meta.opts) setOptsFor(id); // choices matter more than position - edit them right away
  }
  const onFieldDrag = useCallback((e) => {
    const s = dragState.current; if (!s) return;
    const dx = (e.clientX - s.startX) / s.rect.width;
    const dy = (e.clientY - s.startY) / s.rect.height;
    setFields(fs => fs.map(f => {
      if (f.id !== s.fieldId) return f;
      if (s.mode === 'move') {
        return { ...f, x: Math.min(0.99 - f.w, Math.max(0, s.orig.x + dx)), y: Math.min(0.99 - f.h, Math.max(0, s.orig.y + dy)) };
      }
      return { ...f, w: Math.min(0.9, Math.max(0.02, s.orig.w + dx)), h: Math.min(0.4, Math.max(0.012, s.orig.h + dy)) };
    }));
  }, []);
  const endFieldDrag = useCallback(() => {
    dragState.current = null;
    window.removeEventListener('pointermove', onFieldDrag);
  }, [onFieldDrag]);
  const startFieldDrag = (e, f, mode) => {
    e.stopPropagation(); e.preventDefault();
    const pageEl = e.currentTarget.closest('[data-espage]');
    if (!pageEl) return;
    dragState.current = { fieldId: f.id, mode, rect: pageEl.getBoundingClientRect(), startX: e.clientX, startY: e.clientY, orig: { ...f } };
    window.addEventListener('pointermove', onFieldDrag);
    window.addEventListener('pointerup', endFieldDrag, { once: true });
  };

  const recipIdx = (role) => Math.max(0, parties.findIndex(p => p._rk === role));
  const editorOverlay = (pageIdx) => (
    <div data-espage style={{ position: 'absolute', inset: 0 }}
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); placeField(pageIdx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }}
      onDragOver={e => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const t = e.dataTransfer.getData('field'); if (t) { const r = e.currentTarget.getBoundingClientRect(); placeField(pageIdx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, t); } }}>
      {fields.filter(f => f.page === pageIdx).map(f => {
        const c = rcolor(recipIdx(f.role));
        const M = FIELD_META[f.type];
        return (
          <div key={f.id} onPointerDown={(e) => startFieldDrag(e, f, 'move')} onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`,
              border: `2px solid ${c.solid}`, background: c.soft, borderRadius: 5, cursor: 'grab', touchAction: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter,sans-serif' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: c.solid, display: 'inline-flex', alignItems: 'center', gap: 4, pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <M.Icon size={10} /> {(M.labeled && f.label) || M.label}
            </span>
            {(M.opts || M.labeled) && (
              <button onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); (M.labeled ? setLabelFor : setOptsFor)(f.id); }}
                title={M.labeled ? (f.label ? `"${f.label}" - click to edit` : 'Name this attachment')
                  : `Edit choices (${(f.options || []).length})`}
                style={{ position: 'absolute', top: -9, right: 12, width: 18, height: 18, borderRadius: '50%', background: '#fff', color: c.solid, border: `2px solid ${c.solid}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                <Pencil size={9} />
              </button>
            )}
            <button onPointerDown={e => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setFields(fs => fs.filter(x => x.id !== f.id)); }}
              title="Remove" style={{ position: 'absolute', top: -9, right: -9, width: 18, height: 18, borderRadius: '50%', background: c.solid, color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
              <X size={11} />
            </button>
            <span onPointerDown={(e) => startFieldDrag(e, f, 'resize')}
              style={{ position: 'absolute', bottom: -6, right: -6, width: 12, height: 12, borderRadius: 3, background: '#fff', border: `2px solid ${c.solid}`, cursor: 'nwse-resize', touchAction: 'none' }} />
          </div>
        );
      })}
    </div>
  );

  // ── Steps + validation ──────────────────────────────────────────────────────
  // PDF envelopes: recipients and fields live on ONE page (Egnyte Sign style).
  const steps = isPdf ? ['Document', 'Recipients & Fields', 'Review & Send']
                      : ['Document', 'Recipients', 'Preview', 'Review & Send'];
  const partiesOk = () => signerParties.length > 0 && parties.every(p => p.name.trim() && /@/.test(p.email));
  const stepOk = () => {
    if (step === 0) return source === 'template' ? !!tpl : !!file;
    if (isPdf) return step !== 1 || (partiesOk() && fields.length > 0);
    if (step === 1) return partiesOk();
    return true;
  };
  const stepHint = () => {
    if (step === 0) return 'Pick a template or upload a PDF first.';
    if (signerParties.length === 0) return 'At least one recipient has to sign - the rest can receive copies.';
    if (!partiesOk()) return 'Every recipient needs a name and a valid email.';
    if (isPdf && step === 1 && fields.length === 0) return 'Drag at least one field onto the document.';
    return '';
  };
  // One set of nav actions behind two bars - the desktop top bar and the mobile
  // bottom bar below it - so a phone can never end up on a step it cannot leave.
  const goBack = () => setStep(s => s - 1);
  const goNext = () => (stepOk() ? setStep(s => s + 1) : toastErr(stepHint()));
  const sendBlocked = busy || !excludedAck || !documentClass || classBlocked;
  const sendTitle = classBlocked ? 'This document type cannot be signed electronically'
    : !documentClass ? 'Pick the document type first'
    : excludedAck ? '' : 'Confirm the document type first';

  async function send() {
    if (busy) return; setBusy(true);
    const subject = subjectId.startsWith('e:') ? { employee_id: subjectId.slice(2) }
      : subjectId.startsWith('c:') ? { candidate_id: subjectId.slice(2) } : {};
    try {
      let sent;
      if (source === 'template') {
        sent = await api.sendSignRequest({
          template_id: tpl.id, title: title.trim(), ...subject, entity_id: entityId,
          message, expires_on: expiresOn, routing,
          merge: Object.fromEntries(Object.entries(merge).filter(([, v]) => String(v).trim())),
          excluded_ack: excludedAck, document_class: documentClass, governing_law: governingLaw,
          parties: withRoles.map(p => ({ role_key: p.role_key, name: p.name, email: p.email, kind: p.kind, ordinal: p.ordinal, party_role: p.party_role || 'signer', access_code: p.access_code || '', org: p.org || '', title: p.title || '', phone: p.phone || '' })),
        });
      } else {
        const form = new FormData();
        form.append('file', file);
        form.append('payload', JSON.stringify({
          title: title.trim() || file.name,
          ...(subject.employee_id ? { employeeId: subject.employee_id } : {}),
          ...(subject.candidate_id ? { candidateId: subject.candidate_id } : {}),
          entityId, message, expiresOn, fields, routing, excludedAck,
          documentClass, governingLaw,
          parties: withRoles.map(p => ({ roleKey: p.role_key, name: p.name, email: p.email, kind: p.kind, ordinal: p.ordinal, partyRole: p.party_role || 'signer', accessCode: p.access_code || '', org: p.org || '', title: p.title || '', phone: p.phone || '' })),
        }));
        sent = await api.sendSignPdf(form);
      }
      const nSign = (sent.parties || []).filter(p => p.partyRole !== 'cc').length;
      const nCC = (sent.parties || []).length - nSign;
      toastOk(`Sent "${sent.title}" to ${nSign} signer${nSign === 1 ? '' : 's'}${nCC ? ` + ${nCC} CC` : ''}.`);
      onSent(sent); onClose();
    } catch (e) { toastErr(e?.message || 'Could not send.'); setBusy(false); }
  }

  const previewPara = (para, pi) => {
    const resolved = String(para).replace(MERGE_RE, (m0, k) => previewMerge[k] || m0);
    const parts = []; let last = 0, m;
    const re = new RegExp(FIELD_RE.source, 'g');
    while ((m = re.exec(resolved)) !== null) {
      if (m.index > last) parts.push(<span key={`t${last}`}>{resolved.slice(last, m.index)}</span>);
      const [, type, role, label = ''] = m;
      const ri = (tpl?.roles || []).findIndex(r => r.key === role);
      const c = rcolor(Math.max(0, ri));
      const M = FIELD_META[type] || FIELD_META.sign;
      parts.push(
        <span key={`f${m.index}`} style={{ display: type === 'sign' ? 'inline-block' : 'inline', margin: type === 'sign' ? '6px 0' : 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: type === 'sign' ? '7px 16px' : '2px 9px', borderRadius: 7, border: `1.5px solid ${c.solid}`, background: c.soft, color: c.solid, fontSize: type === 'sign' ? 12 : 10.5, fontWeight: 700, fontFamily: 'Inter,sans-serif' }}>
            <M.Icon size={type === 'sign' ? 13 : 10} /> {M.label}{label ? ` · ${label}` : ''} - {withRoles.find(p => p.role_key === role)?.name || (tpl?.roles || []).find(r => r.key === role)?.label || role}
          </span>
        </span>);
      last = m.index + m[0].length;
    }
    if (last < resolved.length) parts.push(<span key="end">{resolved.slice(last)}</span>);
    const unresolvedHere = [...resolved.matchAll(MERGE_RE)].length > 0;
    return <div key={pi} style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', background: unresolvedHere ? 'rgba(251,191,36,0.09)' : 'transparent', borderRadius: 6 }}>{parts}</div>;
  };
  const unresolvedTokens = useMemo(() => {
    if (!tpl) return [];
    const un = new Set();
    for (const para of tpl.body || [])
      for (const m of String(para).replace(MERGE_RE, (m0, k) => previewMerge[k] || m0).matchAll(MERGE_RE)) un.add(m[1]);
    return [...un];
  }, [tpl, previewMerge]);

  return (
    <div ref={boxRef} style={fillPanelStyle(boxH)}>
      {/* Top bar: title + step pills + nav. Desktop only - on a phone the pills
          wrap into a stack that ate half the screen before the form even
          started, so mobile gets the slim bottom bar at the end of this panel
          instead and the envelope title moves into step 0. */}
      {!isMobile && (
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>
        <button onClick={onClose} title="Discard and go back" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 6 }}><X size={19} /></button>
        <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Envelope title…"
          style={{ fontWeight: 700, fontSize: 14, width: 'min(300px, 26vw)' }} />
        <div style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
          {steps.map((s, i) => (
            <button key={s} onClick={() => i < step && setStep(i)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 13px', borderRadius: 20, fontSize: 12, fontWeight: 700, fontFamily: 'Inter,sans-serif', border: 'none', cursor: i < step ? 'pointer' : 'default',
                background: i === step ? 'var(--pine)' : i < step ? 'hsla(var(--color-green),0.12)' : 'var(--mist)',
                color: i === step ? '#fff' : i < step ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
              <span style={{ width: 17, height: 17, borderRadius: '50%', background: i === step ? 'rgba(255,255,255,0.25)' : 'transparent', border: i === step ? 'none' : '1.5px solid currentColor', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5 }}>
                {i < step ? <CheckCircle size={11} /> : i + 1}
              </span>
              {s}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {step > 0 && <button className="secondary-btn" onClick={goBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}><ChevronLeft size={13} /> Back</button>}
          {step < steps.length - 1 ? (
            <button className="primary-btn" onClick={goNext}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, opacity: stepOk() ? 1 : 0.55 }}>
              Next <ChevronRight size={13} />
            </button>
          ) : (
            <button className="primary-btn" onClick={send} disabled={sendBlocked} title={sendTitle}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: sendBlocked ? 0.6 : 1 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} Send
            </button>
          )}
        </div>
      </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* STEP 0 - Document */}
        {step === 0 && (
          <div style={{ maxWidth: 980, margin: '0 auto', padding: isMobile ? '14px 12px' : '26px 18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
              <div>
                {/* The company's ONE template library (requirement 25 - Nexus
                    Sign signs, it does not manage templates). Most-used first,
                    because with 15-60 templates the handful people actually
                    send should be at the top rather than whatever sorts first
                    alphabetically. */}
                {pendingTpl ? (
                  /* The template's own variables, asked for right here. Same
                     TypedFieldInput and validateFieldValue the Documents
                     wizard uses - one form, two doors. */
                  <>
                    <label style={FL}>Fill in {pendingTpl.name}</label>
                    <div style={{ border: '1.5px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card)' }}>
                      {/* Blank is a real answer: anything left empty is filled
                          from the person picked in About (and the Company)
                          when the document is generated. */}
                      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 10px' }}>
                        Leave a field blank to fill it from the person in <strong>About</strong> and the selected <strong>Company</strong>.
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 11, ...(isMobile ? {} : { maxHeight: 420, overflowY: 'auto' }) }}>
                        {askableFields(pendingTpl).map(fd => (
                          <div key={fd.token}>
                            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                              {fd.label}{fd.required && <span style={{ color: 'hsl(var(--color-red))' }}> *</span>}
                            </label>
                            {fd.description && (
                              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 4px' }}>{fd.description}</p>
                            )}
                            <TypedFieldInput def={fd} value={fillValues[fd.token]} error={fillErrors[fd.token]}
                              onChange={(v) => setFillValues(prev => ({ ...prev, [fd.token]: v }))} />
                            {fillErrors[fd.token] && (
                              <p style={{ fontSize: 11, color: 'hsl(var(--color-red))', margin: '3px 0 0' }}>{fillErrors[fd.token]}</p>
                            )}
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
                        <button className="secondary-btn" style={{ fontSize: 12.5 }}
                          onClick={() => { setPendingTpl(null); setFillErrors({}); }}>Back to templates</button>
                        <button className="primary-btn" disabled={!!generating} onClick={submitTemplateFill}
                          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {generating ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowRight size={13} />}
                          Generate &amp; Continue
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                <>
                <label style={FL}>Start from a template</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
                  <input className="form-input" value={tplQuery} onChange={e => setTplQuery(e.target.value)}
                    placeholder="Search templates…" style={{ width: '100%', fontSize: 12.5, paddingLeft: 30 }} />
                </div>
                {/* On a phone this list used to be a 340px scroller that filled the
                    whole panel, so a drag scrolled the templates and never reached
                    the upload box or About/Company below it. One scroll surface
                    there: the panel's own. */}
                <div style={{ display: 'grid', gap: 8, ...(isMobile ? {} : { maxHeight: 340, overflowY: 'auto' }) }}>
                  {shownDocTemplates.map(t => (
                    <button key={t.id} onClick={() => pickDocTemplate(t)} disabled={generating === t.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif',
                        background: 'var(--card)', border: docTemplateId === t.id ? '2px solid var(--pine)' : '1.5px solid var(--line)' }}>
                      <FileText size={17} style={{ color: 'var(--pine)', flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{t.name}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                          {t.department || 'Company-wide'}
                          {t.usageCount > 0 && ` · used ${t.usageCount} time${t.usageCount === 1 ? '' : 's'}`}
                          {(t.signerRoles || []).length > 0 && ` · ${t.signerRoles.length} signer${t.signerRoles.length === 1 ? '' : 's'}`}
                        </span>
                      </span>
                      {generating === t.id
                        ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--pine)' }} />
                        : docTemplateId === t.id && <CheckCircle size={17} style={{ color: 'var(--pine)' }} />}
                    </button>
                  ))}
                  {docTemplates === null && (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 16px' }}>Loading templates…</div>
                  )}
                  {docTemplates !== null && shownDocTemplates.length === 0 && (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 16px', border: '1.5px dashed var(--line)', borderRadius: 12 }}>
                      {tplQuery.trim()
                        ? `No active template matches "${tplQuery.trim()}".`
                        : 'No active templates yet - create one in the Templates tab, or upload a PDF →'}
                    </div>
                  )}
                </div>
                </>
                )}
              </div>
              <div>
                <label style={FL}>Or choose a PDF / Word document</label>
                <label onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 180, borderRadius: 14, cursor: 'pointer',
                    border: `2px dashed ${dragOver || (isPdf && file) ? 'var(--pine)' : 'var(--line)'}`, background: dragOver ? 'hsla(var(--color-green),0.06)' : 'var(--card)', padding: 20 }}>
                  <UploadCloud size={30} style={{ color: isPdf && file ? 'var(--pine)' : 'var(--muted)' }} />
                  {isPdf && file ? (
                    <>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{file.name}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{(file.size / 1024 / 1024).toFixed(1)} MB · click to replace</span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>Drop a PDF or Word file here</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>or click to browse your computer</span>
                    </>
                  )}
                  <input type="file" accept="application/pdf,.docx" style={{ display: 'none' }} onChange={e => pickFile(e.target.files?.[0])} />
                </label>
                {/* Two sources, side by side: this computer, or the company
                    file store. Most documents that get signed already live in
                    Egnyte, and making people download-then-re-upload is the
                    same round trip the filing rule exists to remove. */}
                <button className="secondary-btn" onClick={() => setEgnyteOpen(true)} disabled={converting}
                  title="Pick a document from the company Egnyte file store"
                  style={{ marginTop: 10, width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, fontSize: 12.5 }}>
                  <Cloud size={14} /> Choose from Egnyte
                </button>
                {converting && (
                  <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
                    <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                    Converting the Word document, preserving its layout…
                  </div>
                )}
                {isPdf && file && (
                  <button className="secondary-btn" onClick={() => setPdfEditOpen(true)}
                    title="Fix the PDF itself - text, pages, images - before placing fields"
                    style={{ marginTop: 10, width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12.5 }}>
                    <Pencil size={13} /> Edit PDF
                  </button>
                )}

                <div style={{ marginTop: 18, display: 'grid', gap: 12 }}>
                  <div>
                    <label style={FL}>About (person - fills merge fields)</label>
                    <select className="form-input" style={{ width: '100%' }} value={subjectId} onChange={e => setSubjectId(e.target.value)}>
                      <option value="">-</option>
                      <optgroup label="Employees">
                        {employees.map(e => <option key={e.id} value={`e:${e.id}`}>{e.firstName} {e.lastName} ({e.employeeCode})</option>)}
                      </optgroup>
                      <optgroup label="Candidates">
                        {candidates.filter(c => !c.employeeId).map(c => <option key={c.id} value={`c:${c.id}`}>{c.firstName} {c.lastName} - {c.roleTitle || 'candidate'}</option>)}
                      </optgroup>
                    </select>
                  </div>
                  <div>
                    <label style={FL}>Company</label>
                    <select className="form-input" style={{ width: '100%' }} value={entityId} onChange={e => setEntityId(e.target.value)}>
                      {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
                    </select>
                  </div>
                  {/* Phones have no top bar to hold the title input, so it lives
                      here - below the template/PDF pick that fills it in. */}
                  {isMobile && (
                    <div>
                      <label style={FL}>Envelope Title</label>
                      <input className="form-input" style={{ width: '100%', fontWeight: 700 }} value={title}
                        onChange={e => setTitle(e.target.value)} placeholder="Envelope title…" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 1 - Recipients (template envelopes; PDF mode edits them beside the fields) */}
        {step === 1 && !isPdf && (
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <Users size={16} style={{ color: 'var(--pine)' }} />
              <span style={{ fontSize: 14, fontWeight: 800 }}>Who signs?</span>
              <div style={{ flex: 1 }} />
              {signerParties.length > 1 && (
                <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid var(--line)', overflow: 'hidden' }}
                  title="In order: one signer at a time, in the numbered order. All at once: everyone is invited immediately.">
                  {[['sequential', 'Sign in order'], ['parallel', 'All at once']].map(([v, l]) => (
                    <button key={v} onClick={() => setRouting(v)}
                      style={{ padding: '5px 14px', fontSize: 11.5, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: routing === v ? 'var(--pine)' : 'var(--card)', color: routing === v ? '#fff' : 'var(--muted)' }}>{l}</button>
                  ))}
                </div>
              )}
            </div>
            {parties.map((p, i) => {
              const c = rcolor(i);
              const cc = isCC(p);
              return (
                <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 10 }}>
                    <button onClick={() => movParty(i, -1)} disabled={i === 0} style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 2 }}><ChevronUp size={14} /></button>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: cc ? 'var(--mist)' : c.solid, color: cc ? 'var(--muted)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: cc ? 10 : 12.5, fontWeight: 800 }}>{cc ? 'CC' : i + 1}</span>
                    <button onClick={() => movParty(i, 1)} disabled={i === parties.length - 1} style={{ background: 'none', border: 'none', cursor: i === parties.length - 1 ? 'default' : 'pointer', color: i === parties.length - 1 ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 2 }}><ChevronDown size={14} /></button>
                  </div>
                  <div style={{ flex: 1, border: '1.5px solid var(--line)', borderLeft: `4px solid ${cc ? 'var(--line)' : c.solid}`, borderRadius: 12, padding: '13px 15px', background: 'var(--card)', opacity: cc ? 0.92 : 1 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                      {p.roleLabel && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: c.solid }}>{p.roleLabel}</span>}
                      {/* Template roles are the document's signature slots - they must sign.
                          Free (pdf/CC) parties can flip between signing and copy-only. */}
                      {(isPdf || cc) && (
                        <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid var(--line)', overflow: 'hidden' }}>
                          {[['signer', 'Needs to sign'], ['approver', 'Approves'],
                            ['certified_delivery', 'Confirms receipt'],
                            ['cc', 'Receives a copy']].map(([v, l]) => (
                            <button key={v} onClick={() => setPartyRole(i, v)} disabled={!isPdf && v === 'signer'}
                              title={v === 'approver' ? 'Approves without signing - the envelope waits for them'
                                : v === 'certified_delivery' ? 'Must confirm receipt - never signs'
                                : v === 'cc' ? 'Receives the completed copy, never acts' : 'Signs the document'}
                              style={{ padding: '4px 11px', fontSize: 11, fontWeight: 700, border: 'none', cursor: (!isPdf && v === 'signer') ? 'default' : 'pointer', fontFamily: 'Inter,sans-serif', background: (p.party_role || 'signer') === v ? 'var(--pine)' : 'var(--card)', color: (p.party_role || 'signer') === v ? '#fff' : 'var(--muted)', opacity: (!isPdf && v === 'signer') ? 0.45 : 1 }}>{l}</button>
                          ))}
                        </div>
                      )}
                      <div style={{ flex: 1 }} />
                      <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid var(--line)', overflow: 'hidden' }}>
                        {[['internal', 'Teammate'], ['external', 'External']].map(([v, l]) => (
                          <button key={v} onClick={() => setParties(ps => ps.map((q, j) => j === i
                            ? { ...q, kind: v, ...(v === 'internal' ? { access_code: '' } : {}) } : q))}
                            style={{ padding: '4px 12px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: p.kind === v ? 'var(--pine)' : 'var(--card)', color: p.kind === v ? '#fff' : 'var(--muted)' }}>{l}</button>
                        ))}
                      </div>
                      {((!tpl && parties.length > 1) || (tpl && cc)) && (
                        <button onClick={() => rmParty(i)} title="Remove" style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 3 }}><Trash2 size={14} /></button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <NameCombo value={p.name} employees={employees}
                        onChange={v => setParty(i, 'name', v)} onPick={emp => pickEmployee(i, emp.id)} />
                      <input className="form-input" placeholder="email@…" value={p.email} onChange={e => setParty(i, 'email', e.target.value)} />
                    </div>
                    {!cc && (
                      /* Capacity to bind - printed on the Certificate of
                         Completion next to the signature. Optional: an employee
                         signing for themselves needs neither. */
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
                        <input className="form-input" style={{ fontSize: 12 }} placeholder="Title (optional)"
                          value={p.title || ''} onChange={e => setParty(i, 'title', e.target.value)} />
                        <input className="form-input" style={{ fontSize: 12 }} placeholder="Company (optional)"
                          value={p.org || ''} onChange={e => setParty(i, 'org', e.target.value)} />
                      </div>
                    )}
                    {!cc && (
                      /* Every signature needs a one-time code. It goes to their
                         email by default; a number here lets them choose a text
                         instead, which is a genuinely separate channel from the
                         one the signing link arrived on. Nexus never looks a
                         number up - a guessed one would text a signing
                         credential to a stranger. */
                      <input className="form-input" style={{ marginTop: 8, width: '100%', fontSize: 12 }}
                        placeholder="Mobile number (optional) - lets them get their verification code by text"
                        value={p.phone || ''} maxLength={40}
                        onChange={e => setParty(i, 'phone', e.target.value)} />
                    )}
                    {p.kind === 'external' && !cc && (
                      <input className="form-input" style={{ marginTop: 8, width: '100%', fontSize: 12 }}
                        placeholder="Access code (optional) - share it with them separately; the link will ask for it"
                        value={p.access_code || ''} maxLength={40}
                        onChange={e => setParty(i, 'access_code', e.target.value)} />
                    )}
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, marginLeft: 38, flexWrap: 'wrap' }}>
              {!tpl && (
                <button className="secondary-btn" onClick={() => setParties(ps => [...ps, { _rk: newRk(), name: '', email: '', kind: 'internal', party_role: 'signer', access_code: '', phone: '' }])}
                  style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add Signer</button>
              )}
              <button className="secondary-btn" onClick={() => setParties(ps => [...ps, { _rk: newRk(), name: '', email: '', kind: 'internal', party_role: 'cc', access_code: '', phone: '' }])}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add CC (copy only)</button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, marginLeft: 38 }}>
              Teammates get a bell notification and sign inside Nexus. External recipients get a secure email link - no login needed.
              CC recipients don't sign; they receive the sealed copy when everyone else has.
            </p>
          </div>
        )}

        {/* STEP 1 (pdf) - Recipients & fields on ONE page, Egnyte-Sign style */}
        {step === 1 && isPdf && (
          <div style={{ display: 'flex', height: '100%', minHeight: 0, alignItems: 'stretch' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '30px 20px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 10, position: 'sticky', top: 0, zIndex: 30 }}>
                <button className="secondary-btn" onClick={() => setPdfEditOpen(true)} title="Edit the PDF itself (placed fields reset afterwards)"
                  style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5 }}><Pencil size={12} /> Edit PDF</button>
                <button className="secondary-btn" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.15).toFixed(2)))} style={{ padding: '5px 9px' }}><ZoomOut size={13} /></button>
                <span style={{ alignSelf: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', width: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                <button className="secondary-btn" onClick={() => setZoom(z => Math.min(1.6, +(z + 0.15).toFixed(2)))} style={{ padding: '5px 9px' }}><ZoomIn size={13} /></button>
              </div>
              <PdfDoc file={file} zoom={zoom} renderOverlay={editorOverlay} />
            </div>
            <FieldsPanel width={368}
              recipients={signerParties.map(({ p, i }) => ({ label: p.name || `Recipient ${i + 1}`, sub: p.email || '', color: rcolor(i) }))}
              activeIdx={activeRecipient} onPick={setActiveRecipient}
              activeType={activeType} setActiveType={setActiveType} placed={fields.length}
              recipientsSlot={(
                <div style={{ marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', flex: 1 }}>Who signs?</span>
                    {signerParties.length > 1 && (
                      <div style={{ display: 'inline-flex', borderRadius: 7, border: '1px solid var(--line)', overflow: 'hidden' }}
                        title="In order: one at a time. All at once: everyone is invited immediately.">
                        {[['sequential', 'In order'], ['parallel', 'All at once']].map(([v, l]) => (
                          <button key={v} onClick={() => setRouting(v)}
                            style={{ padding: '3px 9px', fontSize: 10.5, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: routing === v ? 'var(--pine)' : 'var(--card)', color: routing === v ? '#fff' : 'var(--muted)' }}>{l}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {parties.map((p, i) => {
                      const c = rcolor(i), cc = isCC(p);
                      return (
                        <div key={i} style={{ border: '1.5px solid var(--line)', borderLeft: `4px solid ${cc ? 'var(--line)' : c.solid}`, borderRadius: 10, padding: '9px 10px', background: 'var(--card)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, flexWrap: 'wrap' }}>
                            <span style={{ width: 20, height: 20, borderRadius: '50%', background: cc ? 'var(--mist)' : c.solid, color: cc ? 'var(--muted)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: cc ? 9 : 11, fontWeight: 800, flexShrink: 0 }}>{cc ? 'CC' : i + 1}</span>
                            <div style={{ display: 'inline-flex', borderRadius: 7, border: '1px solid var(--line)', overflow: 'hidden' }}>
                              {[['signer', 'Signs'], ['approver', 'Approves'],
                                ['certified_delivery', 'Receipt'], ['cc', 'Copy']].map(([v, l]) => (
                                <button key={v} onClick={() => setPartyRole(i, v)}
                                  style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: (p.party_role || 'signer') === v ? 'var(--pine)' : 'var(--card)', color: (p.party_role || 'signer') === v ? '#fff' : 'var(--muted)' }}>{l}</button>
                              ))}
                            </div>
                            <div style={{ display: 'inline-flex', borderRadius: 7, border: '1px solid var(--line)', overflow: 'hidden' }}>
                              {[['internal', 'Teammate'], ['external', 'External']].map(([v, l]) => (
                                <button key={v} onClick={() => setParties(ps => ps.map((q, j) => j === i ? { ...q, kind: v, ...(v === 'internal' ? { access_code: '' } : {}) } : q))}
                                  style={{ padding: '2px 8px', fontSize: 10, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: p.kind === v ? 'var(--pine)' : 'var(--card)', color: p.kind === v ? '#fff' : 'var(--muted)' }}>{l}</button>
                              ))}
                            </div>
                            <div style={{ flex: 1 }} />
                            {parties.length > 1 && (
                              <button onClick={() => rmParty(i)} title="Remove"
                                style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 2 }}><Trash2 size={12} /></button>
                            )}
                          </div>
                          <NameCombo value={p.name} employees={employees}
                            onChange={v => setParty(i, 'name', v)} onPick={emp => pickEmployee(i, emp.id)}
                            placeholder="Full name - type to search" />
                          <input className="form-input" placeholder="email@…" value={p.email}
                            onChange={e => setParty(i, 'email', e.target.value)} style={{ width: '100%', marginTop: 6, fontSize: 12 }} />
                          {!cc && (
                            <input className="form-input" style={{ marginTop: 6, width: '100%', fontSize: 11.5 }}
                              placeholder="Mobile (optional) - for the code by text" value={p.phone || ''} maxLength={40}
                              onChange={e => setParty(i, 'phone', e.target.value)} />
                          )}
                          {p.kind === 'external' && !cc && (
                            <input className="form-input" style={{ marginTop: 6, width: '100%', fontSize: 11.5 }}
                              placeholder="Access code (optional)" value={p.access_code || ''} maxLength={40}
                              onChange={e => setParty(i, 'access_code', e.target.value)} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="secondary-btn" onClick={() => setParties(ps => [...ps, { _rk: newRk(), name: '', email: '', kind: 'internal', party_role: 'signer', access_code: '', phone: '' }])}
                      style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={11} /> Signer</button>
                    <button className="secondary-btn" onClick={() => setParties(ps => [...ps, { _rk: newRk(), name: '', email: '', kind: 'internal', party_role: 'cc', access_code: '', phone: '' }])}
                      style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={11} /> CC (copy only)</button>
                  </div>
                  <div style={{ height: 1, background: 'var(--line)', margin: '14px 0 10px' }} />
                </div>
              )} />
          </div>
        )}
        {/* STEP 2 - Live preview (template) */}
        {step === 2 && !isPdf && tpl && (
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: '26px 18px', display: 'grid', gridTemplateColumns: mergeTokens.length ? 'minmax(220px, 300px) 1fr' : '1fr', gap: 20, alignItems: 'start' }}>
            {mergeTokens.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 16px', position: 'sticky', top: 20 }}>
                <label style={FL}>Merge fields</label>
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: '0 0 12px' }}>Blank = auto-filled from the person/company. Highlighted paragraphs still have gaps.</p>
                <div style={{ display: 'grid', gap: 10 }}>
                  {mergeTokens.map(tk => (
                    <div key={tk}>
                      <label style={{ ...FL, marginBottom: 3, fontSize: 10 }}>{tk.replace(/_/g, ' ')}{unresolvedTokens.includes(tk) && <span style={{ color: '#b45309' }}> · needed</span>}</label>
                      <input className="form-input" style={{ width: '100%', borderColor: unresolvedTokens.includes(tk) ? '#fbbf24' : undefined }}
                        value={merge[tk] || ''} placeholder={previewMerge[tk] || 'type a value'}
                        onChange={e => setMerge(m => ({ ...m, [tk]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 4, padding: '34px 42px', color: '#111827', boxShadow: '0 2px 12px rgba(0,0,0,0.1)' }}>
              {(tpl.body || []).map(previewPara)}
              {(tpl.attachments || []).length > 0 && (
                <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed #e5e7eb' }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#6b7280', letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 8 }}>Also in this packet</div>
                  {tpl.attachments.map((a, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '5px 0', color: '#374151' }}>
                      <FileText size={13} style={{ color: 'var(--pine)' }} />
                      {a.name} <span style={{ color: '#9ca3af' }}>· {a.pages} page{a.pages === 1 ? '' : 's'} · {(a.fields || []).length} field{(a.fields || []).length === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* FINAL STEP - Review & send */}
        {step === steps.length - 1 && step > 0 && (
          <div style={{ maxWidth: 620, margin: '0 auto', padding: '30px 18px' }}>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
                <FileSignature size={20} style={{ color: 'var(--pine)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>{title || 'Untitled envelope'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {source === 'template' ? `Template: ${tpl?.name}` : `PDF: ${file?.name} · ${fields.length} field${fields.length === 1 ? '' : 's'}`}
                  </div>
                </div>
              </div>
              <div style={{ padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
                <label style={{ ...FL, marginBottom: 10 }}>
                  Recipients - {routing === 'parallel' ? 'everyone signs at once' : 'they sign in order'}
                </label>
                {withRoles.map((p, i) => {
                  const cc = NON_SIGNING_ROLES.includes(p.party_role || 'signer');
                  const roleNote = { approver: 'approves, does not sign',
                                     certified_delivery: 'confirms receipt',
                                     cc: 'receives a copy' }[p.party_role || 'signer'];
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
                      <span style={{ width: 22, height: 22, borderRadius: '50%', background: cc ? 'var(--mist)' : rcolor(i).solid, color: cc ? 'var(--muted)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: cc ? 9 : 11, fontWeight: 800, flexShrink: 0 }}>{cc ? 'CC' : i + 1}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{p.name}{roleNote && <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}> · {roleNote}</span>}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email} · {p.kind}{p.access_code ? ' · 🔒 code' : ''}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'grid', gap: 12, paddingTop: 14 }}>
                <div>
                  <label style={FL}>Message to signers</label>
                  <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
                    value={message} onChange={e => setMessage(e.target.value)} placeholder="optional note shown in the email + signing page" />
                </div>
                <div style={{ maxWidth: 220 }}>
                  <label style={FL}>Expires</label>
                  <input type="date" className="form-input" style={{ width: '100%' }} value={expiresOn} onChange={e => setExpiresOn(e.target.value)} />
                </div>
              </div>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '2fr 1fr', marginTop: 14 }}>
                <div>
                  <label style={FL}>Document type</label>
                  <select className="form-input" style={{ width: '100%' }} value={documentClass}
                    onChange={e => setDocumentClass(e.target.value)}>
                    <option value="">Select the type…</option>
                    {docClasses.map(c => (
                      <option key={c.code} value={c.code}>
                        {c.label}{c.electronicPermitted ? '' : ' - cannot be signed electronically'}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={FL}>Governing law (optional)</label>
                  <select className="form-input" style={{ width: '100%' }} value={governingLaw}
                    onChange={e => setGoverningLaw(e.target.value)}>
                    <option value="">Not specified</option>
                    {[['CA', 'California'], ['TX', 'Texas'], ['NV', 'Nevada'], ['AZ', 'Arizona'],
                      ['WA', 'Washington'], ['OR', 'Oregon'], ['NY', 'New York'], ['FL', 'Florida'],
                      ['IN', 'India']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              {classBlocked && (
                <div style={{ marginTop: 10, padding: '11px 13px', borderRadius: 10, background: 'hsla(var(--color-red),0.10)', border: '1px solid hsla(var(--color-red),0.35)' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'hsl(var(--color-red))' }}>
                    This cannot be signed electronically
                  </div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 4 }}>
                    {pickedClass.citation}. {pickedClass.note}
                  </div>
                </div>
              )}
              {!governingLaw && !classBlocked && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  Leave this unset unless the agreement names a governing law. The certificate then
                  cites the federal ESIGN Act and UETA as enacted in the applicable jurisdiction,
                  which holds wherever the parties are.
                </div>
              )}
              {governingLaw === 'CA' && !classBlocked && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  California: the certificate cites Cal. Civ. Code 1633 et seq. Every signer gets a
                  standalone consent screen before the document opens, whichever law you pick.
                </div>
              )}
              {governingLaw === 'IN' && !classBlocked && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  India: the certificate cites the Information Technology Act, 2000 instead of
                  UETA. Check that the record is not one the Act's Schedule I excludes.
                </div>
              )}

              {/* Excluded records - the threshold question, asked once, on the
                  last screen before it goes out. ESIGN 15 U.S.C. 7003 and Cal.
                  Civ. Code 1633.3 make an electronic signature legally
                  INEFFECTIVE on these, so no audit trail can rescue one; the
                  server refuses the send without this acknowledgment, and the
                  certificate records who gave it. */}
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input type="checkbox" checked={excludedAck} onChange={e => setExcludedAck(e.target.checked)}
                    style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0, accentColor: 'var(--pine)' }} />
                  <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                    I confirm this is not a record that cannot be signed electronically.{' '}
                    <button type="button" onClick={(e) => { e.preventDefault(); setExcludedOpen(o => !o); }}
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--muted)', textDecoration: 'underline', cursor: 'pointer' }}>
                      {excludedOpen ? 'Hide the list' : 'See the list'}
                    </button>
                  </span>
                </label>
                {excludedOpen && (
                  <ul style={{ margin: '10px 0 0', padding: '10px 12px 10px 26px', background: 'var(--mist)', borderRadius: 10, fontSize: 11.5, lineHeight: 1.6 }}>
                    {excludedCats.map(c => (
                      <li key={c.label} style={{ marginBottom: 3 }}>
                        {c.label} <span style={{ color: 'var(--muted)' }}>- {c.citation}</span>
                      </li>
                    ))}
                    <li style={{ listStyle: 'none', marginLeft: -14, marginTop: 8, color: 'var(--muted)' }}>
                      Send these on paper, or through a notary. This list is a checklist, not legal advice.
                    </li>
                  </ul>
                )}
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12, textAlign: 'center' }}>
              Signer 1 is notified immediately; everyone else follows in order. You can remind, void or track it under Sent requests.
            </p>
          </div>
        )}
      </div>

      {/* Mobile nav: the top bar's job in one row that does not wrap. */}
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderTop: '1px solid var(--line)', background: 'var(--card)', flexShrink: 0 }}>
          <button onClick={onClose} title="Discard and go back" aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4, flexShrink: 0 }}>
            <X size={19} />
          </button>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', fontFamily: 'Inter,sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {step + 1}/{steps.length} · {steps[step]}
          </span>
          {step > 0 && (
            <button className="secondary-btn" onClick={goBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, flexShrink: 0 }}>
              <ChevronLeft size={13} /> Back
            </button>
          )}
          {step < steps.length - 1 ? (
            <button className="primary-btn" onClick={goNext}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, flexShrink: 0, opacity: stepOk() ? 1 : 0.55 }}>
              Next <ChevronRight size={13} />
            </button>
          ) : (
            <button className="primary-btn" onClick={send} disabled={sendBlocked} title={sendTitle}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, flexShrink: 0, opacity: sendBlocked ? 0.6 : 1 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} Send
            </button>
          )}
        </div>
      )}

      {egnyteOpen && (
        <EgnyteBrowser onClose={() => setEgnyteOpen(false)}
          onPick={(picked) => { setEgnyteOpen(false); pickFile(picked); }} />
      )}
      {pdfEditOpen && file && (
        <PdfEditor file={file} fileName={file.name} toastErr={toastErr}
          onClose={() => setPdfEditOpen(false)}
          onSave={(edited) => { pickFile(edited); toastOk('PDF updated - place the signature fields again.'); }} />
      )}
      {labelFor && fields.find(f => f.id === labelFor) && (
        <FieldLabelModal field={fields.find(f => f.id === labelFor)} onClose={() => setLabelFor(null)}
          onSave={(patch) => setFields(fs => fs.map(f => f.id === labelFor ? { ...f, ...patch } : f))} />
      )}
      {optsFor && fields.find(f => f.id === optsFor) && (
        <FieldOptionsModal field={fields.find(f => f.id === optsFor)} onClose={() => setOptsFor(null)}
          onSave={(options) => setFields(fs => fs.map(f => f.id === optsFor ? { ...f, options } : f))} />
      )}
    </div>
  );
}

// ── Envelope detail: parties progress + audit timeline + actions ──────────────
function RequestDetailModal({ requestId, onClose, onChanged, toastOk, toastErr }) {
  const [req, setReq] = useState(null);
  const [busy, setBusy] = useState('');
  const [editPid, setEditPid] = useState(null);
  const [pf, setPf] = useState({ name: '', email: '', access_code: '' });
  const load = () => api.getSignRequest(requestId).then(setReq).catch(e => { toastErr(e?.message || 'Load failed'); onClose(); });
  // NOT useEffect(load, ...) - load returns a Promise, and React 19 would call
  // it as the effect's cleanup on unmount ("l is not a function" crash on close).
  useEffect(() => { load(); }, [requestId]);

  async function copyLink(p) {
    try {
      const r = await api.getSignPartyLink(requestId, p.id);
      await navigator.clipboard.writeText(r.url);
      toastOk(r.hasAccessCode
        ? `Link copied. Remember to share the access code (${r.accessCode}) separately.`
        : 'Signing link copied to clipboard.');
    } catch (e) { toastErr(e?.message || 'Could not copy the link.'); }
  }
  async function saveParty(p) {
    if (busy) return; setBusy('fix');
    try {
      // Blank access code = keep the existing one (omit the key entirely)
      const payload = { name: pf.name, email: pf.email };
      if (pf.access_code.trim()) payload.access_code = pf.access_code.trim();
      await api.correctSignParty(requestId, p.id, payload);
      toastOk('Recipient updated' + (pf.email && pf.email !== p.email ? ' - old link disabled, new invite sent.' : '.'));
      setEditPid(null); load(); onChanged();
    } catch (e) { toastErr(e?.message || 'Could not update the recipient.'); }
    setBusy('');
  }

  async function act(kind, fn, okMsg, isErr) {
    if (busy) return; setBusy(kind);
    try {
      const r = await fn();
      const msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      // A call can succeed yet report a bad outcome (e.g. verify returns
      // valid:false = tampered) - that must show as an error, not a green toast.
      if (isErr && isErr(r)) toastErr(msg); else toastOk(msg);
      load(); onChanged();
    }
    catch (e) { toastErr(e?.message || `Could not ${kind}.`); }
    setBusy('');
  }
  const download = () => act('download', async () => {
    const { url } = await api.downloadSign(requestId); window.open(url, '_blank', 'noopener'); return {};
  }, 'Download started.');

  const editingParty = editPid ? (req?.parties || []).find(p => p.id === editPid) : null;
  const dirty = !!editingParty && (pf.name !== editingParty.name || pf.email !== editingParty.email || pf.access_code.trim() !== '');
  const guard = useUnsavedGuard(dirty, onClose, editingParty ? async () => { await saveParty(editingParty); onClose(); } : undefined);
  const sm = req ? (REQ_STATUS[reqStatusKey(req)] || REQ_STATUS.pending) : null;
  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={cardStyle(900, 'min(94dvh, 1020px)')}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileSignature size={16} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{req?.title || '…'}</h3>
          {sm && <span style={chip(sm)}>{sm.label}</span>}
          <button onClick={guard.requestClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {!req ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, padding: '16px 24px' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {req.status === 'pending' && <button className="secondary-btn" disabled={!!busy} onClick={() => act('remind', () => api.remindSign(requestId), r => `Reminded ${r.reminded}.`)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Bell size={12} /> Remind</button>}
              {req.status === 'pending' && <button className="secondary-btn" disabled={!!busy} onClick={() => act('void', () => api.voidSign(requestId), 'Voided.')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-red))' }}><Ban size={12} /> Void</button>}
              {req.hasFinalPdf && <button className="secondary-btn" disabled={!!busy} onClick={download} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={12} /> Sealed PDF</button>}
              {req.hasFinalPdf && <button className="secondary-btn" disabled={!!busy} onClick={() => act('verify', () => api.verifySign(requestId), r => {
                const doc = r.valid ? 'Document untampered' : '⚠ HASH MISMATCH - document was modified!';
                const chain = !r.chainAvailable ? 'audit chain unavailable (pre-dates this feature)'
                  : r.chainValid ? `audit chain verified across ${r.eventCount} events` : '⚠ AUDIT CHAIN BROKEN';
                return `${doc} · ${chain}.`;
              }, r => !r.valid || (r.chainAvailable && !r.chainValid))} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><ShieldCheck size={12} /> Verify Integrity</button>}
            </div>

            <label style={FL}>
              Recipients{req.routing === 'parallel' ? ' - all at once' : ' - in order'}
            </label>
            {(req.parties || []).map((p, i) => {
              const m = PARTY_STATUS[p.status] || PARTY_STATUS.waiting;
              const cc = p.partyRole === 'cc';
              const fixable = req.status === 'pending' && !['signed', 'declined'].includes(p.status);
              return (
                <div key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0' }}>
                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: cc ? 'var(--mist)' : rcolor(i).solid, color: cc ? 'var(--muted)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: cc ? 9 : 11, fontWeight: 800, flexShrink: 0 }}>{cc ? 'CC' : p.ordinal}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>· {p.kind}{cc ? ' · copy only' : ''}{p.hasAccessCode ? ' · 🔒 code' : ''}</span></div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email}{p.declineReason && ` - "${p.declineReason}"`}</div>
                    </div>
                    {fixable && p.kind === 'external' && !cc && (
                      <button className="secondary-btn" disabled={!!busy} onClick={() => copyLink(p)} title="Copy their signing link"
                        style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px' }}><Copy size={11} /> Link</button>
                    )}
                    {fixable && (
                      <button className="secondary-btn" disabled={!!busy} title="Fix their name, email or access code"
                        onClick={() => { setEditPid(editPid === p.id ? null : p.id); setPf({ name: p.name, email: p.email, access_code: '' }); }}
                        style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px' }}><Pencil size={11} /> Edit</button>
                    )}
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: m.fg }}>{p.status === 'signed' && p.signedAt ? `Signed ${p.signedAt.slice(0, 10)}` : cc && p.status !== 'signed' ? '-' : m.label}</span>
                  </div>
                  {editPid === p.id && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 0 10px 32px', alignItems: 'center' }}>
                      <input className="form-input" style={{ fontSize: 12, width: 150 }} placeholder="Full name" value={pf.name} onChange={e => setPf(f => ({ ...f, name: e.target.value }))} />
                      <input className="form-input" style={{ fontSize: 12, width: 200 }} placeholder="email@…" value={pf.email} onChange={e => setPf(f => ({ ...f, email: e.target.value }))} />
                      {p.kind === 'external' && !cc && (
                        <input className="form-input" style={{ fontSize: 12, width: 150 }} placeholder="New access code (blank = keep)" maxLength={40}
                          value={pf.access_code} onChange={e => setPf(f => ({ ...f, access_code: e.target.value }))} />
                      )}
                      <button className="primary-btn" disabled={!!busy} onClick={() => saveParty(p)} style={{ fontSize: 11.5, padding: '5px 12px' }}>Save</button>
                      <button className="secondary-btn" onClick={() => setEditPid(null)} style={{ fontSize: 11.5, padding: '5px 10px' }}>Cancel</button>
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', flexBasis: '100%' }}>
                        Changing the email kills their old link and sends a fresh invite.
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {req.finalSha256 && (
              <div style={{ marginTop: 14, fontSize: 11, color: 'var(--muted)' }}>
                SHA-256: <code style={{ fontSize: 10, wordBreak: 'break-all' }}>{req.finalSha256}</code>
              </div>
            )}

            <div style={{ margin: '18px 0 8px' }}><label style={FL}>Audit trail</label></div>
            {(req.events || []).map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 12, borderBottom: '1px dashed var(--line)' }}>
                <span style={{ color: 'var(--muted)', width: 118, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{(e.at || '').slice(0, 16).replace('T', ' ')}</span>
                <span style={{ fontWeight: 700, width: 78, flexShrink: 0, textTransform: 'capitalize' }}>{e.type}</span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>{e.detail}{e.ip && ` · ${e.ip}`}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={editingParty ? guard.saveAndClose : undefined} saving={guard.saving || busy === 'fix'} />
      )}
    </div>
  );
}

// ── Main E-Sign tab (lives in the Documents module) ──────────────────────────
// Bell/toast deep-links: navSub 'documents-esign' → Inbox,
// 'documents-esign-requests' → Sent.
const NAV_TAB = { 'documents-esign': 'inbox', 'documents-esign-requests': 'requests' };

export default function ESign({ employees = [], entities = [], prefill = null, navSub = '', onPrefillConsumed, onSentRequest, toastOk, toastErr }) {
  const [sub, setSub] = useState(NAV_TAB[navSub] || 'inbox');
  const [inbox, setInbox] = useState(null);
  const [requests, setRequests] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [signParty, setSignParty] = useState(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [editTpl, setEditTpl] = useState(undefined);
  const [reqSearch, setReqSearch] = useState('');
  const [reqFilter, setReqFilter] = useState('all');

  const loadInbox = () => api.mySignatures().then(setInbox).catch(() => setInbox([]));
  const loadRequests = () => api.getSignRequests().then(setRequests).catch(() => setRequests([]));
  const loadTemplates = () => api.getSignTemplates().then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { loadInbox(); loadRequests(); loadTemplates(); }, []);
  // "Open in Nexus" in a Nexus Sign email carries ?request=<id> and must land
  // ON that envelope, not on a list the recipient then has to search (review
  // section 16). The param is consumed once and stripped, so a refresh or a
  // Back doesn't keep reopening the same modal.
  useEffect(() => {
    const rid = new URLSearchParams(window.location.search).get('request');
    if (!rid) return;
    setDetailId(rid);
    const url = new URL(window.location.href);
    url.searchParams.delete('request');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }, []);
  useEffect(() => { if (prefill) setSendOpen(true); }, [prefill]);
  // Switching sub-tabs refetches that list - a doc sent (or signed) after mount
  // must show up without leaving the module.
  const switchSub = (id) => {
    setSub(id);
    if (id === 'inbox') loadInbox();
    else if (id === 'requests') loadRequests();
    else loadTemplates();
  };

  // Notification clicks while already mounted: the window event fires even when
  // the app-level view/sub didn't change (repeat clicks - same pattern as the
  // inventory panels). Leaves the send/sign screens alone if one is open.
  useEffect(() => {
    const onNav = (e) => {
      const t = NAV_TAB[e.detail?.sub];
      if (e.detail?.view === 'documents' && t) switchSub(t);
    };
    window.addEventListener('nexus:navigate', onNav);
    return () => window.removeEventListener('nexus:navigate', onNav);
  }, []);

  const myTurnCount = (inbox || []).filter(x => x.myTurn).length;
  const tabs = [
    ['inbox', `Inbox${myTurnCount ? ` (${myTurnCount})` : ''}`],
    ['requests', 'Sent Requests'],
    ['templates', 'Templates'],
  ];

  const empty = (Icon, text, action) => (
    <div style={{ textAlign: 'center', padding: '52px 20px', color: 'var(--muted)' }}>
      <Icon size={36} style={{ opacity: 0.3, marginBottom: 12 }} />
      <p style={{ fontSize: 13.5, margin: '0 0 16px' }}>{text}</p>
      {action}
    </div>
  );

  // Amber nudge when a pending envelope is running out of runway
  const expiryChip = (expiresOn, status = 'pending') => {
    if (!expiresOn || status !== 'pending') return null;
    // Whole-day UTC difference so this agrees with the backend's UTC-date expiry
    // (was Math.ceil of a 23:59:59 stamp - overstated by one and never hit 'today').
    const dayNum = ms => Math.floor(ms / 86400000);
    const days = dayNum(new Date(`${expiresOn}T00:00:00Z`).getTime()) - dayNum(Date.now());
    if (days < 0 || days > 3) return null;
    return (
      <span style={{ padding: '2px 9px', borderRadius: 14, fontSize: 10.5, fontWeight: 800, background: 'rgba(251,191,36,0.18)', color: '#b45309', whiteSpace: 'nowrap' }}>
        {days <= 0 ? 'Expires today' : `Expires in ${days}d`}
      </span>
    );
  };

  const visibleRequests = (requests || []).filter(r => {
    if (reqFilter !== 'all' && r.status !== reqFilter) return false;
    const q = reqSearch.trim().toLowerCase();
    if (!q) return true;
    return (r.title || '').toLowerCase().includes(q) ||
      (r.parties || []).some(p => (p.name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q));
  });

  // Signing + send wizard REPLACE the tab content in place - the Nexus
  // sidebar/header and HR tabs stay put (not a full-screen portal).
  if (signParty) return (
    <SignModal partyId={signParty} toastOk={toastOk} toastErr={toastErr}
      onClose={() => setSignParty(null)} onDone={() => { setSignParty(null); loadInbox(); loadRequests(); }} />
  );
  if (sendOpen) return (
    <SendWizard templates={templates || []} employees={employees} entities={entities}
      prefill={prefill} onPrefillConsumed={onPrefillConsumed} toastOk={toastOk} toastErr={toastErr}
      onClose={() => { setSendOpen(false); onPrefillConsumed?.(); }}
      onSent={(sent) => { loadRequests(); loadInbox(); onSentRequest?.(sent); }} />
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4, flex: 1, borderBottom: '1px solid var(--line)' }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => switchSub(id)}
              style={{ padding: '9px 14px', fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', background: 'none', border: 'none', borderBottom: `2px solid ${sub === id ? 'var(--pine)' : 'transparent'}`, color: sub === id ? 'var(--ink)' : 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1 }}>
              {label}
            </button>
          ))}
        </div>
        <button className="primary-btn" onClick={() => setSendOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Send size={13} /> Send for Signature
        </button>
      </div>

      {sub === 'inbox' && (
        !inbox ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
        : inbox.length === 0 ? empty(FileSignature, 'Nothing awaiting your signature.')
        : inbox.map(item => (
          <div key={item.partyId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: '1px solid var(--line)', borderLeft: `4px solid ${item.myTurn ? '#fbbf24' : 'var(--line)'}`, borderRadius: 12, marginBottom: 8, background: 'var(--card)' }}>
            <FileSignature size={17} style={{ color: item.myTurn ? '#f59e0b' : 'var(--muted)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>from {item.from}{item.expiresOn && ` · expires ${item.expiresOn}`}</div>
            </div>
            {expiryChip(item.expiresOn)}
            {item.myTurn
              ? <button className="primary-btn" onClick={() => setSignParty(item.partyId)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Review &amp; Sign <ChevronRight size={13} /></button>
              : <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Clock size={12} /> Waiting on others</span>}
          </div>
        ))
      )}

      {sub === 'requests' && (
        !requests ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
        : requests.length === 0 ? empty(Send, 'No signature requests yet.',
            <button className="primary-btn" onClick={() => setSendOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={13} /> Send Your First</button>)
        : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
                <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
                <input className="form-input" style={{ width: '100%', fontSize: 12.5, paddingLeft: 30 }}
                  placeholder="Search title or recipient…" value={reqSearch} onChange={e => setReqSearch(e.target.value)} />
              </div>
              <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
                {[['all', 'All'], ['pending', 'Awaiting'], ['completed', 'Completed'], ['declined', 'Declined'], ['voided', 'Voided'], ['expired', 'Expired']].map(([v, l]) => (
                  <button key={v} onClick={() => setReqFilter(v)}
                    style={{ padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap',
                      border: reqFilter === v ? '1.5px solid var(--pine)' : '1.5px solid var(--line)',
                      background: reqFilter === v ? 'hsla(var(--color-green),0.1)' : 'var(--card)',
                      color: reqFilter === v ? 'var(--pine)' : 'var(--muted)' }}>
                    {l}{v !== 'all' && ` (${requests.filter(r => r.status === v).length})`}
                  </button>
                ))}
              </div>
            </div>
            {visibleRequests.length === 0 && (
              <div style={{ textAlign: 'center', padding: '30px 16px', fontSize: 12.5, color: 'var(--muted)' }}>
                Nothing matches - clear the search or pick another status.
              </div>
            )}
            {visibleRequests.map(r => {
              const m = REQ_STATUS[reqStatusKey(r)] || REQ_STATUS.pending;
              const signers = (r.parties || []).filter(p => p.partyRole !== 'cc');
              const signed = signers.filter(p => p.status === 'signed').length;
              const total = signers.length;
              return (
                <div key={r.id} onClick={() => setDetailId(r.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', border: '1px solid var(--line)', borderLeft: `4px solid ${m.fg}`, borderRadius: 12, marginBottom: 8, background: 'var(--card)', cursor: 'pointer' }}>
                  <FileSignature size={17} style={{ color: m.fg, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                      <span style={{ width: 70, height: 4, borderRadius: 4, background: 'var(--line)', overflow: 'hidden', display: 'inline-block' }}>
                        <span style={{ display: 'block', height: '100%', width: `${total ? (signed / total) * 100 : 0}%`, background: m.fg }} />
                      </span>
                      {signed}/{total} signed · sent {(r.createdAt || '').slice(0, 10)}
                      {r.routing === 'parallel' && ' · all at once'}
                    </div>
                  </div>
                  {expiryChip(r.expiresOn, r.status)}
                  <span style={chip(m)}>{m.label}</span>
                  <ChevronRight size={15} style={{ color: 'var(--muted)' }} />
                </div>
              );
            })}
          </>
        )
      )}

      {sub === 'templates' && (
        !templates ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
        : (
          <>
            {/* Nexus Sign is the signing layer, not a second template manager
                (requirements 10 and 25). Templates are authored once, in the
                Templates tab, which is the only place that has variables,
                department ownership, versioning and Word import. These are the
                legacy signing templates: still usable, no longer added to. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '9px 14px', marginBottom: 12, borderRadius: 9,
              background: 'var(--mist)', border: '1px solid var(--line)',
            }}>
              <Info size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1, minWidth: 220 }}>
                Templates are now created in the <strong>Templates</strong> tab, where they carry
                variables, an owning department and version history. These older signing templates
                still work; new ones are made there.
              </span>
              <button className="secondary-btn" style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-templates' } }))}>
                Go to Templates
              </button>
            </div>
            {templates.length === 0 ? empty(FileText, 'No templates yet - start from the standard Offer / NDA / Handbook set.')
            : templates.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, background: 'var(--card)' }}>
                <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {KIND_LABEL[t.kind] || t.kind} · {(t.roles || []).length} role{(t.roles || []).length === 1 ? '' : 's'} · {(t.body || []).length} paragraphs{(t.attachments || []).length > 0 && ` · ${t.attachments.length} attached doc${t.attachments.length === 1 ? '' : 's'}`}
                  </div>
                </div>
                <button className="secondary-btn" onClick={() => setEditTpl(t)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}><Pencil size={12} /> Edit</button>
                <button className="secondary-btn" title="Duplicate this template"
                  onClick={async () => {
                    try {
                      await api.createSignTemplate({ name: `${t.name} (copy)`, kind: t.kind, entity_id: t.entityId || '', roles: t.roles || [], body: t.body || [], attachments: t.attachments || [] });
                      toastOk(`Duplicated as "${t.name} (copy)".`); loadTemplates();
                    } catch (e) { toastErr(e?.message || 'Could not duplicate.'); }
                  }}
                  style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}><CopyPlus size={12} /> Duplicate</button>
                <button title="Delete" onClick={async () => { try { await api.deleteSignTemplate(t.id); loadTemplates(); } catch (e) { toastErr(e?.message || 'Delete failed (owner grant needed).'); } }}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>
              </div>
            ))}
          </>
        )
      )}

      {detailId && <RequestDetailModal requestId={detailId} toastOk={toastOk} toastErr={toastErr}
        onClose={() => setDetailId(null)} onChanged={loadRequests} />}
      {editTpl !== undefined && <TemplateEditorModal template={editTpl} entities={entities}
        toastOk={toastOk} toastErr={toastErr} onClose={() => setEditTpl(undefined)} onSaved={() => loadTemplates()} />}
    </div>
  );
}
