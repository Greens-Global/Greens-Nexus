// Drawings, the current set (Round Two item 9, Neil, 11/06/2026 - register
// only, no pins): every sheet on the Project with its revision, Current or
// Superseded. A new revision of a sheet number supersedes the one before
// (kept, shown under Show Superseded) and the server bells the crew and the
// managers. The file goes up like every job file (lib/upload.js, the private
// construction-media bucket) and the Egnyte sweep files it under the job's
// Drawings folder; once there, a PDF opens in PDF Tools.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileStack, Plus, Upload } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { DateField, Modal } from '../../tasks/components';
import { formatDate } from '../../lib/datetime';
import { isPdfName, openEgnyteInPdfTools } from '../../lib/pdfToolsHandoff';
import { CARD, TONE } from '../ui';
import { useLoad } from '../lib/job';
import { filesFromPaste, uploadConstructionMedia, validate } from '../lib/upload';

const DISCIPLINES = ['Architectural', 'Structural', 'Civil', 'Mechanical', 'Electrical', 'Plumbing', 'Fire Protection', 'Landscape', 'Other'];
const quiet = { fontSize: '0.82rem', color: 'var(--text-secondary)' };

function DrawingSheet({ project, base, onClose, onSaved }) {
  const [f, setF] = useState({ sheet: base?.sheetNumber || '', title: base?.title || '', discipline: base?.discipline || '', revision: '', revisionOn: '' });
  const [file, setFile] = useState(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : (e || '') }));
  const take = useCallback((files) => {
    const one = Array.from(files || [])[0];
    if (!one) return;
    const why = validate(one, 'drawing');
    setError(why);
    if (!why) setFile(one);
  }, []);
  // Ctrl+V anywhere in the sheet but a text box (the house upload rule).
  useEffect(() => {
    const onPaste = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = filesFromPaste(e);
      if (files.length) { e.preventDefault(); take(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [take]);
  const dirty = !!(file || f.revision || (!base && (f.sheet || f.title)));
  const save = async () => {
    if (busy) return;
    if (!f.sheet.trim() || !f.revision.trim() || !file) { setError('Give the sheet number, the revision and the file.'); return; }
    setBusy(true); setError('');
    const { payload, error: upErr } = await uploadConstructionMedia(file, { projectId: project.id, kind: 'drawing' });
    if (upErr) { setError(upErr); setBusy(false); return; }
    try {
      await api.addJobDrawing(project.id, { sheet_number: f.sheet, title: f.title, discipline: f.discipline, revision: f.revision, revision_on: f.revisionOn, file: payload });
      setBusy(false);
      onSaved();
    } catch (err) { setError(err?.message || 'Could not add that sheet.'); setBusy(false); }
  };
  const input = (k, label, ph = '', extra = {}) => (
    <label className="form-label" style={{ margin: 0 }}>{label}<input className="form-input" value={f[k]} onChange={set(k)} placeholder={ph} {...extra} /></label>
  );
  return (
    <Modal title={base ? `New Revision of ${base.sheetNumber}` : 'Add Sheet'} onClose={onClose} width={640} isDirty={dirty} onSave={save}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={base ? 'New Revision' : 'Add Sheet'} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {base && <div style={quiet}>Now current: Rev {base.revision}{base.revisionOn ? ` of ${formatDate(base.revisionOn, base.revisionOn)}` : ''}. It is kept as Superseded and the crew and managers are told.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          {input('sheet', 'Sheet Number', 'e.g. A-201', { readOnly: !!base })}
          {input('revision', 'Revision', 'e.g. 3')}
          <div><span className="form-label" style={{ display: 'block' }}>Revision Date</span><DateField value={f.revisionOn} onChange={set('revisionOn')} title="Revision Date" /></div>
          <label className="form-label" style={{ margin: 0 }}>Discipline
            <select className="form-input" value={f.discipline} onChange={set('discipline')}>
              <option value="">Not Set</option>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>
        {input('title', 'Title', 'e.g. First Floor Plan')}
        <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files); }}
          style={{ border: `1px dashed ${over ? 'var(--color-primary, #16a34a)' : 'var(--border-color)'}`, borderRadius: 8, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" onClick={() => inputRef.current?.click()}><Upload size={14} />Choose File</button>
          <input ref={inputRef} type="file" accept="application/pdf,image/png,image/jpeg" aria-label="Sheet File" style={{ display: 'none' }}
            onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
          <span style={quiet}>{file ? <b style={{ color: 'var(--text-primary)' }}>{file.name}</b> : 'A PDF or a scan of the sheet. Drop it here, choose it, or press Ctrl+V to paste it.'}</span>
        </div>
        {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
        <div><button type="submit" className="primary-btn" disabled={busy}><Plus size={14} />{busy ? 'Uploading…' : base ? 'Add Revision' : 'Add Sheet'}</button></div>
      </form>
    </Modal>
  );
}

export default function DrawingsTab({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobDrawings(project.id), project.id);
  const [showOld, setShowOld] = useState(false);
  const [sheet, setSheet] = useState(null);   // null closed, {} Add Sheet, a drawing = New Revision of it
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={2} height={56} borderRadius={8} />;
  const all = data.drawings || [];
  const current = all.filter((d) => d.status === 'current');
  const shown = (showOld ? all : current).slice()
    .sort((a, b) => a.sheetNumber.localeCompare(b.sheetNumber, undefined, { numeric: true }) || (a.status === 'current' ? -1 : 1));
  const old = all.length - current.length;
  return (
    <section style={{ ...CARD, marginBottom: 14 }} aria-label="Drawings">
      <h3 style={{ fontSize: '1.05rem', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><FileStack size={16} />Drawings</h3>
      <p style={{ ...quiet, margin: '0 0 12px' }}>
        {current.length === 0 ? 'No sheets yet. ' : `${current.length} current sheet${current.length === 1 ? '' : 's'}${old ? `, ${old} superseded` : ''}. `}
        Build from the current sheet only. A new revision supersedes the one before and tells the crew and the managers.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {data.canEdit && <button type="button" className="primary-btn" onClick={() => setSheet({})}><Plus size={14} />Add Sheet</button>}
        {old > 0 && (
          <button type="button" className="secondary-btn" aria-pressed={showOld} onClick={() => setShowOld((v) => !v)}>
            {showOld ? 'Hide Superseded' : 'Show Superseded'}
          </button>
        )}
      </div>
      {shown.map((d) => {
        const live = d.status === 'current';
        return (
          <div key={d.id} data-drawing={d.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '9px 0', borderTop: '1px solid var(--border-color)', opacity: live ? 1 : 0.7 }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={{ fontSize: '0.88rem' }}><b>{d.sheetNumber}</b>{d.title ? ` · ${d.title}` : ''}</div>
              <div style={quiet}>{[`Rev ${d.revision}`, d.revisionOn ? formatDate(d.revisionOn, d.revisionOn) : '', d.discipline].filter(Boolean).join(' · ')}</div>
            </div>
            <StatusLabel size="sm" label={live ? 'Current' : 'Superseded'} color={live ? TONE.green : TONE.slate} />
            {d.fileUrl && <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem' }}>Open File</a>}
            {d.egnytePath && isPdfName(d.egnytePath) && (
              <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                onClick={() => openEgnyteInPdfTools({ path: d.egnytePath, name: d.egnytePath.split('/').pop() })}>Open In PDF Tools</button>
            )}
            {data.canEdit && live && (
              <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem' }} onClick={() => setSheet(d)}>New Revision</button>
            )}
            {data.canEdit && (
              <HoldButton label="Remove" ariaLabel={`Remove ${d.sheetNumber} Rev ${d.revision}`} doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                onConfirm={() => api.removeJobDrawing(d.id).then(reload)} fallbackMessage="Take this sheet off the register?" />
            )}
          </div>
        );
      })}
      {sheet && <DrawingSheet project={project} base={sheet.id ? sheet : null} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); reload(); }} />}
    </section>
  );
}
