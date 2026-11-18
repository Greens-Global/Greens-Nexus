// New Task on a phone (Neil, 11/15/2026 - plan
// https://claude.ai/artifact/EzwJbKJsvrGRWwtH1Ui4Ji, Option B; replaces the
// Asana-style form sheet of Sept 2026). A quick composer that sits on the
// keyboard: the name (it wraps), "Add a note", then ONE row of chips - Due,
// Assignee, Project, Priority - and the action bar pinned under it: Add (photo,
// video, file, scan text), Voice Note, Say It, Details, Create.
//
//   - A chip is the field. Filled = green, still needed = dashed (red only
//     after Create was pressed), and a tap opens its phone picker IN the sheet
//     (composerPickers.jsx; the back arrow returns here) - never a dropdown
//     over the form.
//   - What the typed name says (useTypedTask - "tomorrow", "urgent", "for
//     Bob") fills the same chips, so a date shows once; the chip's x puts the
//     words back in the name (the typed-sentence rules of 11/13/2026). Only a
//     chip on screen is applied - nothing is set silently.
//   - Create needs a name; a missing date or person opens that picker instead
//     of a red form. Same three required fields as the full form (title,
//     assignee, due date) plus the project's required custom fields, shown
//     under the chips.
//   - Details hands the draft to the full form (CreateTaskModal); a pasted
//     list goes to Add Several (the import engine), as before.
//   - After Create, `onCreated(task, carry)` - TaskCreate.jsx shows "Task
//     Added" with Open and Add Another; `carry` is what Add Another keeps.
// Mobile only: TaskCreate.jsx picks this or the full form.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, User, X, Paperclip, ScanText, Camera, ImagePlus, FolderKanban, Video, AudioLines, Flag, Lock, FileText } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { usePeople } from './components';
import { BottomSheet } from './MobileTaskBar';
import { filesFromPaste, requiredFieldsFor, isBlankValue, uploadFilesToTask, notAttachedText, screenTaskFiles } from './lib';
import { dialog } from '../ui/dialog';
import { CustomFieldInput } from './TaskDetailDrawer';
import { NX, FONT, btn, PRIORITY_META } from './theme';
import AnchoredMenu from '../components/AnchoredMenu';
import VoiceNoteButton from '../components/VoiceNoteButton';
import { STOP_VOICE_FIRST } from '../lib/voice';
import SayIt from './SayIt';
import AddSeveralModal from './AddSeveralModal';
import { pastedTaskList } from './batchPaste';
import { useTypedTask, chipSpoken, understoodText } from './useTypedTask';
import { DuePicker, PeoplePicker, ProjectPicker, PriorityPicker } from './composerPickers';
import { dueLabel, noteFromHtml } from './composerLib';
import { seedHtml } from '../support/ticketSeed';

const PICKER_TITLE = { due: 'Due Date', people: 'Assignee', project: 'Project', priority: 'Priority' };

