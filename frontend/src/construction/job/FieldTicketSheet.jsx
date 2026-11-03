// A Field Ticket - extra work signed on site (Neil, 11/03/2026, plan phase 3).
// Time and material, quantities only: what was done (typed or said - the
// browser's own dictation, no AI), labor hours (from today's Time Clock
// punches at the jobsite if the person wants - hours only), materials, photos,
// and the customer's or owner's signature drawn on this phone with Nexus Sign's
// own signature pad (components/ESign.jsx SignaturePad - never a second
// engine). Nobody prices anything here: a job manager makes the change order
// from it. With no signal the whole ticket - photos and signature - waits on
// the phone and the outbox sends it once (constructionOffline.sendFieldTicket).
import { lazy, Suspense, useRef, useState } from 'react';
import { Camera, PenTool, Plus, Trash2, X, Clock } from 'lucide-react';
import { api } from '../../api';
import DictateButton from '../../components/DictateButton';
import SyncState from '../../components/offline/SyncState';
import { DateField } from '../../tasks/components';
import { isOffline } from '../../lib/offline/store';
import { clientId } from '../lib/job';
import { validate } from '../lib/upload';
import { sendFieldTicket } from '../constructionOffline';

const SignaturePad = lazy(() => import('../../components/ESign').then((m) => ({ default: m.SignaturePad })));

function dataUrlFile(dataUrl, name) {
  try {
    const [head, b64] = String(dataUrl || '').split(',');
    const mime = (/data:([^;]+)/.exec(head) || [])[1] || 'image/png';
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  } catch { return null; }
}

const row = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 };

