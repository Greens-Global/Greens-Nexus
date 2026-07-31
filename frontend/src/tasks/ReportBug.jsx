// Task Module - global "Report a Bug" entry point (ported from the export's
// ReportBugButton + ReportBugModal). A floating button within the Tasks module
// that files a Bug ticket via the real ticket backend (createTicket).
import { useRef, useState } from 'react';
import { Bug, ImagePlus, X } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal, useIsMobile } from './components';
import { filesFromPaste } from './lib';
import { NX, FONT, input as inputStyle, btn, PRIORITY_ORDER } from './theme';

// Screenshots ride along in the ticket's `images` list as data URLs. Keep them
// small so a couple of shots don't bloat the row - matches the task-attachment
// inline cap used elsewhere in the module.
const MAX_SHOT = 2 * 1024 * 1024; // 2 MB per screenshot
const MAX_SHOTS = 4;

const MODULES = ['Tasks', 'Dashboard', 'Time Clock', 'My HR', 'HR', 'Item Management', 'Asset Management', 'Knowledge Base', 'Accounting', 'Other'];
const SEVERITIES = [
  { value: 'low', label: "Low - cosmetic, doesn't block work" },
  { value: 'medium', label: 'Medium - annoying, workaround exists' },
  { value: 'high', label: 'High - blocks a task, no workaround' },
  { value: 'urgent', label: 'Urgent - broken/unusable for everyone' },
];
const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };

function ReportBugModal({ onClose }) {
  const { createTicket, myEmail } = useTasks();
  const [module, setModule] = useState('Tasks');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [shots, setShots] = useState([]); // { name, url } data-URL screenshots
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const canSubmit = title.trim() && description.trim();

  const addShots = (files) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_SHOT) { alert(`"${f.name}" is over 2 MB - please attach a smaller screenshot.`); continue; }
      const r = new FileReader();
      r.onload = () => setShots((prev) => (prev.length >= MAX_SHOTS ? prev : [...prev, { name: f.name, url: String(r.result) }]));
      r.readAsDataURL(f);
    }
  };
  const onFiles = (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; addShots(files); };
  const onPaste = (e) => { const files = filesFromPaste(e); if (files.length) { e.preventDefault(); addShots(files); } };
  const removeShot = (i) => setShots((prev) => prev.filter((_, n) => n !== i));

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    const body = {
      subject: `[Bug] ${title.trim()}`,
      description: steps.trim() ? `${description.trim()}\n\nSteps to reproduce:\n${steps.trim()}` : description.trim(),
      priority: severity, requesterId: myEmail, status: 'open', tags: ['Bug', module],
      images: shots.map((s) => s.url),
    };
    try { const t = await createTicket(body); alert(`Bug reported (${t.code || 'ticket'}) - thanks for flagging it.`); onClose(); }
    catch (e) { setBusy(false); alert('Could not submit the bug report.'); }
  };

  const sel = { ...inputStyle, cursor: 'pointer' };
  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Bug size={18} style={{ color: NX.red }} /> Report a Bug</span>} width={560} onClose={onClose} footer={
      <>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit || busy} style={{ ...btn('primary'), opacity: !canSubmit || busy ? 0.55 : 1 }}>Submit Bug Report</button>
      </>
    }>
      <div onPaste={onPaste} tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 14, outline: 'none' }}>
        <div>
          <label style={label}>Module</label>
          <select value={module} onChange={(e) => setModule(e.target.value)} style={sel}>{MODULES.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </div>
        <div>
          <label style={label}>Summary</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Due date picker closes immediately on Safari" style={inputStyle} />
        </div>
        <div>
          <label style={label}>What happened?</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Describe the bug in as much detail as you can." style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>
        <div>
          <label style={label}>Steps to reproduce (optional)</label>
          <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={3} placeholder={'1. Open the task detail drawer\n2. Click the due date field\n3. …'} style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} />
        </div>
        <div>
          <label style={label}>Severity</label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={sel}>{SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        </div>
        <div>
          <label style={label}>Screenshots (optional)</label>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onFiles} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {shots.map((s, i) => (
              <div key={i} style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', border: `1px solid ${NX.border}` }}>
                <img src={s.url} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button onClick={() => removeShot(i)} title="Remove" style={{
                  position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none',
                  background: 'rgba(17,24,39,0.72)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                }}><X size={12} /></button>
              </div>
            ))}
            {shots.length < MAX_SHOTS && (
              <button onClick={() => fileRef.current?.click()} style={{
                ...btn('outline'), borderStyle: 'dashed', width: 64, height: 64, flexDirection: 'column', gap: 3,
                fontSize: 10, color: NX.dim, padding: 0,
              }}><ImagePlus size={18} /> Add</button>
            )}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: NX.faint }}>Up to {MAX_SHOTS} images, 2 MB each - or press Ctrl+V to paste a screenshot.</p>
        </div>
      </div>
    </Modal>
  );
}

export default function ReportBugButton({ bottom = 14 }) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  return (
    <>
      <button onClick={() => setOpen(true)} title="Report a bug" aria-label="Report a bug" style={{
        position: 'fixed', bottom, right: 14, zIndex: 2000, display: 'flex', alignItems: 'center', gap: isMobile ? 0 : 6,
        borderRadius: 999, border: `1px solid ${NX.border}`, background: NX.surface, color: NX.dim, cursor: 'pointer',
        padding: isMobile ? 9 : '7px 13px', fontSize: 12, fontWeight: 600, fontFamily: FONT, boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
      }}><Bug size={isMobile ? 16 : 14} />{!isMobile && ' Report a Bug'}</button>
      {open && <ReportBugModal onClose={() => setOpen(false)} />}
    </>
  );
}
