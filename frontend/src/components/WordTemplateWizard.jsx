// Documents > Templates > From Word File (Oct 14). "Adding a template is hell"
// (Pranshu, after building one by hand on dev): every blank took four clicks,
// a new variable could not be created, signature lines were found one by one.
// Here HR uploads the Word file once and confirms what Nexus found
// (lib/wordBlanks.js) - every blank with what fills it, every signature line
// with who signs - and gets a published template with all of it in place.
import { useMemo, useRef, useState } from 'react';
import { X, Upload, FileText, CheckCircle, PenTool, Eye, ExternalLink, AlertTriangle, ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { importDocumentFile } from '../lib/docBuilderImport';
import { repairDocJson } from '../lib/docBuilderSchema';
import { uploadToSupabase } from '../lib/docBuilderUpload';
import { NEXUS_FIELDS, applyBlanks, findBlanks, splitPages, tokensFor } from '../lib/wordBlanks';
import { Spinner } from './AsyncState';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '14px 0 5px', textTransform: 'uppercase', letterSpacing: '.04em' };
const th = { fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--card)' };
const td = { fontSize: 12.5, padding: '7px 8px', borderBottom: '1px solid var(--line)', verticalAlign: 'middle' };
const FILL_LABEL = { nexus: 'Nexus Fills It', ask: 'Ask The Person', same: 'Same For Everyone', leave: 'Left Blank' };

const valueOf = (b) => (b.fill === 'nexus' ? `nexus:${b.token}` : b.fill);