export default function FieldTicketSheet({ project, today, onClose, onSent }) {
  const [id] = useState(() => clientId('ft'));
  const [description, setDescription] = useState('');
  const [workDate, setWorkDate] = useState(today || project.today || '');
  const [labor, setLabor] = useState([]);             // [{email, name, hours}]
  const [fromPunches, setFromPunches] = useState(false);
  const [materials, setMaterials] = useState([{ description: '', quantity: '', unit: '' }]);
  const [photos, setPhotos] = useState([]);           // File[]
  const [customer, setCustomer] = useState('');
  const [email, setEmail] = useState('');
  const [signature, setSignature] = useState(null);   // { file, preview, name }
  const [padOpen, setPadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState('');
  const descRef = useRef(null);
  const camRef = useRef(null);

  const usePunches = async () => {
    setError('');
    if (isOffline()) { setError('The Time Clock hours need signal - type the hours instead.'); return; }
    try {
      const got = await api.getFieldTicketLabor(project.id, workDate);
      setLabor(got.lines || []);
      setFromPunches(true);
      if (!(got.lines || []).length) setError('No Time Clock hours at this jobsite on that day yet.');
    } catch (e) { setError(e.message || 'Could not read the hours.'); }
  };
  const addPhotos = (files) => {
    const ok = [];
    for (const f of Array.from(files || [])) { const why = validate(f); if (why) setError(why); else ok.push(f); }
    setPhotos((p) => [...p, ...ok]);
  };
  const adopt = ({ data, typedName: name }) => {
    setPadOpen(false);
    const file = dataUrlFile(data, `signature-${Date.now()}.png`);
    if (!file) { setError('The signature could not be saved - sign again.'); return; }
    setSignature({ file, preview: data, name: name || customer });
    if (!customer && name) setCustomer(name);
  };
  const totalHours = labor.reduce((n, l) => n + (Number(l.hours) || 0), 0);
  const canSend = description.trim() && signature && customer.trim() && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true); setError('');
    const body = {
      description: description.trim(), work_date: workDate, labor_from_punches: fromPunches,
      labor: labor.map((l) => ({ ...l, hours: Number(l.hours) || 0 })),
      materials: materials.filter((m) => m.description.trim()).map((m) => ({ ...m, quantity: m.quantity === '' ? null : Number(m.quantity) })),
      customer_name: customer.trim(), customer_email: email.trim(), signed_name: signature.name || customer.trim(),
    };
    try {
      const out = await sendFieldTicket(project.id, id, body, photos, signature.file);
      if (out?.queued) { setQueued(out.queued.id); setBusy(false); return; }
      onSent?.(out?.result);
    } catch (e) { setError(e.message || 'Could not send the field ticket.'); setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content nx-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Field Ticket"
        style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Field Ticket</h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
              Extra work on {project.name}: what was done, the hours and materials, signed by the customer. A manager prices it later.
            </p>
          </div>
          <button className="secondary-btn" onClick={onClose} aria-label="Close" style={{ padding: 8, minWidth: 40, minHeight: 40, alignSelf: 'flex-start' }}><X size={18} /></button>
        </div>
        {error && <div role="alert" style={{ fontSize: '0.84rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
        {queued ? (
          <div style={{ padding: 16, border: '1px solid var(--border-color)', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <b>Saved on This Phone</b>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>The ticket, its photos and the signature are kept here and go out when there is signal.</span>
            <SyncState id={queued} />
            <div><button className="primary-btn" onClick={() => onSent?.(null)}>Done</button></div>
          </div>
        ) : (
          <div className="nx-scroll nx-fill" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label className="form-label" htmlFor="ft-desc" style={{ margin: 0 }}>What Was Done</label>
                <DictateButton target={descRef} title="Say What Was Done" />
              </div>
              <textarea id="ft-desc" ref={descRef} className="form-input" rows={3} value={description}
                onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Moved the gas line 6 ft north at the owner's request" />
            </div>
            <div style={row}>
              <div>
                <span className="form-label" style={{ display: 'block' }}>Work Date</span>
                <DateField value={workDate} onChange={(v) => setWorkDate(v || '')} title="Work Date" />
              </div>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <span className="form-label" style={{ margin: 0 }}>Labor {totalHours ? `(${totalHours} h)` : ''}</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem' }} onClick={usePunches}><Clock size={13} />Use Time Clock Hours</button>
                  <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                    onClick={() => { setLabor((l) => [...l, { email: '', name: '', hours: '' }]); setFromPunches(false); }}><Plus size={13} />Add Line</button>
                </span>
              </div>
              {labor.map((l, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <input className="form-input" aria-label="Who" value={l.name} placeholder="Who"
                    onChange={(e) => setLabor((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} style={{ flex: 2 }} />
                  <input className="form-input" aria-label="Hours" inputMode="decimal" type="number" min="0" step="0.25" value={l.hours} placeholder="Hours"
                    onChange={(e) => { setFromPunches(false); setLabor((x) => x.map((y, j) => (j === i ? { ...y, hours: e.target.value } : y))); }} style={{ flex: 1 }} />
                  <button type="button" className="secondary-btn" aria-label="Remove this line" style={{ padding: 8 }}
                    onClick={() => setLabor((x) => x.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div>
              <span className="form-label">Materials</span>
              {materials.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <input className="form-input" aria-label="Material" value={m.description} placeholder="e.g. 3/4 in black pipe"
                    onChange={(e) => setMaterials((x) => x.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} style={{ flex: 3 }} />
                  <input className="form-input" aria-label="Quantity" type="number" min="0" inputMode="decimal" value={m.quantity} placeholder="Qty"
                    onChange={(e) => setMaterials((x) => x.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y)))} style={{ flex: 1 }} />
                  <input className="form-input" aria-label="Unit" value={m.unit} placeholder="Unit"
                    onChange={(e) => setMaterials((x) => x.map((y, j) => (j === i ? { ...y, unit: e.target.value } : y)))} style={{ flex: 1 }} />
                </div>
              ))}
              <button type="button" className="secondary-btn" style={{ marginTop: 6, padding: '6px 10px', fontSize: '0.8rem' }}
                onClick={() => setMaterials((x) => [...x, { description: '', quantity: '', unit: '' }])}><Plus size={13} />Add Material</button>
            </div>
            <div>
              <span className="form-label">Photos</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {photos.map((f, i) => (
                  <span key={i} style={{ position: 'relative' }}>
                    <img src={URL.createObjectURL(f)} alt={`Photo ${i + 1}`} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
                    <button type="button" aria-label="Remove this photo" onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))}
                      style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,.55)', color: '#fff', border: 'none', borderRadius: 4, padding: 2 }}><X size={11} /></button>
                  </span>
                ))}
                <button type="button" className="secondary-btn" onClick={() => camRef.current?.click()}><Camera size={14} />Add Photo</button>
                <input ref={camRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
              </div>
            </div>
            <div style={row}>
              <label className="form-label" style={{ margin: 0 }}>Customer or Owner
                <input className="form-input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Their name" />
              </label>
              <label className="form-label" style={{ margin: 0 }}>Their Email (optional)
                <input className="form-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="For the change order" />
              </label>
            </div>
            <div>
              <span className="form-label">Customer Signature</span>
              {signature && (
                <div style={{ padding: 8, border: '1px solid var(--border-color)', borderRadius: 10, background: '#fff', display: 'inline-block', marginBottom: 8 }}>
                  <img src={signature.preview} alt="Customer signature" style={{ height: 56, display: 'block', maxWidth: '100%' }} />
                </div>
              )}
              <div><button type="button" className="secondary-btn" onClick={() => setPadOpen(true)}><PenTool size={14} />{signature ? 'Sign Again' : 'Hand to Customer to Sign'}</button></div>
            </div>
          </div>
        )}
        {!queued && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
            <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-btn" onClick={send} disabled={!canSend}
              title={!description.trim() ? 'Say what was done' : !signature ? 'The customer signs first' : !customer.trim() ? 'Name the customer' : ''}>
              {busy ? 'Sending…' : 'Send Field Ticket'}
            </button>
          </div>
        )}
        {padOpen && (
          <Suspense fallback={null}>
            <SignaturePad name={customer} onAdopt={adopt} onClose={() => setPadOpen(false)} zIndex={4300} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
