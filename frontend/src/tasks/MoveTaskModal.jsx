// Move To... (Neil, Oct 22 2026): put a task under another task, or make a
// subtask a top-level task. Opened from the task drawer's header menu, from
// each subtask row in the drawer, and from a list row's menu. The server does
// the work (PATCH parent_task_id - the whole subtree goes with it); this
// picks the destination. Only moves the server would take are offered
// (lib.moveRule): never the task itself or anything under it, never an HR
// checklist task, and into another project only with editor on both ends.
import { useMemo, useState } from 'react';
import { CornerDownRight, ArrowUpToLine, Search, Check } from 'lucide-react';
import { useTasks } from './TasksContext';
import { useRole } from '../contexts/RoleContext';
import { Modal, SearchSelect } from './components';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { moveTargets, moveRule, effectiveProjectId, rootParent } from './lib';
import { useCustomSections } from './customSections';

// Matches rendered at once - the workspace can hold thousands of tasks.
const MAX_SHOWN = 150;
const TOP = '__top';

export default function MoveTaskModal({ taskId, onClose, onMoved }) {
  const store = useTasks();
  const { tasks, taskById, projectName, moveTask } = store;
  const task = taskById[taskId];
  const { canAccessModule } = useRole() || {};
  const isManager = typeof canAccessModule === 'function' && !!canAccessModule('tasks', 'manager', 'owner');
  const accepts = useMemo(() => moveRule(task, {
    tasks, projects: store.projects, teams: store.teams, taskById, email: store.myEmail, isManager,
  }), [task, tasks, store.projects, store.teams, taskById, store.myEmail, isManager]);
  const homeProject = task ? effectiveProjectId(task, taskById) : '';
  const sec = useCustomSections(homeProject);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);           // a task id, or TOP
  const [sectionId, setSectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const targets = useMemo(() => moveTargets(task, tasks, { canEdit: accepts, taskById }), [task, tasks, accepts, taskById]);
  const query = q.trim().toLowerCase();
  const matches = useMemo(() => (query
    ? targets.filter((t) => `${t.title || ''} ${t.code || ''}`.toLowerCase().includes(query))
    : targets), [targets, query]);

  if (!task) return null;
  const isSub = !!task.parentTaskId && accepts(null);
  // Into another project the subtasks follow and leave their sections and
  // teams behind - said before the move, not discovered after.
  const picked = pick && pick !== TOP ? taskById[pick] : null;
  const intoProject = picked ? effectiveProjectId(picked, taskById) : homeProject;
  const crossing = !!picked && intoProject !== homeProject;
  const where = (t) => {
    const top = rootParent(t, taskById);
    const proj = projectName(effectiveProjectId(t, taskById)) || 'No project';
    return top ? `${proj} - in ${top.title}` : proj;
  };

  const go = async () => {
    if (!pick || busy) return;
    setBusy(true); setError('');
    try {
      await moveTask(task.id, pick === TOP
        ? { parentTaskId: '', ...(homeProject && !sec.personal ? { sectionId } : {}) }
        : { parentTaskId: pick });
      onMoved?.(pick === TOP ? '' : pick);
      onClose();
    } catch (e) {
      // Said here only (moveTask does not alert as well); the dialog stays.
      setError(e?.message || 'That move did not save. Try again.');
      setBusy(false);
    }
  };

  const row = (key, selected, onClick, children) => (
    <button key={key} type="button" role="option" aria-selected={selected} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px',
        border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: FONT, fontSize: 13, color: NX.ink,
        background: selected ? 'rgba(37,99,235,0.10)' : 'transparent',
      }} className="nx-menu-row">
      {children}
      {selected && <Check size={14} style={{ color: NX.blue, marginLeft: 'auto', flexShrink: 0 }} />}
    </button>
  );

  const footer = (
    <>
      <button type="button" onClick={onClose} style={{ ...btn('ghost'), fontSize: 13 }}>Cancel</button>
      <button type="button" onClick={go} disabled={!pick || busy}
        style={{ ...btn('primary'), fontSize: 13, opacity: pick && !busy ? 1 : 0.45 }}>{busy ? 'Moving…' : 'Move'}</button>
    </>
  );

  return (
    <Modal title={`Move "${task.title}"`} onClose={onClose} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, fontFamily: FONT }}>
        <div style={{ fontSize: 12.5, color: NX.dim }}>
          Pick the task it should sit under. Its own subtasks move with it.
        </div>
        {isSub && (
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, padding: 4 }}>
            {row(TOP, pick === TOP, () => setPick(TOP), (
              <>
                <ArrowUpToLine size={15} style={{ color: NX.faint, flexShrink: 0 }} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>Make Top-Level Task</span>
                  <span style={{ fontSize: 11.5, color: NX.faint }}>Stays in {projectName(homeProject) || 'no project'}</span>
                </span>
              </>
            ))}
            {pick === TOP && homeProject && !sec.personal && sec.sections.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 8px 35px', fontSize: 12.5, color: NX.dim }}>
                <span>Section</span>
                <SearchSelect value={sectionId} onPick={setSectionId} placeholder="No Section"
                  options={[{ id: '', label: 'No Section' }, ...sec.sections.map((s) => ({ id: s.id, label: s.name }))]}
                  buttonStyle={{ fontSize: 12.5, minWidth: 180 }} />
              </div>
            )}
          </div>
        )}
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" aria-label="Search tasks"
            style={{ ...inputStyle, paddingLeft: 30 }} />
        </div>
        <div role="listbox" aria-label="Tasks to move under" data-testid="move-targets" className="nx-fill nx-scroll"
          style={{ overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10, padding: 4, minHeight: 160 }}>
          {matches.length === 0 && (
            <div style={{ padding: 16, fontSize: 12.5, color: NX.faint, textAlign: 'center' }}>
              {query ? 'No task you can edit matches that.' : 'There is no other task you can edit.'}
            </div>
          )}
          {matches.slice(0, MAX_SHOWN).map((t) => row(t.id, pick === t.id, () => setPick(t.id), (
            <>
              <CornerDownRight size={14} style={{ color: NX.faint, flexShrink: 0 }} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.title}{t.code ? <span style={{ fontWeight: 400, color: NX.faint }}> {t.code}</span> : null}
                </span>
                <span style={{ fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{where(t)}</span>
              </span>
            </>
          )))}
          {matches.length > MAX_SHOWN && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: NX.faint }}>
              {matches.length - MAX_SHOWN} more - search to narrow down
            </div>
          )}
        </div>
        {crossing && (
          <div data-testid="move-crossing" style={{ fontSize: 12.5, color: NX.dim }}>
            This moves it and its subtasks into {projectName(intoProject) || 'no project'}. Their sections and teams there are cleared.
          </div>
        )}
        {error && <div role="alert" style={{ fontSize: 12.5, color: NX.red }}>{error}</div>}
      </div>
    </Modal>
  );
}
