// Task Module — global "Report a Bug" entry point (ported from the export's
// ReportBugButton + ReportBugModal). A floating button within the Tasks module
// that files a Bug ticket via the real ticket backend (createTicket).
import { useState } from 'react';
import { Bug } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal } from './components';
import { NX, FONT, input as inputStyle, btn, PRIORITY_ORDER } from './theme';

const MODULES = ['Tasks', 'Dashboard', 'Time Clock', 'My HR', 'HR', 'Item Management', 'Asset Management', 'Knowledge Base', 'Accounting', 'Other'];
const SEVERITIES = [
  { value: 'low', label: "Low — cosmetic, doesn't block work" },
  { value: 'medium', label: 'Medium — annoying, workaround exists' },
  { value: 'high', label: 'High — blocks a task, no workaround' },
  { value: 'urgent', label: 'Urgent — broken/unusable for everyone' },
];
const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };

function ReportBugModal({ onClose }) {
  const { createTicket, myEmail } = useTasks();
  const [module, setModule] = useState('Tasks');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [busy, setBusy] = useState(false);
  const canSubmit = title.trim() && description.trim();

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    const body = {
      subject: `[Bug] ${title.trim()}`,
      description: steps.trim() ? `${description.trim()}\n\nSteps to reproduce:\n${steps.trim()}` : description.trim(),
      priority: severity, requesterId: myEmail, status: 'open', tags: ['Bug', module],
    };
    try { const t = await createTicket(body); alert(`Bug reported (${t.code || 'ticket'}) — thanks for flagging it.`); onClose(); }
    catch (e) { setBusy(false); alert('Could not submit the bug report.'); }
  };

  const sel = { ...inputStyle, cursor: 'pointer' };
  return (
    <Modal title="Report a Bug" width={560} onClose={onClose} footer={
      <>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit || busy} style={{ ...btn('primary'), opacity: !canSubmit || busy ? 0.55 : 1 }}>Submit bug report</button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
      </div>
    </Modal>
  );
}

export default function ReportBugButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Report a bug" style={{
        position: 'fixed', bottom: 14, right: 14, zIndex: 2000, display: 'flex', alignItems: 'center', gap: 6,
        borderRadius: 999, border: `1px solid ${NX.border}`, background: NX.surface, color: NX.dim, cursor: 'pointer',
        padding: '7px 13px', fontSize: 12, fontWeight: 600, fontFamily: FONT, boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
      }}><Bug size={14} /> Report a Bug</button>
      {open && <ReportBugModal onClose={() => setOpen(false)} />}
    </>
  );
}
