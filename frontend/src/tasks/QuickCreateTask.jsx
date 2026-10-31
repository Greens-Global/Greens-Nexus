// Task Module - Asana-style mobile quick-add. Tapping the floating + opens this
// lightweight name-first bottom sheet (not the dense full form). Name / Due date /
// Assignee plus a Photo · Attachment · Scan-text toolbar; "Full details" hands off
// to CreateTaskModal. Inherits the screen's context via `defaults`. Mobile only.
// Voice (Neil, Oct 30 2026): Say It fills the whole task from one spoken
// sentence (SayIt.jsx), the mic types the name, and a voice note or a video
// rides along with the photos and files.
import { useRef, useState } from 'react';
import { CalendarDays, User, X, Image as ImageIcon, Paperclip, ScanText, Camera, ImagePlus, FolderKanban, Video, AudioLines } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { usePeople, PersonMultiSelect, DateField } from './components';
import { SearchSelect } from './components';
import { BottomSheet } from './MobileTaskBar';
import { filesFromPaste, requiredFieldsFor, isBlankValue, uploadFilesToTask, notAttachedText, screenTaskFiles } from './lib';
import { dialog } from '../ui/dialog';
import { CustomFieldInput } from './TaskDetailDrawer';
import { NX, FONT, btn, input as inputStyle } from './theme';
import AnchoredMenu from '../components/AnchoredMenu';
import DictateButton from '../components/DictateButton';
import VoiceNoteButton from '../components/VoiceNoteButton';
import { STOP_VOICE_FIRST } from '../lib/voice';
import SayIt from './SayIt';
import AddSeveralModal from './AddSeveralModal';
import { pastedTaskList } from './batchPaste';

const fieldLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 };

