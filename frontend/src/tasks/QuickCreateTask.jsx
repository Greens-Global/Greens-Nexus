// Task Module - Asana-style mobile quick-add. Tapping the floating + opens this
// lightweight name-first bottom sheet (not the dense full form). Name / Due date /
// Assignee plus a Photo · Attachment · Scan-text toolbar; "Full details" hands off
// to CreateTaskModal. Inherits the screen's context via `defaults`. Mobile only.
import { useRef, useState } from 'react';
import { CalendarDays, User, X, Image as ImageIcon, Paperclip, ScanText, Camera, ImagePlus, FolderKanban } from 'lucide-react';
import { api } from '../api';
import { useTasks } from './TasksContext';
import { usePeople, PersonMultiSelect, DateField } from './components';
import { SearchSelect } from './components';
import { BottomSheet } from './MobileTaskBar';
import { filesFromPaste, uploadTaskAttachment } from './lib';
import { NX, FONT, btn, input as inputStyle } from './theme';

const fieldLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 };

// Upload one file as a task attachment (real storage upload - shared path).
const uploadAttachment = (taskId, f) => uploadTaskAttachment(taskId, f).catch(() => {});

export default function QuickCreateTask({ defaults = {}, onClose, onFullDetails }) {
  const store = useTasks();
  const { createTask, myEmail, projects = [] } = store;
  const people = usePeople();
  const [title, setTitle] = useState(defaults.title || '');
  const [dueOn, setDueOn] = useState(defaults.dueOn || '');
  const [assigneeIds, setAssigneeIds] = useState(
    defaults.assigneeIds || (defaults.assigneeId ? [defaults.assigneeId] : (myEmail ? [myEmail] : [])));
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]); // { file, url, image }
  const [ocrBusy, setOcrBusy] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);

  const camRef = useRef(null);
  const libRef = useRef(null);
  const attachRef = useRef(null);
  const scanRef = useRef(null);

  const pushFiles = (list) => {
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

  const draft = () => ({ title: title.trim(), dueOn, assigneeIds });
  const canCreate = !!(title.trim() && assigneeIds.length && dueOn) && !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const t = await createTask({
        title: title.trim(), type: 'task', status: defaults.status || 'not_started',
        priority: defaults.priority || 'medium', assigneeIds, ownerId: defaults.ownerId ?? myEmail ?? '', projectId, teamId: defaults.teamId || '', dueOn: dueOn || '',
      });
      for (const it of files) await uploadAttachment(t.id, it.file);
      onClose();
    } catch (e) { alert(`Could not create task: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...inputStyle, cursor: 'pointer', width: '100%' };
  const iconBtn = (extra = {}) => ({ ...btn('ghost'), padding: 8, color: NX.dim, ...extra });

  return (
    <BottomSheet title="New Task" onClose={onClose}>
      <div onPaste={onPaste} tabIndex={0} style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT, outline: 'none' }}>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Task name *" style={{ ...inputStyle, fontSize: 17, fontWeight: 600, padding: '10px 12px' }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <span style={fieldLabel}><CalendarDays size={13} /> Due date <span style={{ color: NX.red }}>*</span></span>
            <DateField value={dueOn} onChange={(v) => setDueOn(v || '')} placeholder="Pick a date" style={sel} />
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

        {/* Attachment previews */}
        {files.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {files.map((it, i) => (
              <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, borderRadius: 8, padding: it.image ? 0 : '6px 8px', overflow: 'hidden', height: it.image ? 56 : 'auto', width: it.image ? 56 : 'auto', maxWidth: 160 }}>
                {it.image
                  ? <img src={it.url} alt={it.file.name} style={{ width: 56, height: 56, objectFit: 'cover' }} />
                  : <><Paperclip size={13} style={{ color: NX.dim, flexShrink: 0 }} /><span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.file.name}</span></>}
                <button onClick={() => removeFile(i)} aria-label="Remove" style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'rgba(17,24,39,0.72)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}><X size={11} /></button>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar: Photo · Attachment · Scan text */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative' }}>
          <button title="Add photo" aria-label="Add photo" onClick={() => setPhotoMenu((v) => !v)} style={iconBtn()}><ImageIcon size={20} /></button>
          <button title="Attach file" aria-label="Attach file" onClick={() => attachRef.current?.click()} style={iconBtn()}><Paperclip size={20} /></button>
          <button title="Scan text" aria-label="Scan text" disabled={ocrBusy} onClick={() => scanRef.current?.click()} style={iconBtn({ opacity: ocrBusy ? 0.5 : 1 })}><ScanText size={20} /></button>
          {ocrBusy
            ? <span style={{ fontSize: 12, color: NX.faint }}>Scanning…</span>
            : <span style={{ fontSize: 11, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>}
          {photoMenu && (
            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 28px rgba(0,0,0,0.18)', zIndex: 10, padding: 4, minWidth: 180 }}>
              <button onClick={() => { setPhotoMenu(false); camRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><Camera size={16} /> Take photo</button>
              <button onClick={() => { setPhotoMenu(false); libRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><ImagePlus size={16} /> Choose from device</button>
            </div>
          )}
          {/* Hidden inputs - capture=environment opens the camera on mobile */}
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={addFiles} />
          <input ref={libRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={addFiles} />
          <input ref={attachRef} type="file" multiple style={{ display: 'none' }} onChange={addFiles} />
          <input ref={scanRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onScan} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
          <button onClick={() => onFullDetails(draft())} style={{ ...btn('ghost'), color: NX.blue, fontWeight: 600 }}>Full Details</button>
          <button onClick={submit} disabled={!canCreate} style={{ ...btn('primary'), opacity: canCreate ? 1 : 0.55 }}>{busy ? 'Creating…' : 'Create Task'}</button>
        </div>
      </div>
    </BottomSheet>
  );
}
