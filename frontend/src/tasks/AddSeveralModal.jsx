// Add Several (Neil, Oct 31 2026): the one confirmation surface for many
// tasks at once. Every multi-line paste into an add row (Home, My Day, the
// Create Task title, the phone quick-add) opens it with the lines, and the
// Create form's Add Several button opens it with the typed title as the
// first line. The person checks the lines (one per line, Tab indents a
// subtask), sets what every task shares - project, section, who, due date,
// priority, the project's required fields - and clicks Add N Tasks. The rows
// go to POST /tasks/import, the CSV / Excel engine (batchPaste.importRowsFor;
// source "paste" or "typed"): a dry run first, so a row the server would
// refuse is shown here and nothing is written, then the real run - one
// transaction, one bell and one batched email per person, never one per task.
//
// A dry-run WARNING (a person the server will leave off, a value it will
// not keep) is shown too and asks for a second click - "Add N Tasks Anyway" -
// because the first click's answer would otherwise be N tasks nobody holds.
// An ERROR blocks until the line is fixed.
import { useMemo, useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { useTasks } from './TasksContext';
import { Modal, PersonMultiSelect, usePeople, DateField } from './components';
import ProjectPicker from './ProjectPicker';
import { CustomFieldInput } from './TaskDetailDrawer';
import { requiredFieldsFor, isBlankValue } from './lib';
import { NX, FONT, btn, input as inputStyle, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { parseTaskLines, importRowsFor, countLines, countLabel, linesToText, newBatchId } from './batchPaste';

const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
const SUBMIT_KEY = isMac ? 'Cmd+Enter' : 'Ctrl+Enter';

export default function AddSeveralModal({ defaults = {}, onClose, onDone }) {
  const store = useTasks();
  const { projects = [], teams = [], sections = [], customFields = [], myEmail, importTasks } = store;
  const people = usePeople(true);
  const [initialText] = useState(() => linesToText(parseTaskLines(defaults.text || '')));
  // A single typed title arrives as text too; the box opens with it as the first line.
  const [text, setText] = useState(initialText);
  const locked = !!defaults.lockedProjectId;
  const [projectId, setProjectId] = useState(defaults.lockedProjectId || defaults.projectId || '');
  const [sectionId, setSectionId] = useState(defaults.sectionId || '');
  // Every task needs someone to hold it (the Create form's rule); the entry
  // point's pick, else me. The due date stays optional here - Home's own add
  // row allows none - Neil may tighten this to the Create form's rule later.
  const [assigneeIds, setAssigneeIds] = useState(() => (defaults.assigneeIds?.length ? defaults.assigneeIds : (myEmail ? [myEmail] : [])));
  const [dueOn, setDueOn] = useState(defaults.dueOn || '');
  const [priority, setPriority] = useState(defaults.priority || 'medium');
  const [cfValues, setCfValues] = useState(defaults.customFieldValues || {});
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);   // [{ row, title, errors }] from the dry run
  const [warnings, setWarnings] = useState([]);   // [{ row, title, text }] from the dry run - a second click adds anyway
  const [err, setErr] = useState('');
  // ONE id for the modal's life: the dry run, the real run and any retry
  // after an error share it, so a retry of a request that reached the server
  // is refused (409) instead of adding the list twice.
  const [batchId] = useState(newBatchId);
  const boxRef = useRef(null);

  const lines = useMemo(() => parseTaskLines(text), [text]);
  const { tasks: topCount } = countLines(lines);
  const projectSections = useMemo(
    () => sections.filter((s) => s.custom && s.projectId === projectId).sort((a, b) => (a.position || 0) - (b.position || 0)),
    [sections, projectId]);
  // The picked project's required custom fields, filled here before Add -
  // the dry run would refuse every top-level line without them.
  const reqFields = useMemo(() => requiredFieldsFor(customFields, projectId), [customFields, projectId]);
  const reqMissing = reqFields.filter((f) => isBlankValue(cfValues[f.id]));

  // Anything that changes what the server will answer clears the last answer.
  const clearAnswer = () => { setProblems([]); setWarnings([]); };
  const changeProject = (pid) => { setProjectId(pid || ''); setSectionId(''); setCfValues({}); clearAnswer(); };
  const changeAssignees = (ids) => { setAssigneeIds(ids); clearAnswer(); };
  const changeDue = (v) => { setDueOn(v || ''); clearAnswer(); };

  // Tab indents the current line (a subtask), Shift+Tab outdents it. Shift+Tab
  // on a line with no indent is left to the browser, so the keyboard can
  // still walk back out of the box; Ctrl/Cmd+Enter adds the list.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); return; }
    if (e.key !== 'Tab') return;
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    let next, caret;
    if (e.shiftKey) {
      const m = /^(\t| {1,2})/.exec(value.slice(lineStart));
      if (!m) return;   // nothing to outdent: Shift+Tab leaves the box
      next = value.slice(0, lineStart) + value.slice(lineStart + m[0].length);
      caret = Math.max(lineStart, s - m[0].length);
    } else {
      next = value.slice(0, lineStart) + '\t' + value.slice(lineStart);
      caret = s + 1;
    }
    e.preventDefault();
    setText(next);
    clearAnswer();
    requestAnimationFrame(() => { el.setSelectionRange(caret, caret + (en - s)); });
  };

  const request = (dry) => ({
    project_id: projectId || '', section_id: projectId ? (sectionId || '') : '',
    source: defaults.source || 'paste', import_id: batchId, dry_run: dry, notify_assignees: true,
    rows: importRowsFor(lines, {
      assigneeIds, dueOn, priority, customFieldValues: projectId ? cfValues : {},
      tags: defaults.tags, startOn: defaults.startOn, status: defaults.status,
    }),
  });

  const canAdd = topCount > 0 && assigneeIds.length > 0 && reqMissing.length === 0 && !busy;
  const confirming = warnings.length > 0 && problems.length === 0;

  const submit = async () => {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try {
      if (!confirming) {
        const dry = await importTasks(request(true));
        const errors = dry?.errors || [];
        const warns = [];
        // A person the server will leave off is one of the row's warnings
        // ("Assignee ... - left off."), so droppedPeople adds nothing here.
        (dry?.rows || []).forEach((r) => (r.warnings || []).forEach((w) => warns.push({ row: r.row, title: r.title, text: w })));
        setProblems(errors);
        setWarnings(warns);
        if (errors.length || warns.length) { setBusy(false); return; }
      }
      const r = await importTasks(request(false));
      onDone?.(r);
      onClose?.(true);
    } catch (e) {
      // The list stays in the box; the same id goes out again on a retry.
      setErr(e?.message || 'The tasks could not be added.');
      setBusy(false);
    }
  };

  const n = topCount;
  const addLabel = !n ? 'Add Tasks' : `Add ${n} Task${n === 1 ? '' : 's'}${confirming ? ' Anyway' : ''}`;
  const count = countLabel(lines) + (topCount && !dueOn ? ', no due date' : '');
  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <span role="status" style={{ fontSize: 13, color: NX.dim, flex: 1, minWidth: 0 }}>{count}</span>
      <button type="button" onClick={() => onClose?.(false)} disabled={busy} style={btn('outline')}>Cancel</button>
      <button type="button" onClick={submit} disabled={!canAdd}
        title={!assigneeIds.length ? 'Pick at least one person to hold the tasks' : reqMissing.length ? `Fill in ${reqMissing.map((f) => f.name).join(', ')}` : undefined}
        style={{ ...btn('primary'), opacity: canAdd || busy ? 1 : 0.55 }}>
        <ListPlus size={15} /> {busy ? 'Adding...' : addLabel}
      </button>
    </div>
  );

  const seen = new Set();
  const dedupedWarnings = warnings.filter((w) => { const k = `${w.row}|${w.text}`; if (seen.has(k)) return false; seen.add(k); return true; });

  return (
    <Modal title="Add Several Tasks" onClose={() => { if (!busy) onClose?.(false); }} footer={footer} isDirty={text.trim() !== initialText.trim()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minHeight: 0, fontFamily: FONT }}>
        {err && (
          <div role="alert" style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', color: NX.red, fontSize: 13 }}>{err}</div>
        )}
        <div className="nx-fill">
          <label style={label} htmlFor="nx-add-several">Tasks</label>
          <textarea id="nx-add-several" ref={boxRef} autoFocus value={text} disabled={busy}
            onChange={(e) => { setText(e.target.value); clearAnswer(); }}
            onKeyDown={onKeyDown} spellCheck
            placeholder={'Call the bank\n\tAsk for the statement\nFile the receipts'}
            style={{ ...inputStyle, fontSize: 14, lineHeight: 1.5, tabSize: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} />
          <div style={{ fontSize: 12, color: NX.faint, marginTop: 5 }}>One task per line. Tab indents a subtask. {SUBMIT_KEY} adds.</div>
        </div>
        {problems.length > 0 && (
          <div role="alert" style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', fontSize: 13, color: NX.ink }}>
            <div style={{ fontWeight: 600, color: NX.red, marginBottom: 4 }}>Nothing was added. Fix these lines and try again:</div>
            {problems.map((p) => (
              <div key={p.row} data-testid="add-several-problem">Line {p.row}{p.title ? ` "${p.title}"` : ''}: {(p.errors || []).join(' ')}</div>
            ))}
          </div>
        )}
        {dedupedWarnings.length > 0 && (
          <div role="alert" style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(217,119,6,0.10)', fontSize: 13, color: NX.ink }}>
            <div style={{ fontWeight: 600, color: NX.amber, marginBottom: 4 }}>
              {problems.length ? 'Also worth a look:' : `Nothing was added yet. Check these, then click ${addLabel}:`}
            </div>
            {dedupedWarnings.map((w, i) => (
              <div key={`${w.row}-${i}`} data-testid="add-several-warning">{w.row ? `Line ${w.row}${w.title ? ` "${w.title}"` : ''}: ` : ''}{w.text}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 12 }}>
          <div>
            <label style={label}>Project</label>
            {locked ? (
              <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', background: NX.hover, color: NX.dim }} aria-label="Project">
                {projects.find((p) => p.id === projectId)?.name || 'This project'}
              </div>
            ) : (
              <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
                <ProjectPicker projects={projects} teams={teams} myEmail={myEmail} value={projectId}
                  allowNone noneLabel="No project" placeholder="No project" onChange={changeProject} />
              </fieldset>
            )}
          </div>
          {projectId && projectSections.length > 0 && (
            <div>
              <label style={label} htmlFor="nx-add-several-section">Section</label>
              <select id="nx-add-several-section" value={sectionId} disabled={busy} onChange={(e) => { setSectionId(e.target.value); clearAnswer(); }} style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">No section</option>
                {projectSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={label}>Assignees <span style={{ color: NX.red }}>*</span></label>
            <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
              <PersonMultiSelect value={assigneeIds} onChange={changeAssignees} people={people} placeholder="Nobody yet" />
            </fieldset>
          </div>
          <div>
            <label style={label}>Due Date</label>
            <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
              <DateField value={dueOn} onChange={changeDue} placeholder="No due date" />
            </fieldset>
          </div>
          <div>
            <label style={label} htmlFor="nx-add-several-priority">Priority</label>
            <select id="nx-add-several-priority" value={priority} disabled={busy} onChange={(e) => setPriority(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          {projectId && reqFields.map((f) => (
            <div key={f.id}>
              <label style={label}>{f.name} <span style={{ color: NX.red }}>*</span></label>
              <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
                <CustomFieldInput field={f} value={cfValues[f.id]} onChange={(v) => { setCfValues((cur) => ({ ...cur, [f.id]: v })); clearAnswer(); }} />
              </fieldset>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: NX.faint }}>
          Every task gets these. Each person assigned is told once for the whole list.
          {defaults.source === 'typed' || defaults.fromForm ? ' Team, collaborators, description and files do not carry over to a list.' : ''}
        </div>
      </div>
    </Modal>
  );
}
