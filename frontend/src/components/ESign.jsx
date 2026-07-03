import { useState, useEffect, useMemo, useRef } from 'react';
import {
  FileSignature, Plus, X, Loader2, CheckCircle, XCircle, Clock, Send, Trash2,
  Pencil, FileText, Download, ShieldCheck, Bell, ChevronRight, Eraser, Type,
  PenTool, Users, Mail, AlertTriangle, RefreshCw, Ban, Sparkles, UploadCloud,
} from 'lucide-react';
import { api } from '../api';

// ── HR Section C — Native E-Sign ──────────────────────────────────────────────
// Templates ({{merge}} + [[field:role]] tokens), ordered multi-party envelopes,
// internal in-app signing + external tokenized links, sealed PDF + certificate.
// PublicSign.jsx reuses SignaturePad + SigningDoc for the no-login flow.

const FIELD_RE = /\[\[(sign|initials|date|text|check):([a-z0-9_]+)(?::([^\]]*))?\]\]/g;
const MERGE_RE = /\{\{([a-z0-9_]+)\}\}/g;

const REQ_STATUS = {
  pending:   { label: 'Awaiting signatures', fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
  completed: { label: 'Completed',           fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)' },
  declined:  { label: 'Declined',            fg: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)' },
  voided:    { label: 'Voided',              fg: 'var(--muted)',             bg: 'var(--hover)' },
  expired:   { label: 'Expired',             fg: 'var(--muted)',             bg: 'var(--hover)' },
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
const FIELD_DEFAULTS = { sign: { w: 0.25, h: 0.06 }, initials: { w: 0.08, h: 0.035 },
  date: { w: 0.13, h: 0.03 }, text: { w: 0.22, h: 0.03 }, check: { w: 0.035, h: 0.025 } };

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };
const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = (maxWidth) => ({ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth, maxHeight: 'min(94dvh, 860px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' });
const chip = (m) => ({ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: m.bg, color: m.fg, whiteSpace: 'nowrap' });
const initialsOf = (name) => (name || '').split(' ').slice(0, 3).map(w => w[0]?.toUpperCase() || '').join('') || '—';

// ── Signature pad — draw (canvas) or type; exports PNG data-URL / typed name ──
export function SignaturePad({ name = '', onAdopt, onClose }) {
  const [tab, setTab] = useState('draw');
  const [typed, setTyped] = useState(name);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef(null);
  const strokes = useRef([]);        // array of point arrays, for undo
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const scale = window.devicePixelRatio || 1;
    c.width = 480 * scale; c.height = 160 * scale;
    c.getContext('2d').scale(scale, scale);
    redraw();
  }, [tab]);

  function redraw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 480, 160);
    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes.current) {
      ctx.beginPath();
      s.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
    setHasInk(strokes.current.length > 0);
  }
  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (480 / r.width), y: (e.clientY - r.top) * (160 / r.height) };
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
      onAdopt({ kind: 'typed', data: typed.trim() });
    }
  }

  return (
    <div style={{ ...overlayStyle, zIndex: 1300 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(540)}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <PenTool size={16} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Adopt your signature</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '16px 22px' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {[['draw', 'Draw', PenTool], ['type', 'Type', Type]].map(([id, label, Icon]) => (
              <button key={id} onClick={() => setTab(id)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', border: '1px solid var(--line)', background: tab === id ? 'var(--pine)' : 'var(--card)', color: tab === id ? '#fff' : 'var(--ink)' }}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          {tab === 'draw' ? (
            <>
              <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up}
                style={{ width: '100%', height: 160, border: '1.5px dashed var(--line)', borderRadius: 12, touchAction: 'none', cursor: 'crosshair', background: '#fff' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="secondary-btn" onClick={() => { strokes.current.pop(); redraw(); }} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={12} /> Undo</button>
                <button className="secondary-btn" onClick={() => { strokes.current = []; redraw(); }} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eraser size={12} /> Clear</button>
              </div>
            </>
          ) : (
            <>
              <input className="form-input" style={{ width: '100%' }} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type your full legal name" autoFocus />
              <div style={{ marginTop: 12, padding: '18px 16px', border: '1.5px dashed var(--line)', borderRadius: 12, minHeight: 70, display: 'flex', alignItems: 'center', background: '#fff' }}>
                <span style={{ fontFamily: '"Segoe Script","Brush Script MT",cursive', fontSize: 30, color: '#1e293b' }}>{typed || ' '}</span>
              </div>
            </>
          )}
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={adopt} disabled={tab === 'draw' ? !hasInk : !typed.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (tab === 'draw' ? hasInk : typed.trim()) ? 1 : 0.55 }}>
            <CheckCircle size={14} /> Adopt signature
          </button>
        </div>
      </div>
    </div>
  );
}

// ── PDF page renderer (pdfjs-dist, SOP.jsx idiom) with an overlay render-prop ──
function PdfDoc({ url, renderOverlay, onPageClick }) {
  const [pages, setPages] = useState(null);   // [{dataUrl, w, h}]
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        const buf = await (await fetch(url)).arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: buf }).promise;
        const out = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1.4 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          out.push({ dataUrl: canvas.toDataURL(), w: vp.width, h: vp.height });
        }
        if (live) setPages(out);
      } catch (e) { if (live) setError(e?.message || 'Could not render the PDF.'); }
    })();
    return () => { live = false; };
  }, [url]);

  if (error) return <div style={{ fontSize: 13, color: 'hsl(var(--color-red))', padding: 16 }}>{error}</div>;
  if (!pages) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {pages.map((p, i) => (
        <div key={i} style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: '#fff' }}
          onClick={onPageClick ? (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onPageClick(i, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          } : undefined}>
          <img src={p.dataUrl} alt={`Page ${i + 1}`} style={{ width: '100%', display: 'block' }} draggable={false} />
          {renderOverlay?.(i)}
        </div>
      ))}
    </div>
  );
}