export default function QuickCreateTask({ defaults = {}, onClose, onFullDetails }) {
  const store = useTasks();
  const { createTask, myEmail, projects = [] } = store;
  const people = usePeople(true);   // assignee - see TaskDetailDrawer
  const [title, setTitle] = useState(defaults.title || '');
  const [dueOn, setDueOn] = useState(defaults.dueOn || '');
  const [assigneeIds, setAssigneeIds] = useState(
    defaults.assigneeIds || (defaults.assigneeId ? [defaults.assigneeId] : (myEmail ? [myEmail] : [])));
  const [priority, setPriority] = useState(defaults.priority || 'medium');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]); // { file, url, image }
  const titleRef = useRef(null);
  const videoRef = useRef(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [several, setSeveral] = useState('');   // a pasted list (Oct 31 2026) - Add Several over the sheet
  const [photoMenu, setPhotoMenu] = useState(false);
  const photoBtnRef = useRef(null);

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
      else alert('No text found in the image.');
    } catch { alert("Couldn't extract text from the image."); }
    finally { setOcrBusy(false); }
  };

  // Same three required fields as the desktop Create-a-Task form (title,
  // assignee, due date - see CreateTaskModal's `missing`) - Project is
  // optional there too. Project is pre-filled and hidden when the sheet was
  // opened from inside one.
  const [projectId, setProjectId] = useState(defaults.projectId || '');
  const lockedProject = !!defaults.projectId;

  // The project's required custom fields (Oct 13 2026) - shown right here
  // and filled in before Create, since the server refuses the task without
  // them.
  const [cfValues, setCfValues] = useState(defaults.customFieldValues || {});
  const reqFields = requiredFieldsFor(store.customFields, projectId);
  const reqMissing = reqFields.filter((f) => isBlankValue(cfValues[f.id]));
  // Full Details carries the picked files too - a voice note must not vanish.
  const draft = () => ({ title: title.trim(), dueOn, assigneeIds, priority, customFieldValues: cfValues, files: files.map((it) => it.file) });
  // A voice note still recording: Create and Full Details wait for Stop, or
  // the clip is lost.
  const [voiceRec, setVoiceRec] = useState(false);
  const canCreate = !!(title.trim() && assigneeIds.length && dueOn) && reqMissing.length === 0 && !busy && !voiceRec;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const t = await createTask({
        title: title.trim(), type: 'task', status: defaults.status || 'not_started',
        priority, assigneeIds, ownerId: defaults.ownerId ?? myEmail ?? '', projectId, teamId: defaults.teamId || '', dueOn: dueOn || '',
        customFieldValues: cfValues,
      });
      const notAttached = await uploadFilesToTask(t.id, files.map((it) => it.file));
      if (notAttached.length) dialog.alert(notAttachedText(notAttached), { title: 'Some Files Did Not Attach' });
      onClose();
    } catch (e) { alert(`Could not create task: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...inputStyle, cursor: 'pointer', width: '100%' };
  const iconBtn = (extra = {}) => ({ ...btn('ghost'), padding: 8, color: NX.dim, ...extra });

  return (
    <BottomSheet title="New Task" onClose={onClose}>
      {several && (
        <AddSeveralModal defaults={{ text: title.trim() ? `${title.trim()}\n${several}` : several, dueOn, assigneeIds, priority, customFieldValues: cfValues, source: 'paste',
          projectId, lockedProjectId: lockedProject ? projectId : '', status: defaults.status || '', teamId: defaults.teamId || '' }}
          onClose={(added) => { setSeveral(''); if (added) onClose(); }} />
      )}
      <div onPaste={onPaste} tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input ref={titleRef} autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} aria-label="Task name"
            // Two or more lines pasted into the name are a list: Add Several takes them, one task per line.
            onPaste={(e) => { const list = pastedTaskList(e); if (list) { e.preventDefault(); e.stopPropagation(); setSeveral(list); } }}
            placeholder="Task name *" style={{ ...inputStyle, flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600, padding: '10px 12px' }} />
          <DictateButton target={titleRef} title="Dictate the Task Name" />
        </div>

        <SayIt people={people} myEmail={myEmail}
          snapshot={() => ({ title, dueOn, priority, assigneeIds })}
          onFill={(v) => { setTitle(v.title); setDueOn(v.dueOn); setPriority(v.priority); setAssigneeIds(v.assigneeIds); }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <span style={fieldLabel}><CalendarDays size={13} /> Due date <span style={{ color: NX.red }}>*</span></span>
            <DateField value={dueOn} onChange={(v) => setDueOn(v || '')} noPast placeholder="Pick a date" style={sel} />
          </div>
          <div>
            <span style={fieldLabel}><User size={13} /> Assignee <span style={{ color: NX.red }}>*</span></span>
            <PersonMultiSelect value={assigneeIds} onChange={setAssigneeIds} people={people} placeholder="Assign to…" addTitle="Add assignee" />
          </div>
        </div>

        {!lockedProject && (
          <div>
            <span style={fieldLabel}><FolderKanban size={13} /> Project</span>
            <SearchSelect value={projectId} placeholder="Select a project…" searchPlaceholder="Search projects…"
              buttonStyle={{ ...sel, justifyContent: 'space-between' }} emptyText="No projects yet."
              options={[{ id: '', label: 'No project' },
                        ...projects.filter((p) => !p.archived)
                          .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                          .map((p) => ({ id: p.id, label: p.name }))]}
              onPick={setProjectId} />
          </div>
        )}

        {reqFields.map((f) => (
          <div key={f.id}>
            <span style={fieldLabel}>{f.name} <span style={{ color: NX.red }}>*</span></span>
            <CustomFieldInput field={f} value={cfValues[f.id]} onChange={(v) => setCfValues((cur) => ({ ...cur, [f.id]: v }))} />
          </div>
        ))}

        {/* Attachment previews */}
        {files.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {files.map((it, i) => (
              <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 8, padding: it.image ? 0 : '6px 8px', overflow: 'hidden', height: it.image ? 56 : 'auto', width: it.image ? 56 : 'auto', maxWidth: 160 }}>
                {it.image
                  ? <img src={it.url} alt={it.file.name} style={{ width: 56, height: 56, objectFit: 'cover' }} />
                  : <>
                    {it.file.type.startsWith('audio/') ? <AudioLines size={13} style={{ color: NX.primary, flexShrink: 0 }} />
                      : it.file.type.startsWith('video/') ? <Video size={13} style={{ color: NX.dim, flexShrink: 0 }} />
                        : <Paperclip size={13} style={{ color: NX.dim, flexShrink: 0 }} />}
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 16 }}>
                      {it.file.type.startsWith('audio/') ? 'Voice Note' : it.file.name}
                    </span>
                  </>}
                <button onClick={() => removeFile(i)} aria-label="Remove" style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'rgba(17,24,39,0.72)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}><X size={11} /></button>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar: Photo · Video · Attachment · Scan text · Voice Note */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <button ref={photoBtnRef} title="Add Photo" aria-label="Add photo" onClick={() => setPhotoMenu((v) => !v)} style={iconBtn()}><ImageIcon size={20} /></button>
          <button title="Add a Video" aria-label="Add a Video" onClick={() => videoRef.current?.click()} style={iconBtn()}><Video size={20} /></button>
          <button title="Attach File" aria-label="Attach File" onClick={() => attachRef.current?.click()} style={iconBtn()}><Paperclip size={20} /></button>
          <button title="Scan Text" aria-label="Scan text" disabled={ocrBusy} onClick={() => scanRef.current?.click()} style={iconBtn({ opacity: ocrBusy ? 0.5 : 1 })}><ScanText size={20} /></button>
          <VoiceNoteButton compact onFile={(f) => pushFiles([f])} onRecordingChange={setVoiceRec} />
          {ocrBusy
            ? <span style={{ fontSize: 12, color: NX.faint }}>Scanning…</span>
            : <span style={{ fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>}
          <AnchoredMenu anchorRef={photoBtnRef} open={photoMenu} onClose={() => setPhotoMenu(false)} minWidth={180}
            style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 28px rgba(0,0,0,0.18)', padding: 4 }}>
            <button onClick={() => { setPhotoMenu(false); camRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><Camera size={16} /> Take Photo</button>
            <button onClick={() => { setPhotoMenu(false); libRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><ImagePlus size={16} /> Choose From Device</button>
          </AnchoredMenu>
          {/* Hidden inputs - capture=environment opens the camera on mobile */}
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={addFiles} />
          <input ref={libRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={addFiles} />
          <input ref={attachRef} type="file" multiple style={{ display: 'none' }} onChange={addFiles} />
          {/* The phone offers Take Video or the library. */}
          <input ref={videoRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={addFiles} />
          <input ref={scanRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onScan} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
          <button onClick={() => onFullDetails(draft())} disabled={voiceRec} style={{ ...btn('ghost'), color: NX.blue, fontWeight: 600, opacity: voiceRec ? 0.55 : 1 }}>Full Details</button>
          {voiceRec && <span role="status" style={{ fontSize: 12, color: NX.red, flex: 1, textAlign: 'center' }}>{STOP_VOICE_FIRST}</span>}
          <button onClick={submit} disabled={!canCreate} title={voiceRec ? STOP_VOICE_FIRST : undefined} style={{ ...btn('primary'), opacity: canCreate ? 1 : 0.55 }}>{busy ? 'Creating…' : 'Create Task'}</button>
        </div>
      </div>
    </BottomSheet>
  );
}
