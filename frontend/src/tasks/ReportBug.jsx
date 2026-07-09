// Task Module — Report a Bug (ported from nexus/bugReport/*). A floating button
// on the module's screens opens a modal that files a [Bug] ticket (module +
// severity + steps) through the real tickets backend. Mounted in the Tasks shell.
import { useState } from 'react';
import { Bug } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal } from './components';
import { toast } from './shared';
import { NX, FONT, btn, input as inputStyle } from './theme';

// Every module in Nexus — a bug can be about any of them (verbatim from nexusModules.ts).
export const NEXUS_MODULES = [
  'Dashboard', 'Time Clock', 'My HR', 'Manager Dashboard', 'Tasks', 'Knowledge Base',
  'IT', 'Construction', 'Operations', 'Development', 'Item Management', 'Asset Management',
  'Accounting', 'Investor Relations', 'HR', 'Marketing', 'Support', 'Other',
];
const SEVERITIES = [
  { value: 'low', label: "Low — cosmetic, doesn't block work" },
  { value: 'medium', label: 'Medium — annoying, workaround exists' },
  { value: 'high', label: 'High — blocks a task, no workaround' },
  { value: 'urgent', label: 'Urgent — broken/unusable for everyone' },
];

const field = { display: 'block', marginBottom: 14 };
const labelStyle = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.ink, marginBottom: 4 };
const hintStyle = { fontSize: 11.5, color: NX.faint, fontWeight: 400, marginLeft: 6 };

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
    try {
      const ticket = await createTicket({
        subject: `[Bug] ${title.trim()}`,
        description: steps.trim() ? `${description.trim()}\n\nSteps to reproduce:\n${steps.trim()}` : description.trim(),
        priority: severity,
        requesterId: myEmail,
        tags: ['Bug', module],
      });
      toast(`Bug reported (${ticket?.code || 'ticket created'}) — thanks for flagging it.`, 'success');
      onClose();
    } catch (e) {
      toast('Could not file the report. Try again.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Report a bug" onClose={onClose} width={560}
      footer={<>
        <button onClick={onClose} style={btn('outline')}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit || busy} style={{ ...btn('primary'), opacity: !canSubmit || busy ? 0.4 : 1 }}>Submit bug report</button>
      </>}>
      <label style={field}>
        <span style={labelStyle}>Module<span style={hintStyle}>Which part of Nexus is this about?</span></span>
        <select value={module} onChange={(e) => setModule(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          {NEXUS_MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label style={field}>
        <span style={labelStyle}>Summary</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Due date picker closes immediately on Safari" style={inputStyle} />
      </label>
      <label style={field}>
        <span style={labelStyle}>What happened?<span style={hintStyle}>What did you expect, and what actually happened?</span></span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe the bug in as much detail as you can." style={{ ...inputStyle, resize: 'vertical' }} />
      </label>
      <label style={field}>
        <span style={labelStyle}>Steps to reproduce (optional)<span style={hintStyle}>One step per line.</span></span>
        <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={3} placeholder={'1. Open the task detail drawer\n2. Click the due date field\n3. …'} style={{ ...inputStyle, resize: 'vertical' }} />
      </label>
      <label style={{ ...field, marginBottom: 0 }}>
        <span style={labelStyle}>Severity</span>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
    </Modal>
  );
}

export default function ReportBugButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Report a bug" style={{
        position: 'absolute', bottom: 12, right: 12, zIndex: 200, fontFamily: FONT,
        display: 'flex', alignItems: 'center', gap: 6, borderRadius: 999,
        border: `1px solid ${NX.border}`, background: NX.surface, color: NX.dim,
        padding: '7px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        boxShadow: '0 6px 18px rgba(0,0,0,0.12)',
      }}
        onMouseEnter={(e) => { e.currentTarget.style.color = NX.red; e.currentTarget.style.background = NX.hover; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = NX.dim; e.currentTarget.style.background = NX.surface; }}>
        <Bug size={14} /> Report a bug
      </button>
      {open && <ReportBugModal onClose={() => setOpen(false)} />}
    </>
  );
}
