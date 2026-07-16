// Task Module — "+ Create" quick-create menu in the primary bar, beside Manage.
// Ported from the export's NexusCreateMenu (Task / Ticket / Project / Portfolio),
// styled with Nexus's shared .primary-btn class to match the SOP module's
// "+ New SOP" reference button.
import { useEffect, useRef, useState } from 'react';
import { Plus, ListChecks, Ticket, FolderKanban, Briefcase } from 'lucide-react';
import { useTasks } from './TasksContext';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { Modal } from './components';
import CreateTaskModal from './CreateTaskModal';
import { CreateTicketModal } from './TicketsView';
import { ProjectCreateModal } from './ProjectsView';
import { PortfolioCreateModal } from './PortfoliosView';

const ITEMS = [
  { key: 'task', label: 'Task', icon: ListChecks },
  { key: 'ticket', label: 'Ticket', icon: Ticket },
  { key: 'project', label: 'Project', icon: FolderKanban },
  { key: 'portfolio', label: 'Portfolio', icon: Briefcase },
];

// `fab` renders the mobile floating action button instead of the "+ Create"
// dropdown. Either way, tapping it opens the same Task / Ticket / Project /
// Portfolio quick-create menu — the FAB just anchors it above the button.
export default function CreateMenu({ onNavigate, fab = false, taskDefaults = {} }) {
  const { createDepartment } = useTasks();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(null); // 'task' | 'ticket' | 'project' | 'portfolio' | 'department' | null
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
  const field = { marginBottom: 14 };

  const [deptName, setDeptName] = useState('');
  const [deptBusy, setDeptBusy] = useState(false);
  const submitDept = async () => {
    if (!deptName.trim() || deptBusy) return;
    setDeptBusy(true);
    try {
      await createDepartment({ name: deptName.trim(), color: NX.blue, memberIds: [] });
      setDeptName(''); setShow(null);
      onNavigate && onNavigate('teams');
    } catch (e) { alert(`Could not create team: ${e.message || e}`); } finally { setDeptBusy(false); }
  };

  return (
    <div ref={ref} style={{ position: fab ? 'static' : 'relative' }}>
      {fab ? (
        // Sits above the "Report a Bug" pill so the two don't overlap.
        <button onClick={() => setOpen((o) => !o)} title="Create" aria-label="Create" style={{
          position: 'fixed', right: 16, bottom: 74, zIndex: 2500,
          width: 52, height: 52, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: NX.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(0,0,0,0.28)', fontFamily: FONT,
        }}><Plus size={24} /></button>
      ) : (
        <button className="primary-btn nx-iconbtn" onClick={() => setOpen((o) => !o)} title="Create" style={{ fontFamily: FONT }}>
          <Plus size={16} /> <span className="nx-btn-label">Create</span>
        </button>
      )}

      {open && (
        <div style={{
          // FAB: fixed menu sitting just above the floating button (bottom 74 + 52 + gap).
          // Desktop: dropdown anchored under the "+ Create" trigger.
          ...(fab
            ? { position: 'fixed', right: 16, bottom: 134, width: 200, zIndex: 2600 }
            : { position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 176, zIndex: 200 }),
          background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.16)', overflow: 'hidden', padding: 4,
        }}>
          {ITEMS.map(({ key, label: l, icon: Icon }) => (
            <button key={key} onClick={() => { setOpen(false); setShow(key); }} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px',
              border: 'none', background: 'transparent', borderRadius: 7, cursor: 'pointer',
              fontSize: 13.5, fontWeight: 500, color: NX.ink, fontFamily: FONT, textAlign: 'left',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover || NX.border2; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            ><Icon size={15} /> {l}</button>
          ))}
        </div>
      )}

      {show === 'task' && <CreateTaskModal defaults={taskDefaults} onClose={() => setShow(null)} />}
      {show === 'ticket' && <CreateTicketModal onClose={() => setShow(null)} />}

      {show === 'project' && (
        <ProjectCreateModal onClose={() => setShow(null)} onCreated={() => onNavigate && onNavigate('projects')} />
      )}

      {show === 'portfolio' && (
        <PortfolioCreateModal onClose={() => setShow(null)} onCreated={() => onNavigate && onNavigate('portfolios')} />
      )}

      {/* Reached from the floating + on the Teams page (the Create dropdown
          doesn't list departments — those are otherwise a Manage-only action). */}
      {show === 'department' && (
        <Modal title="Create a Team" onClose={() => setShow(null)} footer={
          <>
            <button style={btn('outline')} onClick={() => setShow(null)}>Cancel</button>
            <button style={{ ...btn('primary'), opacity: deptBusy ? 0.6 : 1 }} onClick={submitDept} disabled={deptBusy || !deptName.trim()}>
              {deptBusy ? 'Creating…' : 'Create'}
            </button>
          </>
        }>
          <div style={field}>
            <label style={label}>Name</label>
            <input autoFocus value={deptName} onChange={(e) => setDeptName(e.target.value)} placeholder="Team name" style={inputStyle}
              onKeyDown={(e) => e.key === 'Enter' && submitDept()} />
          </div>
        </Modal>
      )}
    </div>
  );
}