export default function WordTemplateWizard({ categories, onClose, onOpen, toastErr }) {
  const [step, setStep] = useState('upload');           // upload | review | done
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('hr');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [doc, setDoc] = useState(null);                 // {json, pageSetup}
  const [blanks, setBlanks] = useState([]);
  const [created, setCreated] = useState(null);
  const inputRef = useRef(null);

  const pick = (f) => {
    if (!f) return;
    setFile(f); setError('');
    if (!name) setName(f.name.replace(/\.docx?$/i, '').replace(/[_]+/g, ' ').trim());
  };
  async function read() {
    setBusy('read'); setError('');
    try {
      const uploadImage = async (bytes, mime, n) => {
        const ext = (mime || '').split('/')[1]?.split('+')[0] || 'png';
        const img = new File([bytes], `imported-${n}.${ext}`, { type: mime || 'image/png' });
        const { url, error: e } = await uploadToSupabase(img, 'document-images', `templates/imported-${Date.now()}-${n}.${ext}`);
        return e ? '' : url;
      };
      const out = await importDocumentFile(file, { uploadImage });
      if (!out?.json) throw new Error('Pick a Word file (.docx).');
      const json = repairDocJson(out.json);
      setDoc({ json, pageSetup: out.pageSetup || null });
      setBlanks(findBlanks(json));
      setStep('review');
    } catch (e) { setError(e?.message || 'Could not read the file.'); }
    setBusy('');
  }
  const setBlank = (id, patch) => setBlanks(list => list.map(b => (b.id === id ? { ...b, ...patch } : b)));
  const choose = (b, v) => {
    if (v.startsWith('nexus:')) setBlank(b.id, { fill: 'nexus', token: v.slice(6) });
    else setBlank(b.id, { fill: v, token: undefined });
  };
  const sigs = blanks.filter(b => b.kind === 'signature');
  const fields = blanks.filter(b => b.kind !== 'signature');
  const counts = useMemo(() => fields.reduce((m, b) => ({ ...m, [b.fill]: (m[b.fill] || 0) + 1 }), {}), [fields]);
  const tokens = useMemo(() => tokensFor(blanks), [blanks]);
  const tokenById = Object.fromEntries(blanks.map((b, i) => [b.id, tokens[i]]));
  const missingValues = fields.filter(b => b.fill === 'same' && !String(b.value || '').trim());

  async function create() {
    setBusy('create'); setError('');
    try {
      const { doc: built, fieldDefs } = applyBlanks(doc.json, blanks);
      // Company and Employee are always this template's signers - adding a
      // signature block later never means typing a new signer first.
      const roles = [{ key: 'company', label: 'Company' }, { key: 'employee', label: 'Employee' }];
      const row = await api.createDocTemplate({
        name: name.trim(), category, status: 'active',
        content: { pages: splitPages(built), ...(doc.pageSetup ? { pageSetup: doc.pageSetup } : {}) },
        fieldDefs, signerRoles: roles,
      });
      const pub = await api.publishDocTemplate(row.id, `Created from ${file?.name || 'a Word file'}`);
      setCreated({ id: row.id, name: name.trim(), version: pub?.publishedVersion || 1,
        variables: new Set(tokens.filter(Boolean)).size, signatures: sigs.filter(s => s.fill === 'sign').length });
      setStep('done');
    } catch (e) {
      setError(e?.message || 'Could not create the template.');
      toastErr?.(e?.message || 'Could not create the template.');
    }
    setBusy('');
  }
  async function preview() {
    try {
      const { blob } = await api.renderPacketPreview({ template_id: created.id, entity_id: '', flow: [] });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { toastErr?.(e?.message || 'Could not render the preview.'); }
  }

  return (
    <div onClick={e => e.target === e.currentTarget && !busy && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: step === 'review' ? 'clamp(640px, 72vw, 1180px)' : 560, maxHeight: 'min(94dvh, 940px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileText size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>New Template From A Word File</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>
              {step === 'upload' ? 'Nexus reads the file and finds every blank and signature line for you.'
                : step === 'review' ? 'Check what fills each blank - most are right already. Change only what is wrong.'
                  : 'Done - published and ready for a packet.'}
            </div>
          </div>
          <button onClick={onClose} disabled={!!busy} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '6px 22px 18px' }}>
          {step === 'upload' && (
            <>
              <div onClick={() => inputRef.current?.click()} onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
                style={{ marginTop: 14, border: '1.5px dashed var(--line)', borderRadius: 14, padding: '26px 16px', textAlign: 'center', cursor: 'pointer', background: 'var(--mist)' }}>
                <Upload size={22} style={{ color: 'var(--muted)' }} />
                <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 6 }}>{file ? file.name : 'Drop the Word file here, or click to choose'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>.docx - the page size, tables and fonts come across as they are.</div>
                <input ref={inputRef} type="file" accept=".docx" style={{ display: 'none' }} aria-label="Word file" onChange={e => pick(e.target.files?.[0])} />
              </div>
              <label style={lbl}>Template Name</label>
              <input className="form-input" style={{ width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Admin Associate - Onboarding Package" />
              <label style={lbl}>Category</label>
              <select className="form-input" style={{ width: '100%' }} value={category} onChange={e => setCategory(e.target.value)} aria-label="Category">
                {(categories || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </>
          )}

          {step === 'review' && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 4px' }}>
                {['nexus', 'ask', 'same', 'leave'].map(k => (
                  <span key={k} style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 12, background: 'var(--mist)' }}>
                    {FILL_LABEL[k]}: {counts[k] || 0}
                  </span>
                ))}
                <span style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 12, background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))' }}>
                  Signature Spots: {sigs.filter(s => s.fill === 'sign').length}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                <b>Nexus fills it</b> - from the hire (name, company, start date, pay...). <b>Ask the person</b> - their own details (ID numbers, bank...); a packet asks for them on its Details Form.
                {' '}<b>Same for everyone</b> - typed once here (a client's name). <b>Left blank</b> - stays as it is, filled by hand.
              </div>

              {sigs.length > 0 && (
                <>
                  <label style={lbl}>Signature Lines ({sigs.length})</label>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
                    {sigs.map(b => (
                      <div key={b.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                        <PenTool size={14} style={{ color: 'var(--pine)', flexShrink: 0 }} />
                        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{b.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{b.context}"{b.absorb?.length ? ' - and the Date / Name lines under it' : ''}</div>
                        </div>
                        <select className="form-input" style={{ width: 210, fontSize: 12.5 }} aria-label={`Who signs ${b.label}`}
                          value={b.fill === 'sign' ? b.who : 'leave'}
                          onChange={e => setBlank(b.id, e.target.value === 'leave' ? { fill: 'leave' } : { fill: 'sign', who: e.target.value })}>
                          <option value="employee">The Person Signs Here</option>
                          <option value="company">The Company Signs Here</option>
                          <option value="leave">Not A Signature - Leave It</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <label style={lbl}>Blanks ({fields.length})</label>
              <div style={{ border: '1px solid var(--line)', borderRadius: 12, maxHeight: 'min(48dvh, 520px)', overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Blank</th><th style={th}>Where</th><th style={th}>Filled With</th><th style={th}>Variable</th></tr></thead>
                  <tbody>
                    {fields.map(b => (
                      <tr key={b.id} style={{ background: b.fill === 'leave' ? 'transparent' : undefined }}>
                        <td style={{ ...td, fontWeight: 700, maxWidth: 220 }}>{b.label}</td>
                        <td style={{ ...td, color: 'var(--muted)', fontSize: 11.5, maxWidth: 300 }}>
                          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.context}>{b.kind === 'cell' ? 'Table' : b.context}</span>
                        </td>
                        <td style={{ ...td, minWidth: 230 }}>
                          <select className="form-input" style={{ width: '100%', fontSize: 12.5 }} value={valueOf(b)} onChange={e => choose(b, e.target.value)} aria-label={`What fills ${b.label}`}>
                            <optgroup label="Nexus Fills It">
                              {NEXUS_FIELDS.map(([k, l]) => <option key={k} value={`nexus:${k}`}>{l}</option>)}
                            </optgroup>
                            <option value="ask">Ask The Person</option>
                            <option value="same">Same For Everyone</option>
                            <option value="leave">Leave Blank</option>
                          </select>
                          {b.fill === 'same' && (
                            <input className="form-input" style={{ width: '100%', fontSize: 12.5, marginTop: 5 }} placeholder="Type it once - e.g. the client's name"
                              value={b.value || ''} onChange={e => setBlank(b.id, { value: e.target.value })} aria-label={`Value for ${b.label}`} />
                          )}
                        </td>
                        <td style={{ ...td, fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{tokenById[b.id] ? `{{${tokenById[b.id]}}}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {missingValues.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>Type the value for {missingValues.map(b => b.label).join(', ')} - or it is asked of HR on every hire.</span>
                </div>
              )}
            </>
          )}

          {step === 'done' && created && (
            <div style={{ textAlign: 'center', padding: '22px 6px 6px' }}>
              <CheckCircle size={34} style={{ color: 'hsl(var(--color-green))' }} />
              <div style={{ fontSize: 16, fontWeight: 800, marginTop: 8 }}>{created.name}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
                Published v{created.version} - {created.variables} variable{created.variables === 1 ? '' : 's'}, {created.signatures} signature spot{created.signatures === 1 ? '' : 's'}.
              </div>
              <div style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.6, textAlign: 'left', background: 'var(--mist)', borderRadius: 12, padding: '10px 14px' }}>
                Next: add it to a packet in <b>People &gt; Hiring &gt; Packets</b>. The packet's <b>Ready To Send</b> checklist offers to put every "Ask the person" field on its Details Form in one click.
              </div>
            </div>
          )}
          {error && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-red),0.1)', color: 'hsl(var(--color-red))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 12 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{error}</span>
            </div>
          )}
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0, flexWrap: 'wrap' }}>
          {step === 'upload' && (
            <>
              <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
              <button type="button" className="primary-btn" onClick={read} disabled={!file || !name.trim() || !!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy === 'read' ? <Spinner size={13} /> : <FileText size={13} />} Read The File
              </button>
            </>
          )}
          {step === 'review' && (
            <>
              <button type="button" className="secondary-btn" onClick={() => setStep('upload')} disabled={!!busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 'auto' }}><ArrowLeft size={13} /> Back</button>
              <button type="button" className="secondary-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
              <button type="button" className="primary-btn" onClick={create} disabled={!!busy || !name.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy === 'create' ? <Spinner size={13} /> : <CheckCircle size={13} />} Create And Publish
              </button>
            </>
          )}
          {step === 'done' && (
            <>
              <button type="button" className="secondary-btn" onClick={preview} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Eye size={13} /> Preview With Sample Person</button>
              <button type="button" className="secondary-btn" onClick={() => onOpen?.(created.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ExternalLink size={13} /> Open In Editor</button>
              <button type="button" className="primary-btn" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
