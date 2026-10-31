// Add Several (Neil, Oct 31 2026): the one confirmation surface for many
// tasks at once. Every multi-line paste into an add row (Home, My Day, the
// Create Task title, the phone quick-add) opens it with the lines, and the
// Create form's Add Several button opens it with the typed title as the
// first line. The person checks the lines (one per line, Tab indents a
// subtask), sets what every task shares - project, section, who, due date,
// priority - and clicks Add N Tasks. The rows go to POST /tasks/import,
// the CSV / Excel engine (batchPaste.importRowsFor; source "paste" or
// "typed"): a dry run first, so a row the server would refuse is shown here
// and nothing is written, then the real run - one transaction, one bell and
// one batched email per person, never one per task.
import { useMemo, useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal, PersonMultiSelect, usePeople, DateField } from './components';
import ProjectPicker from './ProjectPicker';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { parseTaskLines, importRowsFor, countLines, countLabel, linesToText, newBatchId } from './batchPaste';

const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };

export default function AddSeveralModal({ defaults = {}, onClose, onDone }) {
  const store = useTasks();
  const { projects = [], teams = [], sections = [], myEmail, importTasks } = store;
  const people = usePeople(true);
  const [text, setText] = useState(() => {
    const given = defaults.text || '';
    // A single typed title arrives as text too; the box opens with it as the first line.
    return linesToText(parseTaskLines(given));
  });
  const [projectId, setProjectId] = useState(defaults.projectId || '');
  const [sectionId, setSectionId] = useState(defaults.sectionId || '');
  const [assigneeIds, setAssigneeIds] = useState(defaults.assigneeIds || (myEmail ? [myEmail] : []));
  const [dueOn, setDueOn] = useState(defaults.dueOn || '');
  const [priority, setPriority] = useState(defaults.priority || 'medium');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);   // [{ row, title, errors }] from the dry run
  const [err, setErr] = useState('');
  const [batchId] = useState(newBatchId);
  const boxRef = useRef(null);

  const lines = useMemo(() => parseTaskLines(text), [text]);
  const { tasks: topCount } = countLines(lines);
  const projectSections = useMemo(
    () => sections.filter((s) => s.custom && s.projectId === projectId).sort((a, b) => (a.position || 0) - (b.position || 0)),
    [sections, projectId]);

  // Tab indents the current line (a subtask), Shift+Tab outdents it; the key
  // never leaves the box - the whole point of the box is the indent.
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    let next, caret;
    if (e.shiftKey) {
      const m = /^(\t| {1,2})/.exec(value.slice(lineStart));
      if (!m) return;
      next = value.slice(0, lineStart) + value.slice(lineStart + m[0].length);
      caret = Math.max(lineStart, s - m[0].length);
    } else {
      next = value.slice(0, lineStart) + '\t' + value.slice(lineStart);
      caret = s + 1;
    }
    setText(next);
    requestAnimationFrame(() => { el.setSelectionRange(caret, caret + (en - s)); });
  };

  const request = (dry) => ({
    project_id: projectId || '', section_id: projectId ? (sectionId || '') : '',
    source: defaults.source || 'paste', import_id: batchId, dry_run: dry, notify_assignees: true,
    rows: importRowsFor(lines, { assigneeIds, dueOn, priority, customFieldValues: defaults.customFieldValues }),
  });

  const submit = async () => {
    if (!topCount || busy) return;
    setBusy(true); setErr(''); setProblems([]);
    try {
      const dry = await importTasks(request(true));
      const errors = dry?.errors || [];
      if (errors.length) { setProblems(errors); setBusy(false); return; }
      const r = await importTasks(request(false));
      onDone?.(r);
      onClose?.(true);
    } catch (e) {
      setErr(e?.message || 'The tasks could not be added.');
      setBusy(false);
    }
  };

  const addLabel = topCount ? `Add ${topCount} Task${topCount === 1 ? '' : 's'}` : 'Add Tasks';
  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <span role="status" style={{ fontSize: 13, color: NX.dim, flex: 1, minWidth: 0 }}>{countLabel(lines)}</span>
      <button type="button" onClick={() => onClose?.(false)} disabled={busy} style={btn('outline')}>Cancel</button>
      <button type="button" onClick={submit} disabled={!topCount || busy} style={btn('primary')}>
        <ListPlus size={15} /> {busy ? 'Adding...' : addLabel}
      </button>
    </div>
  );

  return (
    <Modal title="Add Several Tasks" onClose={() => { if (!busy) onClose?.(false); }} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0, fontFamily: FONT }}>
        {err && (
          <div role="alert" style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', color: NX.red, fontSize: 13 }}>{err}</div>
        )}
        <div className="nx-fill">
          <label style={label} htmlFor="nx-add-several">Tasks</label>
          <textarea id="nx-add-several" ref={boxRef} autoFocus value={text} onChange={(e) => { setText(e.target.value); setProblems([]); }}
            onKeyDown={onKeyDown} spellCheck
            placeholder={'Call the bank\n\tAsk for the statement\nFile the receipts'}
            style={{ ...inputStyle, fontSize: 14, lineHeight: 1.5, tabSize: 4, whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto' }} />
          <div style={{ fontSize: 12, color: NX.faint, marginTop: 5 }}>One task per line. Tab indents a subtask.</div>
        </div>
        {problems.length > 0 && (
          <div role="alert" style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', fontSize: 13, color: NX.ink }}>
            <div style={{ fontWeight: 600, color: NX.red, marginBottom: 4 }}>Nothing was added. Fix these lines and try again:</div>
            {problems.map((p) => (
              <div key={p.row} data-testid="add-several-problem">Line {p.row}{p.title ? ` "${p.title}"` : ''}: {(p.errors || []).join(' ')}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 12 }}>
          <div>
            <label style={label}>Project</label>
            <ProjectPicker projects={projects} teams={teams} myEmail={myEmail} value={projectId}
              allowNone noneLabel="No project" placeholder="No project"
              onChange={(pid) => { setProjectId(pid || ''); setSectionId(''); }} />
          </div>
          {projectId && projectSections.length > 0 && (
            <div>
              <label style={label} htmlFor="nx-add-several-section">Section</label>
              <select id="nx-add-several-section" value={sectionId} onChange={(e) => setSectionId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">No section</option>
                {projectSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={label}>Assignees</label>
            <PersonMultiSelect value={assigneeIds} onChange={setAssigneeIds} people={people} placeholder="Nobody yet" />
          </div>
          <div>
            <label style={label}>Due Date</label>
            <DateField value={dueOn} onChange={(v) => setDueOn(v || '')} placeholder="No due date" />
          </div>
          <div>
            <label style={label} htmlFor="nx-add-several-priority">Priority</label>
            <select id="nx-add-several-priority" value={priority} onChange={(e) => setPriority(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
        </div>
        <div style={{ fontSize: 12, color: NX.faint }}>
          Every task gets these. Each person assigned is told once for the whole list.
        </div>
      </div>
    </Modal>
  );
}