// Grows with what is typed, up to `max` lines, then scrolls. `again`: the box
// came back on screen (back from a picker) and must be measured afresh.
function useAutoGrow(ref, value, max = 4, again = null) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, line * max + 4)}px`;
  }, [ref, value, max, again]);
}

function Chip({ icon: Icon, label, state = 'set', onClick, onRemove, removeLabel, ariaLabel, locked = false, color }) {
  // state: 'set' (filled), 'need' (required, empty), 'bad' (required, empty, after Create), 'plain' (optional / default)
  const look = {
    // The brand color, mixed down for the fill and up for the words, so it follows the company's brand and dark mode.
    set: { background: 'color-mix(in srgb, var(--nx-primary) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--nx-primary) 38%, transparent)', color: 'color-mix(in srgb, var(--nx-primary) 72%, var(--nx-ink, #111827))' },
    need: { background: 'transparent', border: `1.5px dashed ${NX.border}`, color: NX.dim },
    bad: { background: 'rgba(220,38,38,0.06)', border: `1.5px dashed ${NX.red}`, color: NX.red },
    plain: { background: NX.surface, border: `1px solid ${NX.border}`, color: NX.ink },
  }[state];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'stretch', borderRadius: 999, minHeight: 38, maxWidth: '100%', ...look }}>
      <button type="button" onClick={locked ? undefined : onClick} aria-label={ariaLabel} disabled={locked}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, padding: onRemove ? '0 4px 0 12px' : '0 12px',
          border: 'none', background: 'transparent', color: 'inherit', fontFamily: FONT, fontSize: 14, fontWeight: 500,
          cursor: locked ? 'default' : 'pointer', borderRadius: 999,
        }}>
        <Icon size={15} aria-hidden="true" style={{ flexShrink: 0, color: color || 'currentColor' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {locked && <Lock size={12} aria-hidden="true" style={{ opacity: 0.6, flexShrink: 0 }} />}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} title="Put These Words Back in the Name"
          style={{ border: 'none', background: 'transparent', color: 'inherit', padding: '0 10px 0 4px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export default function QuickCreateTask({ defaults = {}, onClose, onFullDetails, onCreated, lockedProjectId = '' }) {
  const store = useTasks();
  const { createTask, myEmail, projects = [] } = store;
  const people = usePeople(true);   // assignee - see TaskDetailDrawer
  const [title, setTitle] = useState(defaults.title || '');
  // A seeded description (Share to Nexus, a form entry) is HTML: the note box
  // shows its words, and the HTML is kept as it was unless the words change.
  const [seedNote] = useState(() => noteFromHtml(defaults.description));
  const [note, setNote] = useState(seedNote);
  const [dueOn, setDueOn] = useState(defaults.dueOn || '');
  const [assigneeIds, setAssigneeIds] = useState(
    defaults.assigneeIds || (defaults.assigneeId ? [defaults.assigneeId] : (myEmail ? [myEmail] : [])));
  const [priority, setPriority] = useState(defaults.priority || 'medium');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState(() => (defaults.files || []).map((f) => ({ file: f, image: f.type?.startsWith('image/'), url: f.type?.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : null })));
  const [view, setView] = useState('compose');   // compose | due | people | project | priority
  const [tried, setTried] = useState(false);      // Create was pressed: an empty required chip turns red
  const titleRef = useRef(null);
  const noteRef = useRef(null);
  const videoRef = useRef(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [several, setSeveral] = useState('');   // a pasted list (Oct 31 2026) - Add Several over the sheet
  const [addMenu, setAddMenu] = useState(false);
  const addBtnRef = useRef(null);
  useAutoGrow(titleRef, title, 4, view);
  useAutoGrow(noteRef, note, 5, view);

  // The name reads the sentence Say It reads (11/13/2026, useTypedTask.js).
  // A field the person picked in its own picker is theirs: the sentence is
  // not read for it.
  // What the screen filled in (or Add Another kept) is a starting point: a
  // date or person in the typed name still wins, as on the old sheet.
  const [dueSet, setDueSet] = useState(false);
  const [assigneeSet, setAssigneeSet] = useState(false);
  const [prioritySet, setPrioritySet] = useState(false);
  const typedTask = useTypedTask(title, { people, myEmail, locked: { date: dueSet, assignee: assigneeSet, priority: prioritySet } });
  const taskName = typedTask.title;
  const taskDue = typedTask.dueOn || dueOn;
  const taskWho = typedTask.assigneeIds.length ? typedTask.assigneeIds : assigneeIds;
  const taskPriority = typedTask.priority || priority;
  const typedChip = (kind) => typedTask.chips.find((c) => c.kind === kind) || null;

  const camRef = useRef(null);
  const libRef = useRef(null);
  const attachRef = useRef(null);
  const scanRef = useRef(null);

  const pushFiles = (picked) => {
    // A voice note or video gets its real type and its size checked here.
    const { files: list, refused } = screenTaskFiles(picked);
    if (refused.length) dialog.alert(refused.join('\n'), { title: 'Not Added' });
    if (!list.length) return;
    setFiles((prev) => [...prev, ...list.map((f) => ({ file: f, image: f.type.startsWith('image/'), url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }))]);
  };
  const addFiles = (e) => { const list = Array.from(e.target.files || []); e.target.value = ''; pushFiles(list); };
  const onPaste = (e) => { const list = filesFromPaste(e); if (list.length) { e.preventDefault(); pushFiles(list); } };
  const removeFile = (i) => setFiles((prev) => { const it = prev[i]; if (it?.url) URL.revokeObjectURL(it.url); return prev.filter((_, n) => n !== i); });

  // ABC scanner → capture a photo, OCR it on the server, append the text to the name.
  const onScan = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setOcrBusy(true);
    try {
      const { text } = await api.ocrImage(f);
      if (text && text.trim()) setTitle((t) => (t ? `${t} ` : '') + text.trim().replace(/\s+/g, ' '));
      else dialog.alert('No text found in the picture.', { title: 'Scan Text' });
    } catch { dialog.alert("Couldn't read text from the picture.", { title: 'Scan Text' }); }
    finally { setOcrBusy(false); }
  };

  // Project: fixed when the composer was opened from inside one - the
  // screen's own project (`defaults.projectId`, as the sheet always read it,
  // or `lockedProjectId`) - and its chip shows it, locked. Add Another passes
  // the last task's project as `suggestedProjectId`: filled in, still changeable.
  const lockedProject = lockedProjectId || defaults.projectId || '';
  const [projectId, setProjectId] = useState(lockedProject || defaults.suggestedProjectId || '');
  const project = projects.find((p) => p.id === projectId) || null;

  // The project's required custom fields (Oct 13 2026) - shown right here
  // and filled in before Create, since the server refuses the task without
  // them.
  const [cfValues, setCfValues] = useState(defaults.customFieldValues || {});
  const reqFields = requiredFieldsFor(store.customFields, projectId);
  const reqMissing = reqFields.filter((f) => isBlankValue(cfValues[f.id]));
  const description = () => (note.trim() === seedNote.trim() ? (defaults.description || '') : seedHtml(note));
  // Details (the full form) carries everything here, the picked files too - a voice note must not vanish.
  const draft = () => ({
    title: taskName, description: description(), dueOn: taskDue, assigneeIds: taskWho, priority: taskPriority, projectId,
    customFieldValues: cfValues, files: files.map((it) => it.file),
  });
  // A voice note still recording: Create and Details wait for Stop, or the clip is lost.
  const [voiceRec, setVoiceRec] = useState(false);
  const dirty = !!(title.trim() || note.trim() !== seedNote.trim() || files.length > (defaults.files?.length || 0));
  const canPress = !!taskName && !busy && !voiceRec;

  // Create: a missing date or person opens its picker - the next thing to do,
  // not a red form. Required custom fields are under the chips and turn red.
  const submit = async () => {
    if (!canPress) return;
    if (!taskDue) { setTried(true); setView('due'); return; }
    if (!taskWho.length) { setTried(true); setView('people'); return; }
    if (reqMissing.length) { setTried(true); return; }
    setBusy(true);
    try {
      const t = await createTask({
        title: taskName, description: description(), type: 'task', status: defaults.status || 'not_started',
        priority: taskPriority, assigneeIds: taskWho, ownerId: defaults.ownerId ?? myEmail ?? '', projectId, teamId: defaults.teamId || '', dueOn: taskDue || '',
        customFieldValues: cfValues,
      });
      const notAttached = await uploadFilesToTask(t.id, files.map((it) => it.file));
      if (notAttached.length) dialog.alert(notAttachedText(notAttached), { title: 'Some Files Did Not Attach' });
      onCreated?.(t, { dueOn: taskDue, assigneeIds: taskWho, projectId, priority: taskPriority, teamId: defaults.teamId || '', status: defaults.status || '' });
      onClose();
    } catch (e) { dialog.alert(`Could not create the task: ${e.message || e}`, { title: 'Not Created' }); setBusy(false); }
  };

  // Back from a picker puts the cursor back in the name, as the keyboard left it.
  useEffect(() => { if (view === 'compose') titleRef.current?.focus({ preventScroll: true }); }, [view]);

  const nameOf = (email) => (email === myEmail ? 'You' : people.find((p) => p.email === email)?.name || email);
  const whoLabel = taskWho.length === 0 ? 'Assignee' : taskWho.length === 1 ? nameOf(taskWho[0]) : `${nameOf(taskWho[0])} +${taskWho.length - 1}`;
  const ctx = { people, myEmail };
  const dueChip = typedChip('date');
  const whoChip = typedChip('assignee');
  const prChip = typedChip('priority');
  const status = understoodText(typedTask.chips, ctx);
  const iconBtn = { ...btn('ghost'), width: 44, height: 44, padding: 0, justifyContent: 'center', color: NX.dim, flexShrink: 0 };
  const menuRow = { ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 10, minHeight: 44, fontSize: 15 };

  if (view !== 'compose') {
    const back = () => setView('compose');
    return (
      <BottomSheet title={PICKER_TITLE[view]} onClose={onClose} onBack={back} dirty={dirty}
        footer={view === 'people' ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={back} style={{ ...btn('primary'), minHeight: 44, padding: '0 22px' }}>
              Done{taskWho.length ? ` (${taskWho.length})` : ''}
            </button>
          </div>
        ) : null}>
        {view === 'due' && (
          <DuePicker value={taskDue} onPick={(iso) => { if (dueChip) typedTask.remove('date'); setDueOn(iso); setDueSet(true); back(); }} />
        )}
        {view === 'people' && (
          <PeoplePicker people={people} myEmail={myEmail} value={taskWho}
            onChange={(v) => { if (whoChip) typedTask.remove('assignee'); setAssigneeIds(v); setAssigneeSet(true); }} />
        )}
        {view === 'project' && <ProjectPicker projects={projects} value={projectId} onPick={(id) => { setProjectId(id); back(); }} />}
        {view === 'priority' && (
          <PriorityPicker value={taskPriority} onPick={(k) => { if (prChip) typedTask.remove('priority'); setPriority(k); setPrioritySet(true); back(); }} />
        )}
      </BottomSheet>
    );
  }

  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontFamily: FONT }}>
      <button ref={addBtnRef} type="button" aria-label="Add a Photo, Video or File" title="Add a Photo, Video or File" aria-haspopup="menu" aria-expanded={addMenu}
        onClick={() => setAddMenu((v) => !v)} style={iconBtn}><Paperclip size={21} /></button>
      <VoiceNoteButton compact onFile={(f) => pushFiles([f])} onRecordingChange={setVoiceRec}
        style={{ width: 44, height: 44, border: 'none', background: 'transparent', color: NX.dim, justifyContent: 'center' }} />
      <SayIt compact people={people} myEmail={myEmail}
        snapshot={() => ({ title: taskName, dueOn: taskDue, priority: taskPriority, assigneeIds: taskWho })}
        onFill={(v) => {
          typedTask.standDown();
          setTitle(v.title); setDueOn(v.dueOn); setPriority(v.priority); setAssigneeIds(v.assigneeIds);
          if (v.dueOn) setDueSet(true);
          if (v.assigneeIds?.length) setAssigneeSet(true);
          if (v.priority && v.priority !== 'medium') setPrioritySet(true);
        }} />
      <span style={{ flex: 1 }} />
      <button type="button" aria-label="Full Details" title="Open the full form: start date, repeat, labels, subtasks and more"
        onClick={() => onFullDetails(draft(), dirty)} disabled={voiceRec}
        style={{ ...btn('ghost'), minHeight: 44, padding: '0 10px', color: NX.primary, fontWeight: 600, opacity: voiceRec ? 0.5 : 1 }}>Details</button>
      <button type="button" aria-label="Create Task" onClick={submit} disabled={!canPress} title={voiceRec ? STOP_VOICE_FIRST : undefined}
        style={{ ...btn('primary'), minHeight: 44, padding: '0 18px', opacity: canPress ? 1 : 0.5 }}>{busy ? 'Creating...' : 'Create'}</button>
      {voiceRec && <span role="status" style={{ flexBasis: '100%', fontSize: 12, color: NX.red, textAlign: 'right' }}>{STOP_VOICE_FIRST}</span>}
      <AnchoredMenu anchorRef={addBtnRef} open={addMenu} onClose={() => setAddMenu(false)} minWidth={210}
        style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, boxShadow: '0 10px 28px rgba(0,0,0,0.18)', padding: 4 }}>
        <button type="button" role="menuitem" onClick={() => { setAddMenu(false); camRef.current?.click(); }} style={menuRow}><Camera size={18} /> Take a Photo</button>
        <button type="button" role="menuitem" onClick={() => { setAddMenu(false); libRef.current?.click(); }} style={menuRow}><ImagePlus size={18} /> Choose Photos</button>
        <button type="button" role="menuitem" onClick={() => { setAddMenu(false); videoRef.current?.click(); }} style={menuRow}><Video size={18} /> Add a Video</button>
        <button type="button" role="menuitem" onClick={() => { setAddMenu(false); attachRef.current?.click(); }} style={menuRow}><Paperclip size={18} /> Attach a File</button>
        <button type="button" role="menuitem" disabled={ocrBusy} onClick={() => { setAddMenu(false); scanRef.current?.click(); }} style={menuRow}><ScanText size={18} /> Scan Text Into the Name</button>
      </AnchoredMenu>
      {/* Hidden inputs - capture=environment opens the camera on a phone. */}
      <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={addFiles} />
      <input ref={libRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={addFiles} />
      <input ref={attachRef} type="file" multiple style={{ display: 'none' }} onChange={addFiles} />
      <input ref={videoRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={addFiles} />
      <input ref={scanRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onScan} />
    </div>
  );

  // Bare lines of text: .nx-inline-edit gives them the house's quiet focus tint (style.css).
  const textBox = { width: '100%', border: 'none', resize: 'none', padding: '2px 4px', margin: '0 -4px', fontFamily: FONT, color: NX.ink, display: 'block' };

  return (
    <BottomSheet title="New Task" onClose={onClose} dirty={dirty} footer={footer} bodyStyle={{ padding: '14px 18px 16px' }}
      layered={addMenu ? () => { setAddMenu(false); addBtnRef.current?.focus(); } : null}>
      {several && (
        <AddSeveralModal defaults={{ text: title.trim() ? `${title.trim()}\n${several}` : several, dueOn: taskDue, assigneeIds: taskWho, priority: taskPriority, customFieldValues: cfValues, source: 'paste',
          projectId, lockedProjectId: lockedProject ? projectId : '', status: defaults.status || '', teamId: defaults.teamId || '' }}
          onClose={(added) => { setSeveral(''); if (added) onClose(); }} />
      )}
      <div onPaste={onPaste} style={{ display: 'flex', flexDirection: 'column', gap: 12, fontFamily: FONT }}>
        <textarea ref={titleRef} className="nx-inline-edit" autoFocus rows={1} value={title} onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, ' '))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} aria-label="Task name" enterKeyHint="done"
          // Two or more lines pasted into the name are a list: Add Several takes them, one task per line.
          onPaste={(e) => { const list = pastedTaskList(e); if (list) { e.preventDefault(); e.stopPropagation(); setSeveral(list); } }}
          placeholder="Task name" style={{ ...textBox, fontSize: 18, fontWeight: 600, lineHeight: 1.3 }} />
        <textarea ref={noteRef} className="nx-inline-edit" rows={1} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note"
          placeholder="Add a note" style={{ ...textBox, fontSize: 16, lineHeight: 1.45, color: note ? NX.ink : NX.dim }} /> {/* type-ok: below 16px iOS zooms into the box */}

        <div role="group" aria-label="Task Details" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
          <Chip icon={CalendarDays} label={taskDue ? dueLabel(taskDue) : 'Due Date'}
            state={taskDue ? 'set' : tried ? 'bad' : 'need'}
            ariaLabel={taskDue ? `Due Date: ${dueLabel(taskDue)}. Change` : 'Due Date, needed. Pick a date'}
            onClick={() => setView('due')}
            onRemove={dueChip ? () => typedTask.remove('date') : null} removeLabel={dueChip ? `Remove ${chipSpoken(dueChip, ctx)}` : ''} />
          <Chip icon={User} label={whoLabel}
            state={taskWho.length ? 'set' : tried ? 'bad' : 'need'}
            ariaLabel={taskWho.length ? `Assignee: ${taskWho.map(nameOf).join(', ')}. Change` : 'Assignee, needed. Pick someone'}
            onClick={() => setView('people')}
            onRemove={whoChip ? () => typedTask.remove('assignee') : null} removeLabel={whoChip ? `Remove ${chipSpoken(whoChip, ctx)}` : ''} />
          <Chip icon={FolderKanban} label={project ? project.name : 'No Project'} state="plain" locked={!!lockedProject}
            ariaLabel={lockedProject ? `Project: ${project?.name || 'this project'}` : `Project: ${project ? project.name : 'none'}. Change`}
            onClick={() => setView('project')} />
          <Chip icon={Flag} color={PRIORITY_META[taskPriority]?.color} label={PRIORITY_META[taskPriority]?.label || 'Medium'}
            state={taskPriority === 'medium' ? 'plain' : 'set'}
            ariaLabel={`Priority: ${PRIORITY_META[taskPriority]?.label || 'Medium'}. Change`}
            onClick={() => setView('priority')}
            onRemove={prChip ? () => typedTask.remove('priority') : null} removeLabel={prChip ? `Remove ${chipSpoken(prChip, ctx)}` : ''} />
        </div>
        {/* What the name was read as, for a screen reader; the chips show it. */}
        <span role="status" aria-live="polite" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{status}</span>
        {typedTask.chips.length > 0 && (
          <div style={{ fontSize: 12, color: NX.faint, marginTop: -4 }}>Read from the name. Tap x to keep those words in it.</div>
        )}

        {reqFields.map((f) => {
          const bad = tried && isBlankValue(cfValues[f.id]);
          return (
            <div key={f.id}>
              <div style={{ fontSize: 13, fontWeight: 600, color: bad ? NX.red : NX.dim, marginBottom: 5 }}>{f.name} <span style={{ color: NX.red }}>*</span></div>
              <CustomFieldInput field={f} value={cfValues[f.id]} onChange={(v) => setCfValues((cur) => ({ ...cur, [f.id]: v }))} />
            </div>
          );
        })}

        {/* What will go up with the task. */}
        {(files.length > 0 || ocrBusy) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {files.map((it, i) => (
              <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 10, padding: it.image ? 0 : '8px 10px', overflow: 'hidden', height: it.image ? 60 : 'auto', width: it.image ? 60 : 'auto', maxWidth: 180 }}>
                {it.image && it.url
                  ? <img src={it.url} alt={it.file.name} style={{ width: 60, height: 60, objectFit: 'cover' }} />
                  : <>
                    {it.file.type?.startsWith('audio/') ? <AudioLines size={14} style={{ color: NX.primary, flexShrink: 0 }} />
                      : it.file.type?.startsWith('video/') ? <Video size={14} style={{ color: NX.dim, flexShrink: 0 }} />
                        : <FileText size={14} style={{ color: NX.dim, flexShrink: 0 }} />}
                    <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 18 }}>
                      {it.file.type?.startsWith('audio/') ? 'Voice Note' : it.file.name}
                    </span>
                  </>}
                <button type="button" onClick={() => removeFile(i)} aria-label={`Remove ${it.file.type?.startsWith('audio/') ? 'Voice Note' : it.file.name}`}
                  style={{ position: 'absolute', top: 3, right: 3, width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'rgba(17,24,39,0.72)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}><X size={12} /></button>
              </div>
            ))}
            {ocrBusy && <span style={{ fontSize: 13, color: NX.faint, alignSelf: 'center' }}>Reading the picture...</span>}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
