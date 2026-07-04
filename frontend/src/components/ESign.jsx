import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  FileSignature, Plus, X, Loader2, CheckCircle, XCircle, Clock, Send, Trash2,
  Pencil, FileText, Download, ShieldCheck, Bell, ChevronRight, ChevronLeft,
  ChevronUp, ChevronDown, Eraser, Type, PenTool, Users, AlertTriangle,
  RefreshCw, Ban, Sparkles, UploadCloud, ZoomIn, ZoomOut, ArrowRight,
  CalendarDays, CheckSquare, ALargeSmall, GripVertical,
} from 'lucide-react';
import { api } from '../api';

// ── HR Section C — Native E-Sign (DocuSign-style UX) ──────────────────────────
// Full-screen send wizard (Document → Recipients → Fields → Review) with
// color-coded recipients and a drag/resize field editor; guided signing with a
// START/NEXT tab, progress bar and adopt-signature modal. Backend contracts
// unchanged. PublicSign.jsx reuses SignaturePad + SigningDoc for /sign/{token}.

const FIELD_RE = /\[\[(sign|initials|date|text|check):([a-z0-9_]+)(?::([^\]]*))?\]\]/g;
const MERGE_RE = /\{\{([a-z0-9_]+)\}\}/g;

const REQ_STATUS = {
  pending:   { label: 'Awaiting signatures', fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
  completed: { label: 'Completed',           fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)' },
  declined:  { label: 'Declined',            fg: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)' },
  voided:    { label: 'Voided',              fg: 'var(--muted)',             bg: 'var(--mist)' },
  expired:   { label: 'Expired',             fg: 'var(--muted)',             bg: 'var(--mist)' },
};
const PARTY_STATUS = {
  waiting:  { label: 'Waiting',  fg: 'var(--muted)' },
  notified: { label: 'Notified', fg: 'hsl(var(--color-blue))' },
  viewed:   { label: 'Viewed',   fg: 'hsl(var(--color-orange))' },
  signed:   { label: 'Signed',   fg: 'hsl(var(--color-green))' },
  declined: { label: 'Declined', fg: 'hsl(var(--color-red))' },
};
const KIND_LABEL = {
  offer: 'Offer Letter', nda: 'NDA', direct_deposit: 'Direct Deposit',
  handbook_ack: 'Handbook Ack', w9: 'W-9 / TIN', contractor_agreement: 'Contractor Agreement',
  sow: 'SOW', custom: 'Custom',
};
const MERGE_TOKENS = ['first_name', 'last_name', 'full_name', 'email', 'job_title',
  'department', 'start_date', 'salary', 'company', 'company_legal', 'company_address',
  'signatory', 'manager', 'today'];

// DocuSign-style recipient colors — each signer owns one; their fields inherit it.
const RCOLORS = [
  { solid: '#f59e0b', soft: 'rgba(245,158,11,0.16)' },   // amber
  { solid: '#3b82f6', soft: 'rgba(59,130,246,0.14)' },   // blue
  { solid: '#10b981', soft: 'rgba(16,185,129,0.14)' },   // emerald
  { solid: '#ec4899', soft: 'rgba(236,72,153,0.13)' },   // pink
  { solid: '#8b5cf6', soft: 'rgba(139,92,246,0.14)' },   // violet
  { solid: '#f97316', soft: 'rgba(249,115,22,0.15)' },   // orange
];
const rcolor = (i) => RCOLORS[i % RCOLORS.length];

const FIELD_META = {
  sign:     { label: 'Signature',   Icon: PenTool,      w: 0.24, h: 0.055 },
  initials: { label: 'Initials',    Icon: Type,         w: 0.07, h: 0.035 },
  date:     { label: 'Date signed', Icon: CalendarDays, w: 0.12, h: 0.03 },
  text:     { label: 'Text',        Icon: ALargeSmall,  w: 0.2,  h: 0.032 },
  check:    { label: 'Checkbox',    Icon: CheckSquare,  w: 0.03, h: 0.022 },
};

const SIG_FONTS = ['"Segoe Script"', '"Brush Script MT"', '"Lucida Handwriting"'];

const FL = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.05em', textTransform: 'uppercase' };
const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = (maxWidth) => ({ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth, maxHeight: 'min(94dvh, 880px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' });
const chip = (m) => ({ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: 'nowrap' });
const initialsOf = (name) => (name || '').split(' ').slice(0, 3).map(w => w[0]?.toUpperCase() || '').join('') || '—';

// ── Signature pad — draw or type (with font styles), DocuSign "adopt" flow ────
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
    c.width = 520 * scale; c.height = 170 * scale;
    c.getContext('2d').scale(scale, scale);
    redraw();
  }, [tab]);

  function redraw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 520, 170);
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
    return { x: (e.clientX - r.left) * (520 / r.width), y: (e.clientY - r.top) * (170 / r.height) };
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
      c.width = 520 * scale; c.height = 140 * scale;
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

  return (
    <div style={{ ...overlayStyle, zIndex: 1400 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(600)}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <PenTool size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Adopt your signature</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>This becomes your legal signature on this document.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '18px 24px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>{seg('type', 'Type', Type)}{seg('draw', 'Draw', PenTool)}</div>
          {tab === 'draw' ? (
            <>
              <div style={{ position: 'relative' }}>
                <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up}
                  style={{ width: '100%', height: 170, border: '1.5px dashed var(--line)', borderRadius: 12, touchAction: 'none', cursor: 'crosshair', background: '#fff' }} />
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
    </div>
  );
}

// ── PDF renderer (pdfjs) — takes a File OR a URL; overlay via render-prop ─────
// Passing the File's bytes directly (not fetch(blobUrl)) sidesteps CSP blocks
// on blob: fetches — the "Failed to fetch" bug in v1.
function PdfDoc({ url, file, zoom = 1, renderOverlay }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState('');
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
        if (live) setPages(out);
      } catch (e) { if (live) setError(e?.message || 'Could not render the PDF.'); }
    })();
    return () => { live = false; };
  }, [url, file]);

  if (error) return <div style={{ fontSize: 13, color: 'hsl(var(--color-red))', padding: 16, display: 'flex', gap: 8, alignItems: 'center' }}><AlertTriangle size={15} /> {error}</div>;
  if (!pages) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /><div style={{ fontSize: 12, marginTop: 8 }}>Rendering document…</div></div>;
  return (
    <div style={{ display: 'grid', gap: 26, justifyItems: 'center' }}>
      {pages.map((p, i) => (
        <div key={i}
          style={{ position: 'relative', width: `${Math.round(zoom * 100)}%`, maxWidth: 980, boxShadow: '0 2px 12px rgba(0,0,0,0.14)', borderRadius: 4, background: '#fff' }}>
          <img src={p.dataUrl} alt={`Page ${i + 1}`} style={{ width: '100%', display: 'block', borderRadius: 4 }} draggable={false} />
          {renderOverlay?.(i)}
          <span style={{ position: 'absolute', top: -19, right: 2, fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>Page {i + 1} of {pages.length}</span>
        </div>
      ))}
    </div>
  );
}

// ── Guided signing screen — progress, START/NEXT tab, yellow sign-here tabs ───
// Shared by the internal modal AND the public /sign/{token} page.
export function SigningDoc({ payload, busy, onSubmit, onDecline }) {
  const [sig, setSig] = useState(null);
  const [padOpen, setPadOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [values, setValues] = useState({});
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const fieldRefs = useRef({});
  const myRole = payload.myRole;
  const isTemplate = payload.source === 'template';
  const setVal = (k, v) => setValues(p => ({ ...p, [k]: v }));

  // Every actionable field of mine, in document order, with a completion check.
  const tasks = useMemo(() => {
    const out = [];
    if (isTemplate) {
      (payload.body || []).forEach((para, pi) => {
        for (const m of String(para).matchAll(FIELD_RE)) {
          const [, type, , label = ''] = m;
          const role = m[2];
          if (role !== myRole) continue;
          if (type === 'sign') out.push({ id: `sig-${pi}-${m.index}`, type: 'sign' });
          else if (type === 'check') out.push({ id: `check:${label}`, type: 'check', label });
          else if (type === 'text') out.push({ id: `text:${label}`, type: 'text', label });
        }
      });
    } else {
      (payload.fields || []).filter(f => f.role === myRole).forEach(f => {
        if (['sign', 'check', 'text'].includes(f.type)) out.push({ id: f.id, type: f.type, label: f.label || '' });
      });
    }
    // Packet documents (template attachments) carry their own fields
    for (const d of payload.documents || []) {
      (d.fields || []).filter(f => f.role === myRole).forEach(f => {
        if (['sign', 'check', 'text'].includes(f.type)) out.push({ id: f.id, type: f.type, label: f.label || '' });
      });
    }
    return out;
  }, [payload, myRole, isTemplate]);

  const isDone = (t) => t.type === 'sign' ? !!sig : t.type === 'check' ? !!values[t.id] : String(values[t.id] || '').trim() !== '';
  const required = tasks.filter(t => t.type !== 'text');
  const doneCount = required.filter(isDone).length;
  const allDone = doneCount === required.length;
  const canFinish = payload.myTurn && consent && allDone;
  const nextTask = tasks.find(t => t.type !== 'text' && !isDone(t));

  const jumpNext = () => {
    const el = nextTask && fieldRefs.current[nextTask.id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 380 });
    }
  };

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
    return <div key={pi} style={{ margin: '0 0 13px', fontSize: 14.5, lineHeight: 1.7 }}>{parts}</div>;
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
        if (f.type === 'date' && mine) {
          return <span key={f.id} style={{ ...st, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--muted)', border: '1px dotted #d1d5db', borderRadius: 4, paddingLeft: 4, background: 'rgba(255,255,255,0.6)' }}>{sig ? new Date().toISOString().slice(0, 10) : 'date signed'}</span>;
        }
        if (f.type === 'initials' && mine) {
          return <span key={f.id} style={{ ...st, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '"Segoe Script",cursive', fontSize: 12, border: '1px dotted #d1d5db', borderRadius: 4, background: 'rgba(255,255,255,0.6)' }}>{initialsOf(payload.myName)}</span>;
        }
        return <span key={f.id} style={{ ...st, border: '1px dashed #d1d5db', borderRadius: 4, background: 'rgba(0,0,0,0.03)' }} title={`${f.type} — ${(payload.parties || []).find(p => p.roleKey === f.role)?.name || 'other signer'}`} />;
      })}
    </>
  );

  return (
    <div>
      {/* Sticky action bar — consent + progress + Finish, DocuSign style */}
      {payload.myTurn && (
        <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', boxShadow: '0 2px 8px rgba(0,0,0,0.07)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', flex: 1, minWidth: 240 }}>
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ width: 16, height: 16, flexShrink: 0, accentColor: 'var(--pine)' }} />
            <span>I agree to use electronic records &amp; signatures. <span title={payload.consentText} style={{ textDecoration: 'underline dotted', cursor: 'help', color: 'var(--muted)' }}>Details</span></span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: allDone ? 'hsl(var(--color-green))' : 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 90, height: 5, borderRadius: 4, background: 'var(--line)', overflow: 'hidden', display: 'inline-block' }}>
                <span style={{ display: 'block', height: '100%', width: `${required.length ? (doneCount / required.length) * 100 : 100}%`, background: allDone ? 'hsl(var(--color-green))' : '#fbbf24', transition: 'width .3s' }} />
              </span>
              {doneCount}/{required.length}
            </div>
            <button onClick={() => setDeclineOpen(true)} disabled={busy} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>Decline</button>
            <button className="primary-btn" disabled={!canFinish || busy}
              onClick={() => onSubmit({ consent, signature_kind: sig?.kind === 'drawn' ? 'drawn' : 'typed', signature_data: sig?.data || payload.myName, field_values: values })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: canFinish && !busy ? 1 : 0.5, fontSize: 13 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Finish
            </button>
          </div>
        </div>
      )}

      {!payload.myTurn && payload.myStatus !== 'signed' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '11px 15px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)', color: 'hsl(var(--color-blue))', fontSize: 13, marginBottom: 14 }}>
          <Clock size={15} /> It isn't your turn yet — you'll be notified when it is. You can review the document below.
        </div>
      )}
      {payload.message && (
        <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', marginBottom: 14 }}>“{payload.message}”</div>
      )}

      <div style={{ position: 'relative' }}>
        {/* Floating START / NEXT guide tab */}
        {payload.myTurn && nextTask && (
          <button onClick={jumpNext}
            style={{ position: 'sticky', top: 76, zIndex: 15, float: 'left', marginLeft: -14, display: 'inline-flex', alignItems: 'center', gap: 5, background: '#fbbf24', color: '#78350f', border: 'none', fontWeight: 800, fontSize: 12, padding: '8px 14px 8px 10px', cursor: 'pointer', fontFamily: 'Inter,sans-serif', borderRadius: '0 8px 8px 0', boxShadow: '0 2px 8px rgba(245,158,11,0.5)' }}>
            {doneCount === 0 ? 'START' : 'NEXT'} <ArrowRight size={13} />
          </button>
        )}
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: isTemplate ? '30px 38px' : '24px 12px', background: isTemplate ? '#fff' : 'var(--mist)', color: '#111827' }}>
          {isTemplate
            ? (payload.body || []).map(renderPara)
            : <PdfDoc url={payload.pdfUrl} renderOverlay={signingOverlay(payload.fields)} />}
        </div>
        {/* Packet documents — attached PDFs signed in the same session */}
        {(payload.documents || []).map((d, di) => (
          <div key={di} style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FileText size={13} /> {d.name || `Document ${di + 2}`}
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '24px 12px', background: 'var(--mist)' }}>
              <PdfDoc url={d.pdfUrl} renderOverlay={signingOverlay(d.fields)} />
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

      {declineOpen && (
        <div style={{ ...overlayStyle, zIndex: 1400 }} onClick={e => e.target === e.currentTarget && setDeclineOpen(false)}>
          <div style={cardStyle(440)}>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Decline to sign</h3>
            </div>
            <div style={{ padding: '16px 22px' }}>
              <label style={FL}>Reason (shared with the sender)</label>
              <textarea className="form-input" rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
                value={declineReason} onChange={e => setDeclineReason(e.target.value)} autoFocus />
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setDeclineOpen(false)}>Back</button>
              <button className="primary-btn" disabled={busy} onClick={() => onDecline(declineReason)}
                style={{ background: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <XCircle size={14} /> Decline
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Internal signing — full-screen, not a cramped modal ───────────────────────
function SignModal({ partyId, onClose, onDone, toastOk, toastErr }) {
  const [payload, setPayload] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.mySignRender(partyId).then(setPayload)
      .catch(e => { toastErr(e?.message || 'Could not load the document.'); onClose(); });
  }, [partyId]);

  async function submit(data) {
    setBusy(true);
    try {
      const r = await api.mySignSubmit(partyId, data);
      toastOk(r.status === 'completed' ? 'Signed — all parties done, document sealed.' : `Signed. Next: ${r.next}.`);
      onDone();
    } catch (e) { toastErr(e?.message || 'Could not sign.'); setBusy(false); }
  }
  async function decline(reason) {
    setBusy(true);
    try { await api.mySignDecline(partyId, { reason }); toastOk('Declined.'); onDone(); }
    catch (e) { toastErr(e?.message || 'Could not decline.'); setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg, #f3f4f6)', zIndex: 1200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', flexShrink: 0 }}>
        <FileSignature size={18} style={{ color: 'var(--pine)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{payload?.title || 'Loading…'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Review &amp; sign</div>
        </div>
        <button className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><X size={14} /> Close</button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '20px clamp(12px, 6vw, 60px)' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          {!payload
            ? <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /></div>
            : <SigningDoc payload={payload} busy={busy} onSubmit={submit} onDecline={decline} />}
        </div>
      </div>
    </div>
  );
}

// ── Template editor — human block editor, no raw tokens to type ───────────────
// The body is edited as BLOCKS (paragraphs + visual field rows) and serialized
// back to the same paragraph/token format the backend already understands.
// Templates can also carry ATTACHED PDFs (handbook, policies…) with fields
// placed once here — every send bundles them into one signed packet.

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

// Place fields on an attached PDF — same interaction as the send wizard's
// editor, but saved onto the template so every send reuses the placement.
function AttachmentPlacer({ attachment, roles, onSave, onClose, toastErr }) {
  const [url, setUrl] = useState('');
  const [fields, setFields] = useState(attachment.fields || []);
  const [activeRole, setActiveRole] = useState(0);
  const [activeType, setActiveType] = useState('sign');
  const dragState = useRef(null);

  useEffect(() => {
    api.getSignAttachmentUrl(attachment.path).then(r => setUrl(r.url))
      .catch(e => { toastErr(e?.message || 'Could not load the PDF.'); onClose(); });
  }, [attachment.path]);

  const roleKey = (i) => roles[i]?.key || roles[0]?.key || 'employee';
  function place(page, x, y, type = activeType) {
    const meta = FIELD_META[type] || FIELD_META.sign;
    setFields(fs => [...fs, { id: `a${Date.now()}${fs.length}`, role: roleKey(activeRole), type, page,
      x: Math.min(0.98 - meta.w, Math.max(0, x - meta.w / 2)),
      y: Math.min(0.98 - meta.h, Math.max(0, y - meta.h / 2)), w: meta.w, h: meta.h, required: true }]);
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
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); place(pageIdx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }}>
      {fields.filter(f => f.page === pageIdx).map(f => {
        const c = rcolor(roleIdx(f.role));
        const M = FIELD_META[f.type];
        return (
          <div key={f.id} onPointerDown={(e) => startDrag(e, f, 'move')} onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`,
              border: `2px solid ${c.solid}`, background: c.soft, borderRadius: 5, cursor: 'grab', touchAction: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter,sans-serif' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: c.solid, display: 'inline-flex', alignItems: 'center', gap: 4, pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <M.Icon size={10} /> {M.label}
            </span>
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
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg, #f3f4f6)', zIndex: 1350, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>
        <FileText size={16} style={{ color: 'var(--pine)' }} />
        <span style={{ fontWeight: 800, fontSize: 14, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.name}</span>
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {roles.map((r, i) => (
            <button key={r.key} onClick={() => setActiveRole(i)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer',
                border: activeRole === i ? `2px solid ${rcolor(i).solid}` : '1.5px solid var(--line)', background: activeRole === i ? rcolor(i).soft : 'var(--card)', color: 'var(--ink)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: rcolor(i).solid }} />{r.label || r.key}
            </button>
          ))}
          {Object.entries(FIELD_META).map(([ft, M]) => (
            <button key={ft} onClick={() => setActiveType(ft)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 8, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer',
                border: activeType === ft ? `2px solid ${rcolor(activeRole).solid}` : '1.5px solid var(--line)', background: activeType === ft ? rcolor(activeRole).soft : 'var(--card)', color: 'var(--ink)' }}>
              <M.Icon size={12} /> {M.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: fields.length ? 'hsl(var(--color-green))' : 'var(--muted)' }}>{fields.length} placed</span>
        <button className="secondary-btn" onClick={onClose} style={{ fontSize: 12.5 }}>Cancel</button>
        <button className="primary-btn" onClick={() => { onSave(fields); onClose(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <CheckCircle size={13} /> Save fields
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '26px 20px' }}>
        {url ? <PdfDoc url={url} renderOverlay={overlay} />
             : <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>}
      </div>
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
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const paraRefs = useRef({});

  const setBlock = (i, patch) => setBlocks(bs => bs.map((b, j) => j === i ? { ...b, ...patch } : b));
  const rmBlock = (i) => setBlocks(bs => bs.length > 1 ? bs.filter((_, j) => j !== i) : bs);
  const movBlock = (i, dir) => setBlocks(bs => {
    const j = i + dir; if (j < 0 || j >= bs.length) return bs;
    const next = [...bs]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const addBlock = (type) => setBlocks(bs => [...bs,
    type === 'para' ? { type: 'para', text: '' }
      : { type, role: roles[0]?.key || 'employee', label: type === 'check' ? 'I agree' : type === 'text' ? 'Label' : '' }]);
  const insertMerge = (i, token) => {
    const ta = paraRefs.current[i];
    const cur = blocks[i]?.text || '';
    const at = ta ? ta.selectionStart : cur.length;
    setBlock(i, { text: cur.slice(0, at) + `{{${token}}}` + cur.slice(at) });
    setTimeout(() => { ta?.focus(); }, 0);
  };
  const setRole = (i, k, v) => setRoles(rs => rs.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const roleIdx = (key) => Math.max(0, roles.findIndex(r => r.key === key));

  async function uploadAttachment(fl) {
    if (!fl) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', fl);
      const a = await api.uploadSignAttachment(form);
      setAttachments(as => [...as, a]);
      toastOk(`Attached ${a.name} (${a.pages} page${a.pages === 1 ? '' : 's'}). Now place its signature fields.`);
    } catch (e) { toastErr(e?.message || 'Upload failed.'); }
    setUploading(false);
  }

  async function save() {
    if (busy) return; setBusy(true);
    const data = { name, kind, entity_id: entityId, roles: roles.filter(r => r.key.trim()),
      body: blocksToBody(blocks), attachments };
    try {
      const saved = template?.id ? await api.updateSignTemplate(template.id, data) : await api.createSignTemplate(data);
      toastOk('Template saved.'); onSaved(saved); onClose();
    } catch (e) { toastErr(e?.message || 'Could not save template.'); setBusy(false); }
  }

  const fieldBlockMeta = { sign: ['Signature', PenTool], date: ['Date signed', CalendarDays],
    initials: ['Initials', Type], check: ['Checkbox', CheckSquare], text: ['Text field', ALargeSmall] };

  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(820)}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileText size={17} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{template?.id ? 'Edit template' : 'New template'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
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
                  const key = r.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `signer${i + 1}`;
                  setRole(i, 'label', label); if (!r.key) setRole(i, 'key', key);
                }} />
              <button onClick={() => setRoles(rs => rs.filter((_, j) => j !== i).map((x, j) => ({ ...x, order: j + 1 })))}
                disabled={roles.length === 1}
                style={{ background: 'none', border: 'none', color: roles.length === 1 ? 'var(--line)' : 'hsl(var(--color-red))', cursor: roles.length === 1 ? 'default' : 'pointer', display: 'flex', padding: 4 }}><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="secondary-btn" onClick={() => setRoles(rs => [...rs, { key: `signer${rs.length + 1}`, label: '', order: rs.length + 1 }])}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add signer role</button>

          <div style={{ margin: '18px 0 6px' }}><label style={FL}>Document</label></div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 14px', background: '#fff' }}>
            {blocks.map((b, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingTop: 4 }}>
                  <button onClick={() => movBlock(i, -1)} disabled={i === 0} style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 1 }}><ChevronUp size={12} /></button>
                  <button onClick={() => movBlock(i, 1)} disabled={i === blocks.length - 1} style={{ background: 'none', border: 'none', cursor: i === blocks.length - 1 ? 'default' : 'pointer', color: i === blocks.length - 1 ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 1 }}><ChevronDown size={12} /></button>
                </div>
                {b.type === 'para' ? (
                  <div style={{ flex: 1 }}>
                    <textarea ref={el => { paraRefs.current[i] = el; }} className="form-input" rows={Math.max(2, Math.ceil((b.text || '').length / 90))}
                      value={b.text} placeholder="Write a paragraph… use Insert to drop in auto-filled details"
                      onChange={e => setBlock(i, { text: e.target.value })}
                      style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13, lineHeight: 1.6, color: '#111827' }} />
                    <select className="form-input" value="" onChange={e => e.target.value && insertMerge(i, e.target.value)}
                      style={{ marginTop: 4, fontSize: 11.5, padding: '3px 8px', height: 28, width: 210, color: 'var(--muted)' }}>
                      <option value="">✨ Insert auto-filled detail…</option>
                      {Object.entries(FRIENDLY_MERGE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', border: `1.5px solid ${rcolor(roleIdx(b.role)).solid}`, background: rcolor(roleIdx(b.role)).soft, borderRadius: 10, padding: '9px 12px' }}>
                    {(() => { const [lbl, Icon] = fieldBlockMeta[b.type]; return (<>
                      <Icon size={14} style={{ color: rcolor(roleIdx(b.role)).solid }} />
                      <span style={{ fontSize: 12.5, fontWeight: 800, color: rcolor(roleIdx(b.role)).solid }}>{lbl}</span>
                    </>); })()}
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>for</span>
                    <select className="form-input" value={b.role} onChange={e => setBlock(i, { role: e.target.value })}
                      style={{ fontSize: 12, padding: '3px 8px', height: 28, width: 170 }}>
                      {roles.filter(r => r.key).map(r => <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
                    </select>
                    {(b.type === 'check' || b.type === 'text') && (
                      <input className="form-input" value={b.label} placeholder={b.type === 'check' ? 'Checkbox text' : 'Field label'}
                        onChange={e => setBlock(i, { label: e.target.value })} style={{ flex: 1, minWidth: 140, fontSize: 12, padding: '3px 8px', height: 28 }} />
                    )}
                  </div>
                )}
                <button onClick={() => rmBlock(i)} style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 4, marginTop: 4 }}><Trash2 size={13} /></button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <button className="secondary-btn" onClick={() => addBlock('para')} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px' }}><Plus size={11} /> Paragraph</button>
              {Object.entries(fieldBlockMeta).map(([ft, [lbl, Icon]]) => (
                <button key={ft} className="secondary-btn" onClick={() => addBlock(ft)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px' }}>
                  <Icon size={11} /> {lbl}
                </button>
              ))}
            </div>
          </div>

          <div style={{ margin: '18px 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ ...FL, marginBottom: 0, flex: 1 }}>Attached documents — signed together as one packet</label>
            <label className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              {uploading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <UploadCloud size={13} />} Attach PDF
              <input type="file" accept="application/pdf" style={{ display: 'none' }}
                onChange={e => { uploadAttachment(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {attachments.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 10, padding: '12px 14px' }}>
              None yet — attach the handbook, NDA or policy PDFs and this template sends them all as one signature packet.
            </div>
          ) : attachments.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 6 }}>
              <FileText size={14} style={{ color: 'var(--pine)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                <div style={{ fontSize: 11, color: (a.fields || []).length ? 'var(--muted)' : '#b45309' }}>
                  {a.pages} page{a.pages === 1 ? '' : 's'} · {(a.fields || []).length
                    ? `${a.fields.length} field${a.fields.length === 1 ? '' : 's'} placed`
                    : 'no fields yet — signers will only view it'}
                </div>
              </div>
              <button className="secondary-btn" onClick={() => setPlacerIdx(i)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px' }}>
                <PenTool size={11} /> Place fields
              </button>
              <button onClick={() => setAttachments(as => as.filter((_, j) => j !== i))}
                style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 4 }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save template
          </button>
        </div>
      </div>
      {placerIdx !== null && attachments[placerIdx] && (
        <AttachmentPlacer attachment={attachments[placerIdx]} roles={roles.filter(r => r.key)}
          toastErr={toastErr} onClose={() => setPlacerIdx(null)}
          onSave={(fields) => setAttachments(as => as.map((a, j) => j === placerIdx ? { ...a, fields } : a))} />
      )}
    </div>
  );
}

// ── Send wizard — full-screen, DocuSign-style: Doc → Recipients → Fields → Send
function SendWizard({ templates, employees, entities, prefill, onClose, onSent, toastOk, toastErr }) {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState(prefill ? 'template' : '');
  const [templateId, setTemplateId] = useState('');
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [subjectId, setSubjectId] = useState(prefill?.candidateId ? `c:${prefill.candidateId}` : '');
  const [candidates, setCandidates] = useState([]);
  const [entityId, setEntityId] = useState(entities[0]?.id || '');
  const [title, setTitle] = useState(prefill?.title || '');
  const [message, setMessage] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [merge, setMerge] = useState({});
  const [parties, setParties] = useState(prefill?.parties?.map(p => ({ ...p })) || []);
  const [busy, setBusy] = useState(false);
  // Field editor state (pdf mode)
  const [fields, setFields] = useState([]);
  const [activeRecipient, setActiveRecipient] = useState(0);
  const [activeType, setActiveType] = useState('sign');
  const [zoom, setZoom] = useState(1);
  const dragState = useRef(null);   // {fieldId, mode:'move'|'resize', rect, startX, startY, orig}

  useEffect(() => { api.getCandidates().then(setCandidates).catch(() => setCandidates([])); }, []);

  const tpl = templates.find(t => t.id === templateId);
  const isPdf = source === 'pdf';

  // PDF-mode recipients get invisible auto role keys — fields belong to PEOPLE,
  // not typed role strings (the v1 mistake).
  const withRoles = parties.map((p, i) => ({ ...p, role_key: isPdf ? `r${i + 1}` : p.role_key, ordinal: i + 1 }));

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
    setParties((t.roles || []).map(r => {
      const kept = prefill?.parties?.find(p => p.role_key === r.key);
      return kept || { role_key: r.key, roleLabel: r.label || r.key, name: '', email: '', kind: 'internal' };
    }));
  }
  function pickFile(fl) {
    if (!fl) return;
    if (fl.type !== 'application/pdf') { toastErr('Choose a PDF file.'); return; }
    setFile(fl); setSource('pdf'); setTemplateId(''); setFields([]);
    setTitle(t => t || fl.name.replace(/\.pdf$/i, ''));
    setParties(ps => ps.length ? ps : [{ role_key: 'r1', name: '', email: '', kind: 'internal' }]);
  }

  const setParty = (i, k, v) => setParties(ps => ps.map((p, j) => j === i ? { ...p, [k]: v } : p));
  const movParty = (i, dir) => setParties(ps => {
    const j = i + dir; if (j < 0 || j >= ps.length) return ps;
    const next = [...ps]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const rmParty = (i) => {
    setParties(ps => ps.filter((_, j) => j !== i));
    if (isPdf) {
      // Re-key fields so they keep pointing at the same people after removal
      setFields(fs => fs.filter(f => f.role !== `r${i + 1}`).map(f => {
        const n = Number(f.role.slice(1));
        return n > i + 1 ? { ...f, role: `r${n - 1}` } : f;
      }));
      setActiveRecipient(a => Math.max(0, Math.min(a, parties.length - 2)));
    }
  };
  const pickEmployee = (i, id) => {
    const e = employees.find(x => x.id === id);
    if (e) setParties(ps => ps.map((p, j) => j === i
      ? { ...p, name: `${e.firstName} ${e.lastName}`.trim(), email: e.workEmail, kind: 'internal' } : p));
  };

  // ── Field placement (click OR drag from palette; move + resize on page) ─────
  function placeField(page, x, y, type = activeType) {
    const meta = FIELD_META[type] || FIELD_META.sign;
    setFields(fs => [...fs, {
      id: `f${Date.now()}${fs.length}`, role: `r${activeRecipient + 1}`, type, page,
      x: Math.min(0.98 - meta.w, Math.max(0, x - meta.w / 2)),
      y: Math.min(0.98 - meta.h, Math.max(0, y - meta.h / 2)),
      w: meta.w, h: meta.h, required: true,
    }]);
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

  const recipIdx = (role) => Math.max(0, Number(String(role).slice(1)) - 1);
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
              <M.Icon size={10} /> {M.label}
            </span>
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
  const steps = ['Document', 'Recipients', isPdf ? 'Place fields' : 'Preview', 'Review & send'];
  const stepOk = () => {
    if (step === 0) return source === 'template' ? !!tpl : !!file;
    if (step === 1) return parties.length > 0 && parties.every(p => p.name.trim() && /@/.test(p.email));
    if (step === 2) return isPdf ? fields.length > 0 : true;
    return true;
  };
  const stepHint = () => {
    if (step === 0) return 'Pick a template or upload a PDF first.';
    if (step === 1) return 'Every recipient needs a name and a valid email.';
    if (step === 2 && isPdf) return 'Drag at least one field onto the document.';
    return '';
  };

  async function send() {
    if (busy) return; setBusy(true);
    const subject = subjectId.startsWith('e:') ? { employee_id: subjectId.slice(2) }
      : subjectId.startsWith('c:') ? { candidate_id: subjectId.slice(2) } : {};
    try {
      let sent;
      if (source === 'template') {
        sent = await api.sendSignRequest({
          template_id: tpl.id, title: title.trim(), ...subject, entity_id: entityId,
          message, expires_on: expiresOn,
          merge: Object.fromEntries(Object.entries(merge).filter(([, v]) => String(v).trim())),
          parties: withRoles.map(p => ({ role_key: p.role_key, name: p.name, email: p.email, kind: p.kind, ordinal: p.ordinal })),
        });
      } else {
        const form = new FormData();
        form.append('file', file);
        form.append('payload', JSON.stringify({
          title: title.trim() || file.name,
          ...(subject.employee_id ? { employeeId: subject.employee_id } : {}),
          ...(subject.candidate_id ? { candidateId: subject.candidate_id } : {}),
          entityId, message, expiresOn, fields,
          parties: withRoles.map(p => ({ roleKey: p.role_key, name: p.name, email: p.email, kind: p.kind, ordinal: p.ordinal })),
        }));
        sent = await api.sendSignPdf(form);
      }
      toastOk(`Sent "${sent.title}" to ${sent.parties.length} signer${sent.parties.length === 1 ? '' : 's'}.`);
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
            <M.Icon size={type === 'sign' ? 13 : 10} /> {M.label}{label ? ` · ${label}` : ''} — {withRoles.find(p => p.role_key === role)?.name || (tpl?.roles || []).find(r => r.key === role)?.label || role}
          </span>
        </span>);
      last = m.index + m[0].length;
    }
    if (last < resolved.length) parts.push(<span key="end">{resolved.slice(last)}</span>);
    const unresolvedHere = [...resolved.matchAll(MERGE_RE)].length > 0;
    return <div key={pi} style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.7, background: unresolvedHere ? 'rgba(251,191,36,0.09)' : 'transparent', borderRadius: 6 }}>{parts}</div>;
  };
  const unresolvedTokens = useMemo(() => {
    if (!tpl) return [];
    const un = new Set();
    for (const para of tpl.body || [])
      for (const m of String(para).replace(MERGE_RE, (m0, k) => previewMerge[k] || m0).matchAll(MERGE_RE)) un.add(m[1]);
    return [...un];
  }, [tpl, previewMerge]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg, #f3f4f6)', zIndex: 1200, display: 'flex', flexDirection: 'column' }}>
      {/* Top bar: title + step pills + nav */}
      <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>
        <button onClick={onClose} title="Discard" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 6 }}><X size={19} /></button>
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
          {step > 0 && <button className="secondary-btn" onClick={() => setStep(s => s - 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}><ChevronLeft size={13} /> Back</button>}
          {step < 3 ? (
            <button className="primary-btn" onClick={() => stepOk() ? setStep(s => s + 1) : toastErr(stepHint())}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, opacity: stepOk() ? 1 : 0.55 }}>
              Next <ChevronRight size={13} />
            </button>
          ) : (
            <button className="primary-btn" onClick={send} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: busy ? 0.6 : 1 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} Send
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* STEP 0 — Document */}
        {step === 0 && (
          <div style={{ maxWidth: 980, margin: '0 auto', padding: '26px 18px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
              <div>
                <label style={FL}>Start from a template</label>
                <div style={{ display: 'grid', gap: 8 }}>
                  {templates.filter(t => t.status === 'active').map(t => (
                    <button key={t.id} onClick={() => pickTemplate(t)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif',
                        background: 'var(--card)', border: templateId === t.id && source === 'template' ? '2px solid var(--pine)' : '1.5px solid var(--line)' }}>
                      <FileText size={17} style={{ color: 'var(--pine)', flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{t.name}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{KIND_LABEL[t.kind] || t.kind} · {(t.roles || []).length} signer role{(t.roles || []).length === 1 ? '' : 's'}{(t.attachments || []).length > 0 && ` · ${t.attachments.length} attached doc${t.attachments.length === 1 ? '' : 's'}`}</span>
                      </span>
                      {templateId === t.id && source === 'template' && <CheckCircle size={17} style={{ color: 'var(--pine)' }} />}
                    </button>
                  ))}
                  {templates.filter(t => t.status === 'active').length === 0 && (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 16px', border: '1.5px dashed var(--line)', borderRadius: 12 }}>
                      No templates yet — add them in the Templates tab, or upload a PDF →
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label style={FL}>Or upload a PDF</label>
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
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>Drop a PDF here</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>or click to browse</span>
                    </>
                  )}
                  <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={e => pickFile(e.target.files?.[0])} />
                </label>

                <div style={{ marginTop: 18, display: 'grid', gap: 12 }}>
                  <div>
                    <label style={FL}>About (person — fills merge fields)</label>
                    <select className="form-input" style={{ width: '100%' }} value={subjectId} onChange={e => setSubjectId(e.target.value)}>
                      <option value="">—</option>
                      <optgroup label="Employees">
                        {employees.map(e => <option key={e.id} value={`e:${e.id}`}>{e.firstName} {e.lastName} ({e.employeeCode})</option>)}
                      </optgroup>
                      <optgroup label="Candidates">
                        {candidates.filter(c => !c.employeeId).map(c => <option key={c.id} value={`c:${c.id}`}>{c.firstName} {c.lastName} — {c.roleTitle || 'candidate'}</option>)}
                      </optgroup>
                    </select>
                  </div>
                  <div>
                    <label style={FL}>Company</label>
                    <select className="form-input" style={{ width: '100%' }} value={entityId} onChange={e => setEntityId(e.target.value)}>
                      {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 1 — Recipients */}
        {step === 1 && (
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '26px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <Users size={16} style={{ color: 'var(--pine)' }} />
              <span style={{ fontSize: 14, fontWeight: 800 }}>Who signs?</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>— they sign in this order, one after another</span>
            </div>
            {parties.map((p, i) => {
              const c = rcolor(i);
              return (
                <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 10 }}>
                    <button onClick={() => movParty(i, -1)} disabled={i === 0} style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 2 }}><ChevronUp size={14} /></button>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: c.solid, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 800 }}>{i + 1}</span>
                    <button onClick={() => movParty(i, 1)} disabled={i === parties.length - 1} style={{ background: 'none', border: 'none', cursor: i === parties.length - 1 ? 'default' : 'pointer', color: i === parties.length - 1 ? 'var(--line)' : 'var(--muted)', display: 'flex', padding: 2 }}><ChevronDown size={14} /></button>
                  </div>
                  <div style={{ flex: 1, border: '1.5px solid var(--line)', borderLeft: `4px solid ${c.solid}`, borderRadius: 12, padding: '13px 15px', background: 'var(--card)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                      {p.roleLabel && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: c.solid }}>{p.roleLabel}</span>}
                      <div style={{ flex: 1 }} />
                      <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid var(--line)', overflow: 'hidden' }}>
                        {[['internal', 'Teammate'], ['external', 'External']].map(([v, l]) => (
                          <button key={v} onClick={() => setParty(i, 'kind', v)}
                            style={{ padding: '4px 12px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: p.kind === v ? 'var(--pine)' : 'var(--card)', color: p.kind === v ? '#fff' : 'var(--muted)' }}>{l}</button>
                        ))}
                      </div>
                      {!tpl && parties.length > 1 && (
                        <button onClick={() => rmParty(i)} title="Remove" style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 3 }}><Trash2 size={14} /></button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <input className="form-input" placeholder="Full name" value={p.name} onChange={e => setParty(i, 'name', e.target.value)} />
                      <input className="form-input" placeholder="email@…" value={p.email} onChange={e => setParty(i, 'email', e.target.value)} />
                    </div>
                    {p.kind === 'internal' && (
                      <select className="form-input" style={{ marginTop: 8, width: '100%', fontSize: 12 }} value=""
                        onChange={e => e.target.value && pickEmployee(i, e.target.value)}>
                        <option value="">↳ pick a teammate to fill name + email…</option>
                        {employees.filter(e => e.workEmail).map(e => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} — {e.workEmail}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
            {!tpl && (
              <button className="secondary-btn" onClick={() => setParties(ps => [...ps, { role_key: `r${ps.length + 1}`, name: '', email: '', kind: 'internal' }])}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 38 }}><Plus size={13} /> Add recipient</button>
            )}
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 14, marginLeft: 38 }}>
              Teammates get a bell notification and sign inside Nexus. External recipients get a secure email link — no login needed.
            </p>
          </div>
        )}

        {/* STEP 2 — Field editor (pdf) */}
        {step === 2 && isPdf && (
          <div style={{ display: 'flex', height: '100%', minHeight: 0, alignItems: 'stretch' }}>
            <div style={{ width: 232, borderRight: '1px solid var(--line)', background: 'var(--card)', padding: '16px 14px', flexShrink: 0, overflowY: 'auto' }}>
              <label style={FL}>Assign fields to</label>
              <div style={{ display: 'grid', gap: 6, marginBottom: 18 }}>
                {parties.map((p, i) => {
                  const c = rcolor(i);
                  return (
                    <button key={i} onClick={() => setActiveRecipient(i)}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif',
                        border: activeRecipient === i ? `2px solid ${c.solid}` : '1.5px solid var(--line)', background: activeRecipient === i ? c.soft : 'var(--card)' }}>
                      <span style={{ width: 20, height: 20, borderRadius: '50%', background: c.solid, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 800, flexShrink: 0 }}>{i + 1}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || `Recipient ${i + 1}`}</span>
                    </button>
                  );
                })}
              </div>
              <label style={FL}>Fields — drag onto the page</label>
              <div style={{ display: 'grid', gap: 6 }}>
                {Object.entries(FIELD_META).map(([ft, M]) => {
                  const c = rcolor(activeRecipient);
                  return (
                    <div key={ft} draggable onDragStart={e => e.dataTransfer.setData('field', ft)} onClick={() => setActiveType(ft)}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', borderRadius: 10, cursor: 'grab', fontFamily: 'Inter,sans-serif',
                        border: activeType === ft ? `2px solid ${c.solid}` : '1.5px solid var(--line)', background: activeType === ft ? c.soft : 'var(--card)' }}>
                      <GripVertical size={12} style={{ color: 'var(--muted)' }} />
                      <M.Icon size={14} style={{ color: c.solid }} />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{M.label}</span>
                    </div>
                  );
                })}
              </div>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
                Drag a field onto the page (or select one and click the page). Drag placed fields to move, corner handle to resize, × to remove.
              </p>
              <div style={{ marginTop: 12, fontSize: 11.5, fontWeight: 700, color: fields.length ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
                {fields.length} field{fields.length === 1 ? '' : 's'} placed
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '30px 20px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 10, position: 'sticky', top: 0, zIndex: 30 }}>
                <button className="secondary-btn" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.15).toFixed(2)))} style={{ padding: '5px 9px' }}><ZoomOut size={13} /></button>
                <span style={{ alignSelf: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', width: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                <button className="secondary-btn" onClick={() => setZoom(z => Math.min(1.6, +(z + 0.15).toFixed(2)))} style={{ padding: '5px 9px' }}><ZoomIn size={13} /></button>
              </div>
              <PdfDoc file={file} zoom={zoom} renderOverlay={editorOverlay} />
            </div>
          </div>
        )}
        {/* STEP 2 — Live preview (template) */}
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

        {/* STEP 3 — Review & send */}
        {step === 3 && (
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
                <label style={{ ...FL, marginBottom: 10 }}>Signing order</label>
                {withRoles.map((p, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: rcolor(i).solid, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{p.name}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email} · {p.kind}</span>
                  </div>
                ))}
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
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12, textAlign: 'center' }}>
              Signer 1 is notified immediately; everyone else follows in order. You can remind, void or track it under Sent requests.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Envelope detail: parties progress + audit timeline + actions ──────────────
function RequestDetailModal({ requestId, onClose, onChanged, toastOk, toastErr }) {
  const [req, setReq] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.getSignRequest(requestId).then(setReq).catch(e => { toastErr(e?.message || 'Load failed'); onClose(); });
  // NOT useEffect(load, ...) — load returns a Promise, and React 19 would call
  // it as the effect's cleanup on unmount ("l is not a function" crash on close).
  useEffect(() => { load(); }, [requestId]);

  async function act(kind, fn, okMsg) {
    if (busy) return; setBusy(kind);
    try { const r = await fn(); toastOk(typeof okMsg === 'function' ? okMsg(r) : okMsg); load(); onChanged(); }
    catch (e) { toastErr(e?.message || `Could not ${kind}.`); }
    setBusy('');
  }
  const download = () => act('download', async () => {
    const { url } = await api.downloadSign(requestId); window.open(url, '_blank', 'noopener'); return {};
  }, 'Download started.');

  const sm = req ? (REQ_STATUS[req.status] || REQ_STATUS.pending) : null;
  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(660)}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileSignature size={16} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{req?.title || '…'}</h3>
          {sm && <span style={chip(sm)}>{sm.label}</span>}
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {!req ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, padding: '16px 24px' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {req.status === 'pending' && <button className="secondary-btn" disabled={!!busy} onClick={() => act('remind', () => api.remindSign(requestId), r => `Reminded ${r.reminded}.`)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Bell size={12} /> Remind</button>}
              {req.status === 'pending' && <button className="secondary-btn" disabled={!!busy} onClick={() => act('void', () => api.voidSign(requestId), 'Voided.')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-red))' }}><Ban size={12} /> Void</button>}
              {req.hasFinalPdf && <button className="secondary-btn" disabled={!!busy} onClick={download} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={12} /> Sealed PDF</button>}
              {req.hasFinalPdf && <button className="secondary-btn" disabled={!!busy} onClick={() => act('verify', () => api.verifySign(requestId), r => r.valid ? 'Verified — document untampered.' : '⚠ HASH MISMATCH — document was modified!')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><ShieldCheck size={12} /> Verify integrity</button>}
            </div>

            <label style={FL}>Signers</label>
            {(req.parties || []).map((p, i) => {
              const m = PARTY_STATUS[p.status] || PARTY_STATUS.waiting;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ width: 22, height: 22, borderRadius: '50%', background: rcolor(i).solid, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{p.ordinal}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>· {p.kind}</span></div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.email}{p.declineReason && ` — "${p.declineReason}"`}</div>
                  </div>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: m.fg }}>{p.status === 'signed' && p.signedAt ? `Signed ${p.signedAt.slice(0, 10)}` : m.label}</span>
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
    </div>
  );
}

// ── Main E-Sign tab ───────────────────────────────────────────────────────────
export default function ESign({ employees = [], entities = [], prefill = null, onPrefillConsumed, toastOk, toastErr }) {
  const [sub, setSub] = useState('inbox');
  const [inbox, setInbox] = useState(null);
  const [requests, setRequests] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [signParty, setSignParty] = useState(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [editTpl, setEditTpl] = useState(undefined);
  const [seedBusy, setSeedBusy] = useState(false);

  const loadInbox = () => api.mySignatures().then(setInbox).catch(() => setInbox([]));
  const loadRequests = () => api.getSignRequests().then(setRequests).catch(() => setRequests([]));
  const loadTemplates = () => api.getSignTemplates().then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { loadInbox(); loadRequests(); loadTemplates(); }, []);
  useEffect(() => { if (prefill) setSendOpen(true); }, [prefill]);
  // Switching sub-tabs refetches that list — a doc sent (or signed) after mount
  // must show up without leaving the module.
  const switchSub = (id) => {
    setSub(id);
    if (id === 'inbox') loadInbox();
    else if (id === 'requests') loadRequests();
    else loadTemplates();
  };

  const myTurnCount = (inbox || []).filter(x => x.myTurn).length;
  const tabs = [
    ['inbox', `Inbox${myTurnCount ? ` (${myTurnCount})` : ''}`],
    ['requests', 'Sent requests'],
    ['templates', 'Templates'],
  ];

  const empty = (Icon, text, action) => (
    <div style={{ textAlign: 'center', padding: '52px 20px', color: 'var(--muted)' }}>
      <Icon size={36} style={{ opacity: 0.3, marginBottom: 12 }} />
      <p style={{ fontSize: 13.5, margin: '0 0 16px' }}>{text}</p>
      {action}
    </div>
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
          <Send size={13} /> Send for signature
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
            {item.myTurn
              ? <button className="primary-btn" onClick={() => setSignParty(item.partyId)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Review &amp; sign <ChevronRight size={13} /></button>
              : <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Clock size={12} /> Waiting on others</span>}
          </div>
        ))
      )}

      {sub === 'requests' && (
        !requests ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
        : requests.length === 0 ? empty(Send, 'No signature requests yet.',
            <button className="primary-btn" onClick={() => setSendOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={13} /> Send your first</button>)
        : requests.map(r => {
          const m = REQ_STATUS[r.status] || REQ_STATUS.pending;
          const signed = (r.parties || []).filter(p => p.status === 'signed').length;
          const total = (r.parties || []).length;
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
                </div>
              </div>
              <span style={chip(m)}>{m.label}</span>
              <ChevronRight size={15} style={{ color: 'var(--muted)' }} />
            </div>
          );
        })
      )}

      {sub === 'templates' && (
        !templates ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
        : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button className="secondary-btn" onClick={() => setEditTpl(null)} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> New template</button>
              <button className="secondary-btn" disabled={seedBusy} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={async () => { setSeedBusy(true);
                  try { const r = await api.seedSignTemplates(); toastOk(r.added.length ? `Added: ${r.added.join(', ')}` : 'Starters already present.'); loadTemplates(); }
                  catch (e) { toastErr(e?.message || 'Could not seed.'); } setSeedBusy(false); }}>
                {seedBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={13} />} Add starter templates
              </button>
            </div>
            {templates.length === 0 ? empty(FileText, 'No templates yet — start from the standard Offer / NDA / Handbook set.')
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
                <button title="Delete" onClick={async () => { try { await api.deleteSignTemplate(t.id); loadTemplates(); } catch (e) { toastErr(e?.message || 'Delete failed (owner grant needed).'); } }}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>
              </div>
            ))}
          </>
        )
      )}

      {signParty && <SignModal partyId={signParty} toastOk={toastOk} toastErr={toastErr}
        onClose={() => setSignParty(null)} onDone={() => { setSignParty(null); loadInbox(); loadRequests(); }} />}
      {sendOpen && <SendWizard templates={templates || []} employees={employees} entities={entities}
        prefill={prefill} toastOk={toastOk} toastErr={toastErr}
        onClose={() => { setSendOpen(false); onPrefillConsumed?.(); }}
        onSent={() => { loadRequests(); loadInbox(); }} />}
      {detailId && <RequestDetailModal requestId={detailId} toastOk={toastOk} toastErr={toastErr}
        onClose={() => setDetailId(null)} onChanged={loadRequests} />}
      {editTpl !== undefined && <TemplateEditorModal template={editTpl} entities={entities}
        toastOk={toastOk} toastErr={toastErr} onClose={() => setEditTpl(undefined)} onSaved={() => loadTemplates()} />}
    </div>
  );
}