// ── Shared signing screen — renders the doc, collects fields + consent + sig ──
// Used by the internal signing modal AND the public /sign/{token} page.
export function SigningDoc({ payload, busy, onSubmit, onDecline }) {
  const [sig, setSig] = useState(null);           // {kind, data}
  const [padOpen, setPadOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [values, setValues] = useState({});       // field key -> value
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const myRole = payload.myRole;
  const isTemplate = payload.source === 'template';

  // Every field assigned to me; checks are required, texts free-form.
  const myFields = payload.myFields || [];
  const myChecks = myFields.filter(f => (f.type || f.ftype) === 'check');
  const needSig = myFields.some(f => f.type === 'sign') || isTemplate;
  const allChecked = myChecks.every(f => values[isTemplate ? `check:${f.label}` : f.id]);
  const canSign = payload.myTurn && consent && (!needSig || sig) && allChecked;

  const setVal = (k, v) => setValues(p => ({ ...p, [k]: v }));

  const sigPreview = (small = false) => sig?.kind === 'drawn'
    ? <img src={sig.data} alt="signature" style={{ maxHeight: small ? 30 : 46, maxWidth: '100%' }} />
    : <span style={{ fontFamily: '"Segoe Script","Brush Script MT",cursive', fontSize: small ? 17 : 24 }}>{sig?.data}</span>;

  // Template body: swap [[tokens]] for chips / interactive elements
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
          <span key={key} style={{ display: 'block', margin: '10px 0' }}>
            {mine ? (
              sig ? (
                <button onClick={() => setPadOpen(true)} title="Change signature" style={{ display: 'inline-block', borderBottom: '1.5px solid var(--ink)', paddingBottom: 3, minWidth: 180, background: 'hsla(var(--color-green),0.06)', border: '1px dashed hsl(var(--color-green))', borderRadius: 8, padding: '6px 14px', cursor: 'pointer' }}>{sigPreview()}</button>
              ) : (
                <button onClick={() => payload.myTurn && setPadOpen(true)} disabled={!payload.myTurn}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 20px', borderRadius: 9, border: '1.5px dashed hsl(var(--color-orange))', background: 'hsla(var(--color-orange),0.08)', color: 'hsl(var(--color-orange))', fontWeight: 700, fontSize: 13, cursor: payload.myTurn ? 'pointer' : 'default', fontFamily: 'Inter,sans-serif' }}>
                  <PenTool size={14} /> Sign here
                </button>
              )
            ) : (
              <span style={{ display: 'inline-block', padding: '7px 16px', borderRadius: 8, border: '1px dashed var(--line)', color: 'var(--muted)', fontSize: 12 }}>
                Signature: {(payload.parties || []).find(p => p.roleKey === role)?.name || role}
              </span>
            )}
          </span>);
      } else if (type === 'date') {
        parts.push(<span key={key} style={{ color: 'var(--muted)', fontSize: 12.5, fontStyle: 'italic' }}>[date signed{mine ? '' : ` — ${role}`}]</span>);
      } else if (type === 'initials') {
        parts.push(<span key={key} style={{ fontFamily: '"Segoe Script",cursive', fontWeight: 700 }}>{mine ? initialsOf(payload.myName) : '··'}</span>);
      } else if (type === 'check') {
        const k = `check:${label}`;
        parts.push(
          <label key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '8px 0', cursor: mine && payload.myTurn ? 'pointer' : 'default', fontSize: 13.5 }}>
            <input type="checkbox" disabled={!mine || !payload.myTurn} checked={!!values[k]}
              onChange={e => setVal(k, e.target.checked)} style={{ width: 16, height: 16, marginTop: 2 }} />
            <span>{label}{mine && <span style={{ color: 'hsl(var(--color-red))' }}> *</span>}</span>
          </label>);
      } else if (type === 'text') {
        const k = `text:${label}`;
        parts.push(mine
          ? <input key={key} className="form-input" placeholder={label} value={values[k] || ''} disabled={!payload.myTurn}
              onChange={e => setVal(k, e.target.value)} style={{ display: 'inline-block', width: 200, margin: '2px 0' }} />
          : <span key={key} style={{ borderBottom: '1px solid var(--line)', minWidth: 120, display: 'inline-block', color: 'var(--muted)', fontSize: 12 }}>{label}</span>);
      }
      last = m.index + m[0].length;
    }
    if (last < para.length) parts.push(<span key={`${pi}-end`}>{para.slice(last)}</span>);
    return <div key={pi} style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.65 }}>{parts}</div>;
  }

  // PDF overlay for the signing view
  const signingOverlay = (pageIdx) => (
    <>
      {(payload.fields || []).filter(f => f.page === pageIdx).map(f => {
        const mine = f.role === myRole;
        const st = { position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
        if (f.type === 'sign' && mine) {
          return (
            <button key={f.id} onClick={() => payload.myTurn && setPadOpen(true)}
              style={{ ...st, border: `1.5px dashed hsl(var(--color-${sig ? 'green' : 'orange'}))`, background: `hsla(var(--color-${sig ? 'green' : 'orange'}),0.1)`, borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', fontFamily: 'Inter,sans-serif' }}>
              {sig ? sigPreview(true) : <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-orange))' }}>Sign</span>}
            </button>);
        }
        if (f.type === 'check' && mine) {
          return <input key={f.id} type="checkbox" checked={!!values[f.id]} disabled={!payload.myTurn}
            onChange={e => setVal(f.id, e.target.checked)} style={{ ...st, accentColor: 'hsl(var(--color-green))' }} />;
        }
        if (f.type === 'text' && mine) {
          return <input key={f.id} value={values[f.id] || ''} disabled={!payload.myTurn} onChange={e => setVal(f.id, e.target.value)}
            style={{ ...st, border: '1.5px dashed hsl(var(--color-blue))', borderRadius: 4, fontSize: 11, padding: '0 4px' }} />;
        }
        return <span key={f.id} style={{ ...st, border: '1px dashed var(--line)', borderRadius: 4, background: 'rgba(0,0,0,0.02)' }} title={`${f.type} — ${f.role}`} />;
      })}
    </>
  );

  return (
    <div>
      {!payload.myTurn && payload.myStatus !== 'signed' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', borderRadius: 10, background: 'hsla(var(--color-blue),0.08)', color: 'hsl(var(--color-blue))', fontSize: 13, marginBottom: 14 }}>
          <Clock size={15} /> It isn't your turn yet — you'll be notified when the document is ready for you.
        </div>
      )}
      {payload.message && (
        <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', marginBottom: 14 }}>“{payload.message}”</div>
      )}

      <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: isTemplate ? '22px 26px' : 10, background: isTemplate ? '#fff' : 'var(--mist)', color: '#111827' }}>
        {isTemplate
          ? (payload.body || []).map(renderPara)
          : <PdfDoc url={payload.pdfUrl} renderOverlay={signingOverlay} />}
      </div>

      {/* Progress strip */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        {(payload.parties || []).map((p, i) => {
          const m = PARTY_STATUS[p.status] || PARTY_STATUS.waiting;
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 11px', borderRadius: 16, border: '1px solid var(--line)', color: m.fg }}>
              {p.status === 'signed' ? <CheckCircle size={12} /> : <Clock size={12} />}
              {p.name} · {m.label}
            </span>);
        })}
      </div>

      {payload.myTurn && (
        <div style={{ marginTop: 18, padding: '16px 18px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--mist)' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12.5, lineHeight: 1.55, cursor: 'pointer' }}>
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }} />
            <span>{payload.consentText}</span>
          </label>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="secondary-btn" disabled={busy} onClick={() => setDeclineOpen(true)} style={{ color: 'hsl(var(--color-red))' }}>Decline</button>
            <button className="primary-btn" disabled={!canSign || busy}
              onClick={() => onSubmit({ consent, signature_kind: sig?.kind || 'typed', signature_data: sig?.data || payload.myName, field_values: values })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: canSign && !busy ? 1 : 0.55 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FileSignature size={14} />} Sign &amp; finish
            </button>
          </div>
          {!canSign && consent && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'right', marginTop: 6 }}>
              {!sig && needSig ? 'Add your signature above.' : !allChecked ? 'Tick every required checkbox.' : ''}
            </div>
          )}
        </div>
      )}

      {padOpen && <SignaturePad name={payload.myName} onClose={() => setPadOpen(false)}
        onAdopt={(s) => { setSig(s); setPadOpen(false); }} />}

      {declineOpen && (
        <div style={{ ...overlayStyle, zIndex: 1300 }} onClick={e => e.target === e.currentTarget && setDeclineOpen(false)}>
          <div style={cardStyle(440)}>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Decline to sign</h3>
            </div>
            <div style={{ padding: '16px 22px' }}>
              <label style={FL}>REASON (SHARED WITH THE SENDER)</label>
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

// ── Internal signing modal (inbox → sign in-app) ──────────────────────────────
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
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(760)}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileSignature size={17} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{payload?.title || 'Loading…'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          {!payload
            ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>
            : <SigningDoc payload={payload} busy={busy} onSubmit={submit} onDecline={decline} />}
        </div>
      </div>
    </div>
  );
}

