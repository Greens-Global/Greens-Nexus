// Task Module - the floating "+" create button, bottom-right on every screen.
//
// Was a "+ Create" dropdown in a bar of its own above the page header (with a
// mobile-only FAB variant). That bar held two controls and cost a whole row on
// every page, so the row was merged into each page's header and the create
// action became this one floating button (Sagar, Sept 1 2026).
//
// The button IS the state: "+" rotates 45 degrees into "x" while the options
// are open, so one control both opens and closes the menu and its current
// meaning is legible without a label.
import { useEffect, useRef, useState } from 'react';
import { Plus, ListChecks, FolderKanban, Briefcase, LayoutTemplate } from 'lucide-react';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { Modal, useIsMobile, SearchSelect } from './components';
import CreateTaskModal from './CreateTaskModal';
import { ProjectCreateModal } from './ProjectsView';
import { PortfolioCreateModal } from './PortfoliosView';

const ITEMS = [
  { key: 'task', label: 'Task', icon: ListChecks },
  { key: 'project', label: 'Project', icon: FolderKanban },
  // Not a modal: picking a template is a browse, and the Templates screen is
  // already built for it. This just takes you there.
  { key: 'from-template', label: 'From Template', icon: LayoutTemplate, nav: 'templates' },
  { key: 'portfolio', label: 'Portfolio', icon: Briefcase },
];

// `bottom` is supplied by the module shell, which stacks this above the
// "Report a Bug" pill from a single base offset - see Tasks.jsx's fabBottom.
const FAB_RIGHT = 16;
const FAB_SIZE = 56;

export default function CreateMenu({ onNavigate, taskDefaults = {}, bottom = 60 }) {
  const { createTeam, projects } = useTasks();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(null); // 'task' | 'project' | 'portfolio' | 'department' | null
  const ref = useRef(null);

  // Escape closes, like every other dismissible layer in the module. The scrim
  // below handles pointer dismissal, so there is no outside-click listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
  const field = { marginBottom: 14 };

  const [deptName, setDeptName] = useState('');
  const [deptProjectId, setDeptProjectId] = useState('');
  const [deptBusy, setDeptBusy] = useState(false);
  const deptCanSubmit = deptName.trim() && !deptBusy;
  // See ProjectsView.jsx's ProjectModal for why: autoFocus on the first field
  // of a vh-sized Modal + mobile Chrome's keyboard-open scroll behavior can
  // scroll fields below it out of view.
  const isMobile = useIsMobile();
  const submitDept = async () => {
    if (!deptCanSubmit) return;
    setDeptBusy(true);
    try {
      await createTeam({ name: deptName.trim(), project_id: deptProjectId, color: NX.blue, memberIds: [] });
      setDeptName(''); setDeptProjectId(''); setShow(null);
      onNavigate && onNavigate('teams');
    } catch (e) { alert(`Could not create team: ${e.message || e}`); } finally { setDeptBusy(false); }
  };

  return (
    <div ref={ref}>
      {/* Catches the click that closes the menu, and separates the options from
          the page behind them. Transparent enough that the page is still read
          as present rather than replaced - this is a menu, not a modal. */}
      {open && (
        <div onClick={() => setOpen(false)} aria-hidden="true" style={{
          position: 'fixed', inset: 0, zIndex: 2490, background: 'rgba(23,26,38,0.10)',
        }} />
      )}

      {open && (
        <div role="menu" aria-label="Create" style={{
          position: 'fixed', right: FAB_RIGHT, bottom: bottom + FAB_SIZE + 12, zIndex: 2600,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
        }}>
          {ITEMS.map(({ key, label: l, icon: Icon, nav }, i) => (
            <button key={key} role="menuitem" className="nx-fab-item"
              onClick={() => { setOpen(false); if (nav) onNavigate?.(nav); else setShow(key); }}
              // Staggered from the button outwards, so the menu reads as coming
              // OUT of the "+" rather than appearing all at once.
              style={{ animationDelay: `${(ITEMS.length - 1 - i) * 40}ms` }}
            ><Icon size={16} style={{ color: NX.primary, flexShrink: 0 }} /> {l}</button>
          ))}
        </div>
      )}

      <button onClick={() => setOpen((o) => !o)} className="nx-fab"
        aria-expanded={open} aria-haspopup="menu"
        title={open ? 'Close' : 'Create'} aria-label={open ? 'Close create menu' : 'Create'}
        style={{
          position: 'fixed', right: FAB_RIGHT, bottom, zIndex: 2600,
          width: FAB_SIZE, height: FAB_SIZE, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: NX.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT, padding: 0,
        }}>
        {/* One icon, rotated - not two icons swapped. The 45 degree turn IS the
            + becoming an x, so the control never blinks between two glyphs. */}
        <Plus size={26} style={{ transform: open ? 'rotate(45deg)' : 'none' }} className="nx-fab-icon" />
      </button>

      {show === 'task' && <CreateTaskModal defaults={taskDefaults} onClose={() => setShow(null)} lockedProjectId={taskDefaults.projectId || ''} />}

      {show === 'project' && (
        <ProjectCreateModal onClose={() => setShow(null)} onCreated={() => onNavigate && onNavigate('projects')} />
      )}

      {show === 'portfolio' && (
        <PortfolioCreateModal onClose={() => setShow(null)} onCreated={() => onNavigate && onNavigate('portfolios')} />
      )}

      {/* Reached from the floating + on the Teams page (the Create dropdown
          doesn't list departments - those are otherwise a Manage-only action). */}
      {show === 'department' && (
        <Modal title="Create a Team" onClose={() => setShow(null)}
          isDirty={!!(deptName.trim() || deptProjectId)} onSave={deptCanSubmit ? submitDept : undefined} footer={
          <>
            <button style={btn('outline')} onClick={() => setShow(null)}>Cancel</button>
            <button style={{ ...btn('primary'), opacity: !deptCanSubmit ? 0.6 : 1 }} onClick={submitDept} disabled={!deptCanSubmit}>
              {deptBusy ? 'Creating…' : 'Create'}
            </button>
          </>
        }>
          <div style={field}>
            <label style={label}>Name</label>
            <input autoFocus={!isMobile} value={deptName} onChange={(e) => setDeptName(e.target.value)} placeholder="Team name" style={inputStyle}
              onKeyDown={(e) => e.key === 'Enter' && submitDept()} />
          </div>
          <div style={field}>
            <label style={label}>Project (optional)</label>
            {/* No archived projects: this creates work, and archived is where work rests. */}
            <SearchSelect value={deptProjectId} placeholder="No project" searchPlaceholder="Search projects…"
              buttonStyle={{ ...inputStyle, cursor: 'pointer', justifyContent: 'space-between' }}
              emptyText="No projects yet."
              options={[{ id: '', label: 'No project' },
                        ...(projects || []).filter((p) => !p.archived)
                          .slice().sort((x, y) => String(x.name || '').localeCompare(String(y.name || ''), 'en', { sensitivity: 'base' }))
                          .map((p) => ({ id: p.id, label: p.name }))]}
              onPick={setDeptProjectId} />
          </div>
        </Modal>
      )}
    </div>
  );
}