// ── Template editor ───────────────────────────────────────────────────────────
function TemplateEditorModal({ template, entities, onClose, onSaved, toastOk, toastErr }) {
  const t0 = template || {};
  const [f, setF] = useState({
    name: t0.name || '', kind: t0.kind || 'custom', entity_id: t0.entityId || '',
    roles: t0.roles?.length ? t0.roles : [{ key: 'employee', label: 'Employee', order: 1 }],
    bodyText: (t0.body || []).join('\n'),
  });
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const insert = (token) => {
    const ta = bodyRef.current;
    const cur = f.bodyText;
    const at = ta ? ta.selectionStart : cur.length;
    set('bodyText', cur.slice(0, at) + token + cur.slice(at));
    setTimeout(() => { ta?.focus(); ta?.setSelectionRange(at + token.length, at + token.length); }, 0);
  };
  const setRole = (i, k, v) => set('roles', f.roles.map((r, j) => j === i ? { ...r, [k]: v } : r));

  async function save() {
    if (busy) return; setBusy(true);
    const data = { name: f.name, kind: f.kind, entity_id: f.entity_id,
      roles: f.roles.filter(r => r.key.trim()), body: f.bodyText.split('\n').filter(l => l.trim()) };
    try {
      const saved = template?.id ? await api.updateSignTemplate(template.id, data) : await api.createSignTemplate(data);
      toastOk('Template saved.'); onSaved(saved); onClose();
    } catch (e) { toastErr(e?.message || 'Could not save template.'); setBusy(false); }
  }

  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(780)}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileText size={17} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{template?.id ? 'Edit template' : 'New template'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <div><label style={FL}>NAME *</label><input className="form-input" style={{ width: '100%' }} value={f.name} onChange={e => set('name', e.target.value)} autoFocus /></div>
            <div><label style={FL}>KIND</label>
              <select className="form-input" style={{ width: '100%' }} value={f.kind} onChange={e => set('kind', e.target.value)}>
                {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
            <div><label style={FL}>COMPANY</label>
              <select className="form-input" style={{ width: '100%' }} value={f.entity_id} onChange={e => set('entity_id', e.target.value)}>
                <option value="">Any</option>
                {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select></div>
          </div>

          <div style={{ margin: '16px 0 6px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em' }}>SIGNER ROLES (IN ORDER)</div>
          {f.roles.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', width: 18 }}>{i + 1}.</span>
              <input className="form-input" style={{ width: 150 }} value={r.key} placeholder="key (e.g. employee)"
                onChange={e => setRole(i, 'key', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} />
              <input className="form-input" style={{ flex: 1 }} value={r.label} placeholder="Label"
                onChange={e => setRole(i, 'label', e.target.value)} />
              <button onClick={() => set('roles', f.roles.filter((_, j) => j !== i).map((x, j) => ({ ...x, order: j + 1 })))}
                style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 4 }}><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="secondary-btn" onClick={() => set('roles', [...f.roles, { key: '', label: '', order: f.roles.length + 1 }])}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add role</button>

          <div style={{ margin: '16px 0 6px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em' }}>DOCUMENT BODY (ONE PARAGRAPH PER LINE)</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
            {MERGE_TOKENS.map(tk => (
              <button key={tk} onClick={() => insert(`{{${tk}}}`)} title="Insert merge field"
                style={{ fontSize: 10.5, fontWeight: 600, padding: '3px 8px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--mist)', cursor: 'pointer', color: 'var(--ink)', fontFamily: 'Inter,sans-serif' }}>
                {`{{${tk}}}`}
              </button>
            ))}
            {f.roles.filter(r => r.key).map(r => (
              ['sign', 'date', 'initials'].map(ft => (
                <button key={`${ft}-${r.key}`} onClick={() => insert(`[[${ft}:${r.key}]]`)} title={`Insert ${ft} slot for ${r.label || r.key}`}
                  style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 12, border: '1px solid hsl(var(--color-green))', background: 'hsla(var(--color-green),0.08)', color: 'hsl(var(--color-green))', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                  {`${ft}:${r.key}`}
                </button>
              ))
            ))}
            {f.roles[0]?.key && (
              <>
                <button onClick={() => insert(`[[check:${f.roles[0].key}:I agree]]`)} style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 12, border: '1px solid hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.08)', color: 'hsl(var(--color-blue))', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>+ checkbox</button>
                <button onClick={() => insert(`[[text:${f.roles[0].key}:Label]]`)} style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 12, border: '1px solid hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.08)', color: 'hsl(var(--color-blue))', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>+ text field</button>
              </>
            )}
          </div>
          <textarea ref={bodyRef} className="form-input" rows={12} value={f.bodyText} onChange={e => set('bodyText', e.target.value)}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, lineHeight: 1.7 }} />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '8px 0 0' }}>
            <code>{'{{merge}}'}</code> fields auto-fill from the person/company at send time; <code>[[sign:role]]</code> slots become interactive when that role signs.
          </p>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!f.name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!f.name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save template
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Send-for-signature modal (template OR uploaded PDF with field placement) ──
function SendModal({ templates, employees, entities, prefill, onClose, onSent, toastOk, toastErr }) {
  const [source, setSource] = useState('template');
  const [templateId, setTemplateId] = useState('');
  const [subjectId, setSubjectId] = useState(prefill?.candidateId ? `c:${prefill.candidateId}` : '');
  const [candidates, setCandidates] = useState([]);
  const [entityId, setEntityId] = useState(entities[0]?.id || '');
  const [title, setTitle] = useState(prefill?.title || '');
  const [message, setMessage] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [merge, setMerge] = useState({});
  const [parties, setParties] = useState(prefill?.parties || []);
  const [busy, setBusy] = useState(false);
  // PDF mode
  const [file, setFile] = useState(null);
  const [fileUrl, setFileUrl] = useState('');
  const [fields, setFields] = useState([]);
  const [tool, setTool] = useState({ type: 'sign', role: '' });

  useEffect(() => { api.getCandidates().then(setCandidates).catch(() => setCandidates([])); }, []);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  const tpl = templates.find(t => t.id === templateId);
  const mergeTokens = useMemo(() => {
    if (!tpl) return [];
    const found = new Set();
    for (const para of tpl.body || []) for (const m of String(para).matchAll(MERGE_RE)) found.add(m[1]);
    found.delete('today');
    return [...found];
  }, [tpl]);

  // Roles come from the template (or are free-typed in pdf mode)
  const roles = source === 'template'
    ? (tpl?.roles || [])
    : [...new Set(parties.map(p => p.role_key).concat(tool.role ? [tool.role] : []))].filter(Boolean).map((k, i) => ({ key: k, label: k, order: i + 1 }));

  useEffect(() => {   // picking a template seeds one party row per role
    if (source !== 'template' || !tpl) return;
    setParties((tpl.roles || []).map((r, i) => {
      const kept = prefill?.parties?.find(p => p.role_key === r.key);
      return kept || { role_key: r.key, name: '', email: '', kind: 'internal', ordinal: r.order || i + 1 };
    }));
    setTitle(tpl.name);
  }, [templateId]);

  const setParty = (i, k, v) => setParties(ps => ps.map((p, j) => j === i ? { ...p, [k]: v } : p));
  const pickEmployee = (i, id) => {
    const e = employees.find(x => x.id === id);
    if (e) setParties(ps => ps.map((p, j) => j === i
      ? { ...p, name: `${e.firstName} ${e.lastName}`.trim(), email: e.workEmail, kind: 'internal' } : p));
  };

  function onPageClick(page, x, y) {
    if (!tool.role.trim()) { toastErr('Set a role name for the field first (e.g. employee).'); return; }
    const d = FIELD_DEFAULTS[tool.type];
    setFields(fs => [...fs, { id: `f${Date.now()}`, role: tool.role.trim().toLowerCase(), type: tool.type,
      page, x: Math.max(0, x - d.w / 2), y: Math.max(0, y - d.h / 2), w: d.w, h: d.h, required: true }]);
  }
  const placerOverlay = (pageIdx) => (
    <>
      {fields.filter(f => f.page === pageIdx).map(f => (
        <span key={f.id} onClick={e => { e.stopPropagation(); setFields(fs => fs.filter(x => x.id !== f.id)); }}
          title={`${f.type} · ${f.role} — click to remove`}
          style={{ position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`,
            border: '1.5px dashed hsl(var(--color-green))', background: 'hsla(var(--color-green),0.14)', borderRadius: 5, cursor: 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700, color: 'hsl(var(--color-green))', overflow: 'hidden' }}>
          {f.type}:{f.role}
        </span>
      ))}
    </>
  );

  async function send() {
    if (busy) return; setBusy(true);
    const cleanParties = parties.filter(p => p.name.trim() && p.email.trim());
    try {
      let sent;
      const subject = subjectId.startsWith('e:') ? { employee_id: subjectId.slice(2) }
        : subjectId.startsWith('c:') ? { candidate_id: subjectId.slice(2) } : {};
      if (source === 'template') {
        if (!tpl) throw new Error('Pick a template.');
        sent = await api.sendSignRequest({
          template_id: tpl.id, title: title.trim(), ...subject, entity_id: entityId,
          message, expires_on: expiresOn,
          merge: Object.fromEntries(Object.entries(merge).filter(([, v]) => String(v).trim())),
          parties: cleanParties,
        });
      } else {
        if (!file) throw new Error('Choose a PDF.');
        if (!fields.length) throw new Error('Place at least one field on the document.');
        const form = new FormData();
        form.append('file', file);
        form.append('payload', JSON.stringify({
          title: title.trim() || file.name, ...(subject.employee_id ? { employeeId: subject.employee_id } : {}),
          ...(subject.candidate_id ? { candidateId: subject.candidate_id } : {}), entityId,
          message, expiresOn, fields,
          parties: cleanParties.map(p => ({ roleKey: p.role_key, name: p.name, email: p.email, kind: p.kind, ordinal: p.ordinal })),
        }));
        sent = await api.sendSignPdf(form);
      }
      toastOk(`Sent "${sent.title}" — ${sent.parties.length} signer${sent.parties.length === 1 ? '' : 's'} in order.`);
      onSent(sent); onClose();
    } catch (e) { toastErr(e?.message || 'Could not send.'); setBusy(false); }
  }

  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cardStyle(860)}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <Send size={16} style={{ color: 'var(--pine)' }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Send for signature</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {[['template', 'From template', FileText], ['pdf', 'Upload PDF', UploadCloud]].map(([id, label, Icon]) => (
              <button key={id} onClick={() => setSource(id)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', border: '1px solid var(--line)', background: source === id ? 'var(--pine)' : 'var(--card)', color: source === id ? '#fff' : 'var(--ink)' }}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {source === 'template' ? (
              <div><label style={FL}>TEMPLATE *</label>
                <select className="form-input" style={{ width: '100%' }} value={templateId} onChange={e => setTemplateId(e.target.value)}>
                  <option value="">— pick —</option>
                  {templates.filter(t => t.status === 'active').map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select></div>
            ) : (
              <div><label style={FL}>PDF FILE *</label>
                <input type="file" accept="application/pdf" className="form-input" style={{ width: '100%' }}
                  onChange={e => { const fl = e.target.files?.[0]; if (fl) { setFile(fl); setFileUrl(URL.createObjectURL(fl)); setFields([]); if (!title) setTitle(fl.name.replace(/\.pdf$/i, '')); } }} /></div>
            )}
            <div><label style={FL}>TITLE</label><input className="form-input" style={{ width: '100%' }} value={title} onChange={e => setTitle(e.target.value)} /></div>
            <div><label style={FL}>ABOUT (PERSON — FILLS MERGE FIELDS)</label>
              <select className="form-input" style={{ width: '100%' }} value={subjectId} onChange={e => setSubjectId(e.target.value)}>
                <option value="">—</option>
                <optgroup label="Employees">
                  {employees.map(e => <option key={e.id} value={`e:${e.id}`}>{e.firstName} {e.lastName} ({e.employeeCode})</option>)}
                </optgroup>
                <optgroup label="Candidates">
                  {candidates.filter(c => !c.employeeId).map(c => <option key={c.id} value={`c:${c.id}`}>{c.firstName} {c.lastName} — {c.roleTitle || 'candidate'}</option>)}
                </optgroup>
              </select></div>
            <div><label style={FL}>COMPANY</label>
              <select className="form-input" style={{ width: '100%' }} value={entityId} onChange={e => setEntityId(e.target.value)}>
                {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select></div>
            <div><label style={FL}>EXPIRES</label><input type="date" className="form-input" style={{ width: '100%' }} value={expiresOn} onChange={e => setExpiresOn(e.target.value)} /></div>
            <div><label style={FL}>MESSAGE TO SIGNERS</label><input className="form-input" style={{ width: '100%' }} value={message} onChange={e => setMessage(e.target.value)} placeholder="optional note" /></div>
          </div>

          {source === 'template' && mergeTokens.length > 0 && (
            <>
              <div style={{ margin: '16px 0 6px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em' }}>MERGE FIELDS <span style={{ fontWeight: 400 }}>(blank = auto-filled from the person/company)</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {mergeTokens.map(tk => (
                  <div key={tk}>
                    <label style={{ ...FL, marginBottom: 3, textTransform: 'uppercase', fontSize: 10.5 }}>{tk.replace(/_/g, ' ')}</label>
                    <input className="form-input" style={{ width: '100%' }} value={merge[tk] || ''} placeholder="auto"
                      onChange={e => setMerge(m => ({ ...m, [tk]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </>
          )}

          {source === 'pdf' && fileUrl && (
            <>
              <div style={{ margin: '16px 0 8px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em' }}>PLACE FIELDS — pick a type + role, then click the page ({fields.length} placed; click a box to remove)</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                {Object.keys(FIELD_DEFAULTS).map(ft => (
                  <button key={ft} onClick={() => setTool(t => ({ ...t, type: ft }))}
                    style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--line)', cursor: 'pointer', fontFamily: 'Inter,sans-serif', background: tool.type === ft ? 'var(--pine)' : 'var(--card)', color: tool.type === ft ? '#fff' : 'var(--ink)' }}>{ft}</button>
                ))}
                <input className="form-input" style={{ width: 160 }} placeholder="role (e.g. employee)" value={tool.role}
                  onChange={e => setTool(t => ({ ...t, role: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} />
              </div>
              <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: 10, background: 'var(--mist)' }}>
                <PdfDoc url={fileUrl} renderOverlay={placerOverlay} onPageClick={onPageClick} />
              </div>
            </>
          )}

          <div style={{ margin: '18px 0 6px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Users size={13} /> SIGNERS (SIGN IN THIS ORDER)
          </div>
          {parties.map((p, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, marginBottom: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '54px 130px 1fr 1fr 110px auto', gap: 8, alignItems: 'center' }}>
                <input type="number" min={1} className="form-input" title="Signing order" value={p.ordinal}
                  onChange={e => setParty(i, 'ordinal', Math.max(1, Number(e.target.value) || 1))} />
                <input className="form-input" placeholder="role" value={p.role_key}
                  onChange={e => setParty(i, 'role_key', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} />
                <input className="form-input" placeholder="Full name" value={p.name} onChange={e => setParty(i, 'name', e.target.value)} />
                <input className="form-input" placeholder="email@…" value={p.email} onChange={e => setParty(i, 'email', e.target.value)} />
                <select className="form-input" value={p.kind} onChange={e => setParty(i, 'kind', e.target.value)}>
                  <option value="internal">Internal</option><option value="external">External</option>
                </select>
                <button onClick={() => setParties(ps => ps.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', display: 'flex', padding: 4 }}><Trash2 size={14} /></button>
              </div>
              {p.kind === 'internal' && (
                <select className="form-input" style={{ marginTop: 6, width: '100%', fontSize: 12 }} value=""
                  onChange={e => e.target.value && pickEmployee(i, e.target.value)}>
                  <option value="">↳ pick a teammate to fill name + email…</option>
                  {employees.filter(e => e.workEmail).map(e => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} — {e.workEmail}</option>)}
                </select>
              )}
            </div>
          ))}
          <button className="secondary-btn" onClick={() => setParties(ps => [...ps, { role_key: '', name: '', email: '', kind: 'internal', ordinal: ps.length + 1 }])}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add signer</button>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0' }}>
            Internal signers get a bell notification and sign in Nexus; external signers get a secure email link — no login needed.
          </p>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={send} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: busy ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />} Send for signature
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Envelope detail: parties progress + audit timeline + actions ──────────────
function RequestDetailModal({ requestId, onClose, onChanged, toastOk, toastErr }) {
  const [req, setReq] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.getSignRequest(requestId).then(setReq).catch(e => { toastErr(e?.message || 'Load failed'); onClose(); });
  useEffect(load, [requestId]);

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
      <div style={cardStyle(640)}>
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

            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 8 }}>SIGNERS</div>
            {(req.parties || []).map((p, i) => {
              const m = PARTY_STATUS[p.status] || PARTY_STATUS.waiting;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', flexShrink: 0 }}>{p.ordinal}</span>
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

            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', margin: '18px 0 8px' }}>AUDIT TRAIL</div>
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
  const [editTpl, setEditTpl] = useState(undefined);   // undefined closed, null=new, obj=edit
  const [seedBusy, setSeedBusy] = useState(false);

  const loadInbox = () => api.mySignatures().then(setInbox).catch(() => setInbox([]));
  const loadRequests = () => api.getSignRequests().then(setRequests).catch(() => setRequests([]));
  const loadTemplates = () => api.getSignTemplates().then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { loadInbox(); loadRequests(); loadTemplates(); }, []);
  useEffect(() => {
    if (prefill) { setSendOpen(true); }
  }, [prefill]);

  const myTurnCount = (inbox || []).filter(x => x.myTurn).length;
  const tabs = [
    ['inbox', `Inbox${myTurnCount ? ` (${myTurnCount})` : ''}`],
    ['requests', 'Sent requests'],
    ['templates', 'Templates'],
  ];

  const empty = (Icon, text, action) => (
    <div style={{ textAlign: 'center', padding: '46px 20px', color: 'var(--muted)' }}>
      <Icon size={34} style={{ opacity: 0.35, marginBottom: 10 }} />
      <p style={{ fontSize: 13.5, margin: '0 0 16px' }}>{text}</p>
      {action}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4, flex: 1, borderBottom: '1px solid var(--line)' }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setSub(id)}
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
          <div key={item.partyId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, background: 'var(--card)' }}>
            <FileSignature size={17} style={{ color: item.myTurn ? 'hsl(var(--color-orange))' : 'var(--muted)', flexShrink: 0 }} />
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
          return (
            <div key={r.id} onClick={() => setDetailId(r.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, background: 'var(--card)', cursor: 'pointer' }}>
              <FileSignature size={17} style={{ color: m.fg, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {signed}/{(r.parties || []).length} signed · sent {(r.createdAt || '').slice(0, 10)} by {r.createdBy}
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
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, background: 'var(--card)' }}>
                <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {KIND_LABEL[t.kind] || t.kind} · {(t.roles || []).length} role{(t.roles || []).length === 1 ? '' : 's'} · {(t.body || []).length} paragraphs
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
      {sendOpen && <SendModal templates={templates || []} employees={employees} entities={entities}
        prefill={prefill} toastOk={toastOk} toastErr={toastErr}
        onClose={() => { setSendOpen(false); onPrefillConsumed?.(); }}
        onSent={() => { loadRequests(); }} />}
      {detailId && <RequestDetailModal requestId={detailId} toastOk={toastOk} toastErr={toastErr}
        onClose={() => setDetailId(null)} onChanged={loadRequests} />}
      {editTpl !== undefined && <TemplateEditorModal template={editTpl} entities={entities}
        toastOk={toastOk} toastErr={toastErr} onClose={() => setEditTpl(undefined)} onSaved={() => loadTemplates()} />}
    </div>
  );
}
