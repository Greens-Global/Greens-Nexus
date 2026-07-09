// Task Module — Teams / Departments. A grid of department cards (member avatars +
// clickable project chips) that open a full department detail page (Overview /
// Members / All work / Calendar tabs + a Team menu), plus a member-request inbox
// for admins and dept CRUD (create/edit/delete with a color + icon picker).
// Ported from the export's TeamsPage / DepartmentDetail / DepartmentsContent /
// ProjectPopup, restyled to the Nexus inline idiom and wired to the real store.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Users, Plus, X, Trash2, Check, Clock, UserPlus, ArrowLeft, ArrowRight,
  ChevronRight, ChevronDown, ChevronLeft, FolderKanban, LayoutGrid, ListChecks,
  Link2, Mail, Upload, LogOut, Palette, Settings2, Pencil,
  Building2, Cpu, HardHat, Cog, Code2, Calculator, Megaphone, Briefcase,
  Wrench, FlaskConical, ShieldCheck, Rocket, PenTool, Landmark, Truck,
  Headphones, HeartPulse,
} from 'lucide-react';
import { NX, FONT, btn, input as inputStyle, chip, STATUS_META, statusChip } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect } from './components';
import { useConfirm, toast, Popover } from './shared';
import { useTasks } from './TasksContext';
import TaskDetailDrawer from './TaskDetailDrawer';
import TasksWorkspace from './TasksWorkspace';

// Curated department icons (keys match the export's deptIcons set).
const DEPT_ICONS = [
  { key: 'building', Icon: Building2 }, { key: 'cpu', Icon: Cpu },
  { key: 'hardhat', Icon: HardHat }, { key: 'cog', Icon: Cog },
  { key: 'code', Icon: Code2 }, { key: 'calculator', Icon: Calculator },
  { key: 'users', Icon: Users }, { key: 'megaphone', Icon: Megaphone },
  { key: 'briefcase', Icon: Briefcase }, { key: 'wrench', Icon: Wrench },
  { key: 'flask', Icon: FlaskConical }, { key: 'shield', Icon: ShieldCheck },
  { key: 'rocket', Icon: Rocket }, { key: 'pen', Icon: PenTool },
  { key: 'landmark', Icon: Landmark }, { key: 'truck', Icon: Truck },
  { key: 'headphones', Icon: Headphones }, { key: 'heart', Icon: HeartPulse },
];
const ICON_MAP = Object.fromEntries(DEPT_ICONS.map((d) => [d.key, d.Icon]));
function deptIcon(key) { return (key && ICON_MAP[key]) || Building2; }

const DEPT_COLORS = [
  '#2563eb', '#0d9488', '#16a34a', '#7c3aed',
  '#d97706', '#dc2626', '#db2777', '#0891b2',
  '#4f46e5', '#ca8a04', '#65a30d', '#475569',
];

const labelStyle = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const firstName = (name = '') => String(name).trim().split(/\s+/)[0] || name;

// ── Root: grid ⇄ detail page ─────────────────────────────────────────────────
export default function TeamsView() {
  const store = useTasks();
  const { departments, projects, memberRequests, nameOf, deptName, deleteDepartment, decideMemberRequest } = store;
  const [editing, setEditing] = useState(null);       // dept object, {} for new, or null
  const [openDeptId, setOpenDeptId] = useState(null); // drilled-into department
  const [openProjectId, setOpenProjectId] = useState(null);
  const [confirm, confirmNode] = useConfirm();

  const projectsByDept = useMemo(() => {
    const m = {};
    for (const p of projects) (m[p.departmentId || ''] ||= []).push(p);
    return m;
  }, [projects]);

  const pending = useMemo(
    () => memberRequests.filter((r) => (r.status || 'pending') === 'pending'),
    [memberRequests],
  );

  const openDept = openDeptId ? departments.find((d) => d.id === openDeptId) : null;

  // Delete a department — blocked while it still owns projects; type-to-confirm otherwise.
  const removeDept = async (dept) => {
    const owned = projectsByDept[dept.id] || [];
    if (owned.length > 0) {
      toast('Reassign this department’s projects before deleting it');
      return;
    }
    const ok = await confirm({
      title: `Delete "${dept.name}"?`,
      message: 'This permanently removes the department and its member assignments. This can’t be undone.',
      danger: true, confirmLabel: 'Delete department', requireText: dept.name,
    });
    if (!ok) return;
    try {
      await deleteDepartment(dept.id);
      toast(`Department "${dept.name}" deleted`, 'success');
      if (openDeptId === dept.id) setOpenDeptId(null);
      setEditing(null);
    } catch { toast('You do not have permission to delete departments.'); }
  };

  if (openDept) {
    return (
      <>
        <DepartmentDetail
          dept={openDept}
          onBack={() => setOpenDeptId(null)}
          onEditSettings={() => setEditing(openDept)}
          onOpenProject={setOpenProjectId}
        />
        {editing && editing.id && (
          <DeptModal dept={editing} onClose={() => setEditing(null)} onDelete={() => removeDept(editing)} />
        )}
        {openProjectId && <ProjectPopup projectId={openProjectId} onClose={() => setOpenProjectId(null)} />}
        {confirmNode}
      </>
    );
  }

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto', background: NX.surface }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Teams</div>
        <div style={{ fontSize: 13, color: NX.dim }}>Departments group members and their work.</div>
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setEditing({})}>
          <Plus size={15} />New department
        </button>
      </div>

      <div style={{ padding: 16 }}>
        {/* Member request inbox */}
        {pending.length > 0 && (
          <div style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13, fontWeight: 700 }}>
              <Clock size={15} style={{ color: NX.amber }} />
              Member requests
              <span style={{ color: NX.faint, fontWeight: 600 }}>{pending.length}</span>
            </div>
            <div>
              {pending.map((r) => {
                const isRemove = r.kind === 'remove';
                return (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${NX.border2}` }}>
                    <Avatar email={r.userId} name={nameOf(r.userId)} size={30} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: NX.ink }}>{nameOf(r.userId)}</span>
                        <span style={{
                          display: 'inline-flex', padding: '1px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: 0.3,
                          color: isRemove ? NX.red : NX.green, background: isRemove ? '#fde5e5' : '#e3f5ea',
                        }}>{isRemove ? 'Remove' : 'Add'}</span>
                      </div>
                      <div style={{ fontSize: 12, color: NX.faint, marginTop: 1 }}>
                        {isRemove ? 'Removal' : 'Invite'} for {deptName(r.departmentId) || 'a department'}
                        {r.requestedById ? ` · requested by ${nameOf(r.requestedById)}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                      <button onClick={() => decideMemberRequest(r.id, 'approved').catch(() => toast('You do not have permission to decide member requests.'))}
                        style={{ ...btn('ghost'), color: NX.green, background: '#e3f5ea', padding: '6px 10px' }}>
                        <Check size={14} />Approve
                      </button>
                      <button onClick={() => decideMemberRequest(r.id, 'rejected').catch(() => toast('You do not have permission to decide member requests.'))}
                        style={{ ...btn('ghost'), color: NX.dim, padding: '6px 10px' }}>
                        <X size={14} />Deny
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Department grid */}
        {departments.length === 0 ? (
          <EmptyState icon={Users} title="No departments yet" hint="Create a department to group members and their work." />
        ) : (
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {departments.map((d) => (
              <DeptCard
                key={d.id}
                dept={d}
                nameOf={nameOf}
                deptProjects={projectsByDept[d.id] || []}
                onOpen={() => setOpenDeptId(d.id)}
                onEdit={() => setEditing(d)}
                onDelete={() => removeDept(d)}
                onOpenProject={setOpenProjectId}
              />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <DeptModal
          dept={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onDelete={editing.id ? () => removeDept(editing) : null}
        />
      )}
      {openProjectId && <ProjectPopup projectId={openProjectId} onClose={() => setOpenProjectId(null)} />}
      {confirmNode}
    </div>
  );
}

// ── Department card ──────────────────────────────────────────────────────────
function DeptCard({ dept, nameOf, deptProjects, onOpen, onEdit, onDelete, onOpenProject }) {
  const Icon = deptIcon(dept.icon);
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const shown = members.slice(0, 6);

  return (
    <div onClick={onOpen} style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 14, padding: 16, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12, transition: 'border-color 0.13s' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.primary; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${color}1a`, color }}>
          <Icon size={21} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dept.name}</div>
          <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>
            {members.length} member{members.length === 1 ? '' : 's'} · {deptProjects.length} project{deptProjects.length === 1 ? '' : 's'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <button title="Edit department" onClick={onEdit} style={{ ...btn('ghost'), padding: 5 }}><Pencil size={14} /></button>
          <button title={deptProjects.length ? 'Reassign its projects first' : 'Delete department'} onClick={onDelete} style={{ ...btn('ghost'), padding: 5, color: NX.red }}><Trash2 size={14} /></button>
          <ChevronRight size={18} style={{ color: NX.faint, alignSelf: 'center' }} />
        </div>
      </div>

      {/* Teammates */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint, marginBottom: 7 }}>Teammates</div>
        {members.length === 0 ? (
          <div style={{ fontSize: 12.5, color: NX.faint }}>No members yet.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {shown.map((email) => (
              <span key={email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: NX.surface2, borderRadius: 999, padding: '2px 8px 2px 2px' }}>
                <Avatar email={email} name={nameOf(email)} size={20} />
                <span style={{ fontSize: 12, color: NX.ink }}>{firstName(nameOf(email))}</span>
              </span>
            ))}
            {members.length > shown.length && (
              <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>+{members.length - shown.length}</span>
            )}
          </div>
        )}
      </div>

      {/* Projects */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint, marginBottom: 7 }}>Projects</div>
        {deptProjects.length === 0 ? (
          <div style={{ fontSize: 12.5, color: NX.faint }}>No projects yet.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {deptProjects.map((p) => (
              <button key={p.id} onClick={(e) => { e.stopPropagation(); onOpenProject(p.id); }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '4px 8px', fontSize: 12, color: NX.ink, cursor: 'pointer', fontFamily: FONT }}
                onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = NX.surface2; }}>
                <FolderKanban size={12} style={{ color: NX.faint }} />
                <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <ArrowRight size={12} style={{ color: NX.faint }} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Department detail page (Overview / Members / All work / Calendar) ─────────
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'members', label: 'Members' },
  { key: 'work', label: 'All work' },
  { key: 'calendar', label: 'Calendar' },
];

function DepartmentDetail({ dept, onBack, onEditSettings, onOpenProject }) {
  const store = useTasks();
  const { projects, nameOf, myEmail, updateDepartment } = store;
  const [confirm, confirmNode] = useConfirm();
  const [tab, setTab] = useState('overview');
  const [openTaskId, setOpenTaskId] = useState(null);
  const Icon = deptIcon(dept.icon);
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const deptProjects = projects.filter((p) => p.departmentId === dept.id);

  const copyLink = () => {
    const url = `${window.location.origin}/manage#department/${dept.id}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => toast('Team link copied to clipboard', 'success'), () => toast(url));
    } else { toast(url); }
  };

  const removeMe = async () => {
    const me = (myEmail || '').toLowerCase();
    if (!members.some((e) => (e || '').toLowerCase() === me)) {
      toast('You are not a member of this team');
      return;
    }
    const ok = await confirm({
      title: `Leave "${dept.name}"?`,
      message: 'You’ll lose access to this team’s projects until you’re added back.',
      danger: true, confirmLabel: 'Leave team',
    });
    if (!ok) return;
    try {
      await updateDepartment(dept.id, { memberIds: members.filter((e) => (e || '').toLowerCase() !== me) });
      toast(`You left "${dept.name}"`, 'success');
    } catch { toast('Could not update team membership.'); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: NX.surface }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px 0' }}>
        <button onClick={onBack} title="Back to departments" style={{ ...btn('ghost'), padding: 6, marginLeft: -6 }}>
          <ArrowLeft size={18} />
        </button>
        <span style={{ width: 44, height: 44, borderRadius: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${color}1a`, color }}>
          <Icon size={22} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dept.name}</h1>
            <TeamMenu deptName={dept.name} onEditSettings={onEditSettings} onCopyLink={copyLink} onRemoveMe={removeMe} />
          </div>
          <div style={{ fontSize: 12, color: NX.faint }}>
            {members.length} member{members.length === 1 ? '' : 's'} · {deptProjects.length} project{deptProjects.length === 1 ? '' : 's'}
          </div>
        </div>
        <MemberStack members={members} nameOf={nameOf} />
      </div>

      {/* Tabs */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 14, borderBottom: `1px solid ${NX.border}`, padding: '0 20px', overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flexShrink: 0, border: 'none', borderBottom: `2px solid ${tab === t.key ? NX.primary : 'transparent'}`,
            background: 'transparent', padding: '10px 12px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            color: tab === t.key ? NX.ink : NX.dim, fontFamily: FONT,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px' }}>
        {tab === 'overview' && <OverviewTab dept={dept} deptProjects={deptProjects} onSeeMembers={() => setTab('members')} onOpenProject={onOpenProject} />}
        {tab === 'members' && <MembersTab dept={dept} />}
        {tab === 'work' && <AllWorkTab deptProjects={deptProjects} onOpenTask={setOpenTaskId} onOpenProject={onOpenProject} />}
        {tab === 'calendar' && <CalendarTab dept={dept} deptProjects={deptProjects} onOpenTask={setOpenTaskId} />}
      </div>

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
      {confirmNode}
    </div>
  );
}

function TeamMenu({ deptName, onEditSettings, onCopyLink, onRemoveMe }) {
  const item = (icon, label, onClick, danger) => (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 7, fontSize: 13, cursor: 'pointer', color: danger ? NX.red : NX.ink }}
      onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      {icon}{label}
    </div>
  );
  return (
    <Popover width={244} align="left" trigger={(toggle) => (
      <button onClick={toggle} title="Team options" style={{ ...btn('ghost'), padding: 4, color: NX.faint }}>
        <ChevronDown size={16} />
      </button>
    )}>
      {(close) => (
        <>
          {item(<Settings2 size={15} style={{ color: NX.faint }} />, 'Edit team settings', () => { close(); onEditSettings(); })}
          {item(<Palette size={15} style={{ color: NX.faint }} />, 'Set color & icon', () => { close(); onEditSettings(); })}
          {item(<Link2 size={15} style={{ color: NX.faint }} />, 'Copy team link', () => { close(); onCopyLink(); })}
          {item(<Mail size={15} style={{ color: NX.faint }} />, 'Send a message via email', () => { close(); window.location.href = `mailto:?subject=${encodeURIComponent(deptName)}`; })}
          {item(<Upload size={15} style={{ color: NX.faint }} />, 'Import CSV', () => { close(); toast('CSV import is coming soon'); })}
          <div style={{ margin: '4px 0', borderTop: `1px solid ${NX.border}` }} />
          {item(<LogOut size={15} style={{ color: NX.red }} />, 'Remove me from this team', () => { close(); onRemoveMe(); }, true)}
        </>
      )}
    </Popover>
  );
}

function MemberStack({ members, nameOf }) {
  const shown = members.slice(0, 5);
  const extra = members.length - shown.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      {shown.map((email) => (
        <span key={email} style={{ marginRight: -8, border: `2px solid ${NX.surface}`, borderRadius: '50%', display: 'inline-flex' }}>
          <Avatar email={email} name={nameOf(email)} size={28} />
        </span>
      ))}
      {extra > 0 && (
        <span style={{ marginLeft: -8, width: 28, height: 28, borderRadius: '50%', border: `2px solid ${NX.surface}`, background: NX.surface2, color: NX.dim, fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>+{extra}</span>
      )}
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────
function OverviewTab({ dept, deptProjects, onSeeMembers, onOpenProject }) {
  const store = useTasks();
  const { tasks, memberRequests, nameOf, decideMemberRequest } = store;
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const shown = members.slice(0, 8);
  const pending = memberRequests.filter((r) => (r.status || 'pending') === 'pending' && r.departmentId === dept.id);

  return (
    <div>
      {/* Hero banner */}
      <div style={{ height: 112, borderRadius: 16, marginBottom: 20, background: `linear-gradient(120deg, ${color}22, ${color}0a)` }} />

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        {/* Projects panel */}
        <div style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 16, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: NX.ink }}>
              <LayoutGrid size={16} style={{ color: NX.faint }} /> Projects
            </div>
            <AssignProjectMenu dept={dept} />
          </div>
          {deptProjects.length === 0 ? (
            <p style={{ fontSize: 13, color: NX.faint, margin: 0 }}>No projects yet. Assign one to give members access.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {deptProjects.map((p) => {
                const count = tasks.filter((t) => t.projectId === p.id).length;
                return (
                  <button key={p.id} onClick={() => onOpenProject(p.id)} title="Open project"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 12, padding: '9px 12px', textAlign: 'left', background: NX.surface, cursor: 'pointer', fontFamily: FONT }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.primary; e.currentTarget.style.background = NX.hover; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; e.currentTarget.style.background = NX.surface; }}>
                    <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: NX.surface2, color: NX.faint }}>
                      <FolderKanban size={14} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: NX.ink }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: NX.faint }}>{count} task{count === 1 ? '' : 's'}</span>
                    <ChevronRight size={15} style={{ color: NX.faint }} />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Members panel */}
        <div style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 16, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>Members</div>
            <button onClick={onSeeMembers} style={{ ...btn('ghost'), padding: 0, color: NX.blue, fontSize: 12 }}>View all {members.length}</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {shown.map((email) => (
              <span key={email} title={nameOf(email)}><Avatar email={email} name={nameOf(email)} size={40} /></span>
            ))}
            <AddMemberMenu dept={dept} trigger={(toggle) => (
              <button onClick={toggle} title="Add member" style={{ width: 40, height: 40, borderRadius: '50%', border: `1px dashed ${NX.border}`, background: NX.surface, color: NX.dim, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <Plus size={16} />
              </button>
            )} />
          </div>
          {members.length === 0 && <p style={{ marginTop: 8, fontSize: 12, color: NX.faint }}>No members yet.</p>}

          {pending.length > 0 && (
            <div style={{ marginTop: 14, borderTop: `1px solid ${NX.border}`, paddingTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 8 }}>
                <Clock size={12} /> Awaiting approval
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pending.map((r) => {
                  const isRemove = r.kind === 'remove';
                  return (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar email={r.userId} name={nameOf(r.userId)} size={22} />
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: NX.ink }}>
                        {nameOf(r.userId)}
                        <span style={{ marginLeft: 6, padding: '1px 5px', borderRadius: 4, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: isRemove ? NX.red : NX.green, background: isRemove ? '#fde5e5' : '#e3f5ea' }}>{isRemove ? 'Remove' : 'Add'}</span>
                      </span>
                      <button onClick={() => decideMemberRequest(r.id, 'approved').catch(() => toast('You do not have permission to decide member requests.'))} style={{ ...btn('ghost'), padding: '3px 7px', fontSize: 11, color: NX.green, background: '#e3f5ea' }}>Approve</button>
                      <button onClick={() => decideMemberRequest(r.id, 'rejected').catch(() => toast('You do not have permission to decide member requests.'))} style={{ ...btn('ghost'), padding: '3px 7px', fontSize: 11, color: NX.faint }}>Decline</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Members tab ──────────────────────────────────────────────────────────────
function MembersTab({ dept }) {
  const store = useTasks();
  const { memberRequests, nameOf, updateDepartment, decideMemberRequest } = store;
  const [confirm, confirmNode] = useConfirm();
  const members = dept.memberIds || [];
  const pending = memberRequests.filter((r) => (r.status || 'pending') === 'pending' && r.departmentId === dept.id);

  const removeMember = async (email) => {
    const ok = await confirm({
      title: `Remove ${firstName(nameOf(email))} from ${dept.name}?`,
      message: `${nameOf(email)} will immediately lose access to this team’s projects.`,
      danger: true, confirmLabel: 'Remove member',
    });
    if (!ok) return;
    try { await updateDepartment(dept.id, { memberIds: members.filter((e) => e !== email) }); }
    catch { toast('Could not update team membership.'); }
  };

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{members.length} member{members.length === 1 ? '' : 's'}</div>
        <AddMemberMenu dept={dept} trigger={(toggle) => (
          <button onClick={toggle} style={btn('outline')}><UserPlus size={14} />Add member</button>
        )} />
      </div>

      <div style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 16, overflow: 'hidden' }}>
        {members.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: NX.faint }}>No members yet. Add teammates to give them access to this department.</div>
        ) : members.map((email) => (
          <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderTop: members[0] === email ? 'none' : `1px solid ${NX.border2}` }}>
            <Avatar email={email} name={nameOf(email)} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(email)}</div>
              <div style={{ fontSize: 12, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>
            </div>
            <button onClick={() => removeMember(email)} title="Remove from department" style={{ ...btn('ghost'), padding: '5px 8px', fontSize: 12, color: NX.faint }}>
              <X size={13} />Remove
            </button>
          </div>
        ))}
      </div>

      {pending.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint, marginBottom: 8 }}>
            <Clock size={12} /> Awaiting approval ({pending.length})
          </div>
          <div style={{ background: NX.surface, border: `1px dashed ${NX.border}`, borderRadius: 16, overflow: 'hidden' }}>
            {pending.map((r, i) => {
              const isRemove = r.kind === 'remove';
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderTop: i === 0 ? 'none' : `1px solid ${NX.border2}` }}>
                  <Avatar email={r.userId} name={nameOf(r.userId)} size={34} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(r.userId)}</span>
                      <span style={{ padding: '1px 6px', borderRadius: 5, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: isRemove ? NX.red : NX.green, background: isRemove ? '#fde5e5' : '#e3f5ea' }}>{isRemove ? 'Remove' : 'Add'}</span>
                    </div>
                    <div style={{ fontSize: 12, color: NX.faint }}>
                      {isRemove ? 'Removal' : 'Invite'}{r.requestedById ? ` requested by ${firstName(nameOf(r.requestedById))}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => decideMemberRequest(r.id, 'approved').catch(() => toast('You do not have permission to decide member requests.'))} style={{ ...btn('ghost'), padding: '5px 9px', fontSize: 12, color: NX.green, background: '#e3f5ea' }}><Check size={13} />Approve</button>
                    <button onClick={() => decideMemberRequest(r.id, 'rejected').catch(() => toast('You do not have permission to decide member requests.'))} style={{ ...btn('ghost'), padding: '5px 9px', fontSize: 12, color: NX.faint }}><X size={13} />Decline</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {confirmNode}
    </div>
  );
}

// ── All work tab ─────────────────────────────────────────────────────────────
function AllWorkTab({ deptProjects, onOpenTask, onOpenProject }) {
  if (deptProjects.length === 0) {
    return <div style={{ background: NX.surface, border: `1px dashed ${NX.border}`, borderRadius: 16, padding: '40px 16px', textAlign: 'center', fontSize: 13, color: NX.faint }}>No projects in this department yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {deptProjects.map((p) => (
        <ProjectWorkSection key={p.id} project={p} onOpenTask={onOpenTask} onOpenProject={onOpenProject} />
      ))}
    </div>
  );
}

function ProjectWorkSection({ project, onOpenTask, onOpenProject }) {
  const store = useTasks();
  const { tasks, nameOf } = store;
  const [open, setOpen] = useState(true);
  const own = tasks.filter((t) => t.projectId === project.id);

  return (
    <div style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${NX.border}`, padding: '11px 14px' }}>
        <button onClick={() => setOpen((o) => !o)} style={{ ...btn('ghost'), padding: 0, minWidth: 0, flex: 1, justifyContent: 'flex-start', gap: 8, color: NX.ink }}>
          <ChevronRight size={16} style={{ color: NX.faint, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.13s' }} />
          <FolderKanban size={15} style={{ color: NX.faint }} />
          <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: NX.faint }}>{own.length} task{own.length === 1 ? '' : 's'}</span>
        </button>
        <button onClick={() => onOpenProject(project.id)} title="Open project page" style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12, color: NX.blue }}>Open project</button>
      </div>
      {open && (
        own.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: 12, color: NX.faint }}>No tasks in this project.</div>
        ) : (
          <div>
            {own.map((t, i) => {
              const s = statusChip(t.status);
              return (
                <button key={t.id} onClick={() => onOpenTask(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '9px 16px', textAlign: 'left', background: 'transparent', border: 'none', borderTop: i === 0 ? 'none' : `1px solid ${NX.border2}`, cursor: 'pointer', fontFamily: FONT }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <ListChecks size={14} style={{ color: NX.faint, flexShrink: 0 }} />
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: NX.ink }}>{t.title}</span>
                  {(() => { const { label, ...st } = s; return <span style={st}>{label}</span>; })()}
                  {t.assigneeId && <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={22} />}
                </button>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ── Calendar tab ─────────────────────────────────────────────────────────────
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarTab({ dept, deptProjects, onOpenTask }) {
  const store = useTasks();
  const { tasks, nameOf } = store;
  const [cursor, setCursor] = useState(() => new Date());
  const [showWeekends, setShowWeekends] = useState(false);

  const projectIds = new Set(deptProjects.map((p) => p.id));
  const tasksByDay = useMemo(() => {
    const m = new Map();
    for (const t of tasks) {
      if (t.dueOn && t.projectId && projectIds.has(t.projectId)) {
        const key = String(t.dueOn).slice(0, 10);
        const arr = m.get(key) || [];
        arr.push(t);
        m.set(key, arr);
      }
    }
    return m;
  }, [tasks, dept.id, deptProjects.length]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;         // Monday-based
  const gridStart = new Date(year, month, 1 - startOffset);
  const days = [];
  for (let i = 0; i < 42; i++) days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));

  const weekdays = showWeekends ? ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] : ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  const visibleDays = showWeekends ? days : days.filter((d) => d.getDay() !== 0 && d.getDay() !== 6);
  const todayKey = ymd(new Date());
  const monthLabel = first.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const cols = `repeat(${weekdays.length}, minmax(0, 1fr))`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button onClick={() => setCursor(new Date(year, month - 1, 1))} title="Previous month" style={{ ...btn('ghost'), padding: 6 }}><ChevronLeft size={18} /></button>
        <button onClick={() => setCursor(new Date())} style={btn('outline')}>Today</button>
        <button onClick={() => setCursor(new Date(year, month + 1, 1))} title="Next month" style={{ ...btn('ghost'), padding: 6 }}><ChevronRight size={18} /></button>
        <div style={{ marginLeft: 4, fontSize: 15, fontWeight: 700, color: NX.ink }}>{monthLabel}</div>
        <button onClick={() => setShowWeekends((w) => !w)} style={{ ...btn('ghost'), marginLeft: 'auto' }}>Weekends: {showWeekends ? 'On' : 'Off'}</button>
      </div>

      {/* Weekday header */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: '10px 10px 0 0', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: NX.faint }}>
        {weekdays.map((w) => <div key={w} style={{ padding: '6px 8px' }}>{w}</div>)}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, flex: 1, overflow: 'auto', border: `1px solid ${NX.border}`, borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
        {visibleDays.map((d, i) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === month;
          const dayTasks = tasksByDay.get(key) || [];
          const isToday = key === todayKey;
          return (
            <div key={i} style={{ minHeight: 110, borderBottom: `1px solid ${NX.border2}`, borderRight: `1px solid ${NX.border2}`, padding: 6, background: inMonth ? NX.surface : NX.surface2 }}>
              <div style={{ marginBottom: 4 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 20, minWidth: 20, padding: '0 4px', borderRadius: 999, fontSize: 12,
                  background: isToday ? NX.primary : 'transparent', color: isToday ? '#fff' : inMonth ? NX.ink : NX.faint, fontWeight: isToday ? 700 : 400 }}>
                  {d.getDate() === 1 ? d.toLocaleString(undefined, { month: 'short', day: 'numeric' }) : d.getDate()}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {dayTasks.map((t) => {
                  const meta = STATUS_META[t.status];
                  return (
                    <button key={t.id} onClick={() => onOpenTask(t.id)} title={t.title}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 6, border: 'none', textAlign: 'left', fontSize: 11, lineHeight: 1.2, cursor: 'pointer', fontFamily: FONT,
                        background: meta ? meta.tint : NX.surface2, opacity: t.completed ? 0.6 : 1 }}>
                      {t.assigneeId && <Avatar email={t.assigneeId} name={nameOf(t.assigneeId)} size={16} />}
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? NX.faint : NX.ink }}>{t.title}</span>
                      {meta && <span style={{ width: 10, height: 10, borderRadius: 3, flexShrink: 0, background: meta.color }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared menus ─────────────────────────────────────────────────────────────
function AssignProjectMenu({ dept }) {
  const store = useTasks();
  const { projects, deptName, updateProject } = store;
  const other = projects.filter((p) => p.departmentId !== dept.id);
  return (
    <Popover width={264} align="right" trigger={(toggle) => (
      <button onClick={toggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px dashed ${NX.border}`, borderRadius: 8, padding: '4px 8px', fontSize: 12, color: NX.dim, background: NX.surface, cursor: 'pointer', fontFamily: FONT }}>
        <Plus size={12} /> Assign project
      </button>
    )}>
      {(close) => (
        other.length === 0 ? (
          <div style={{ padding: '8px 10px', fontSize: 12, color: NX.faint }}>No other projects to assign.</div>
        ) : other.map((p) => {
          const from = p.departmentId ? deptName(p.departmentId) : '';
          return (
            <div key={p.id} onClick={async () => {
              close();
              try { await updateProject(p.id, { departmentId: dept.id }); toast(`Moved "${p.name}" to ${dept.name}`, 'success'); }
              catch { toast('Could not move the project.'); }
            }} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 7, fontSize: 13, cursor: 'pointer', color: NX.ink }}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <FolderKanban size={15} style={{ color: NX.faint, flexShrink: 0 }} />
              <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {from && <span style={{ fontSize: 11, color: NX.faint }}>in {from}</span>}
              </span>
            </div>
          );
        })
      )}
    </Popover>
  );
}

function AddMemberMenu({ dept, trigger }) {
  const store = useTasks();
  const { updateDepartment } = store;
  const people = usePeople();
  const members = dept.memberIds || [];
  const [q, setQ] = useState('');
  const candidates = people.filter((p) => !members.includes(p.email));
  const filtered = q ? candidates.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : candidates;

  return (
    <Popover width={288} align="right" trigger={trigger}>
      {(close) => (
        <div>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add from directory…"
            style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 10px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box' }} />
          <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 4 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 12, color: NX.faint }}>Everyone is already a member.</div>
            ) : filtered.map((p) => (
              <div key={p.email} onClick={async () => {
                close();
                try { await updateDepartment(dept.id, { memberIds: [...members, p.email] }); toast(`${firstName(p.name)} added to ${dept.name}`, 'success'); }
                catch { toast('Could not add the member.'); }
              }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, fontSize: 13, cursor: 'pointer', color: NX.ink }}
                onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                <Avatar email={p.email} name={p.name} size={24} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

// ── Project popup (drill into a project without leaving Teams) ────────────────
function ProjectPopup({ projectId, onClose }) {
  const store = useTasks();
  const { projectById, deptById } = store;
  const project = projectById(projectId);
  const dept = project ? deptById(project.departmentId) : null;
  const dcolor = (dept && dept.color) || project?.color || NX.blue;

  return createPortal(
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONT }}>
      <div style={{ background: NX.surface, borderRadius: 16, width: '95vw', maxWidth: 1400, height: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${dcolor}1a`, color: dcolor }}>
            <FolderKanban size={17} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project?.name || 'Project'}</div>
          {dept && <span style={chip(dept.color || NX.blue, `${dept.color || NX.blue}1a`)}>{dept.name}</span>}
          <button onClick={onClose} title="Close" style={{ ...btn('ghost'), padding: 6, marginLeft: 'auto' }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TasksWorkspace lockedProjectId={projectId} title={project?.name || 'Project'} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Create / edit department modal ───────────────────────────────────────────
function DeptModal({ dept, onClose, onDelete }) {
  const store = useTasks();
  const { createDepartment, updateDepartment, nameOf } = store;
  const people = usePeople();
  const nameFor = (email) => people.find((p) => p.email === email)?.name || nameOf(email) || email;

  const [name, setName] = useState(dept?.name || '');
  const [color, setColor] = useState(dept?.color || DEPT_COLORS[0]);
  const [icon, setIcon] = useState(dept?.icon || 'building');
  const [members, setMembers] = useState(dept?.memberIds || []);
  const [saving, setSaving] = useState(false);

  const addMember = (email) => { if (email) setMembers((m) => (m.includes(email) ? m : [...m, email])); };
  const removeMember = (email) => setMembers((m) => m.filter((e) => e !== email));

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const payload = { name: name.trim(), color, icon, memberIds: members };
    try {
      if (dept) { await updateDepartment(dept.id, payload); toast(`Department "${name.trim()}" updated`, 'success'); }
      else { await createDepartment(payload); toast(`Department "${name.trim()}" created`, 'success'); }
      onClose();
    } catch { setSaving(false); toast('Could not save the department.'); }
  };

  const PreviewIcon = deptIcon(icon);

  return (
    <Modal
      title={dept ? 'Edit department' : 'New department'}
      onClose={onClose}
      footer={(
        <>
          {onDelete && (
            <button onClick={onDelete} style={{ ...btn('ghost'), color: NX.red, marginRight: 'auto' }}>
              <Trash2 size={15} />Delete
            </button>
          )}
          <button onClick={onClose} style={btn('outline')}>Cancel</button>
          <button onClick={save} disabled={!name.trim() || saving} style={{ ...btn('primary'), opacity: !name.trim() || saving ? 0.55 : 1 }}>
            {dept ? 'Save changes' : 'Create department'}
          </button>
        </>
      )}
    >
      {/* Name + live preview */}
      <label style={labelStyle}>Name</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 46, height: 46, borderRadius: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${color}1a`, color }}>
          <PreviewIcon size={22} />
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} placeholder="e.g. Engineering" autoFocus style={inputStyle} />
      </div>

      {/* Color */}
      <label style={{ ...labelStyle, marginTop: 16 }}>Color</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {DEPT_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} title={c} style={{
            width: 26, height: 26, borderRadius: 8, background: c, cursor: 'pointer',
            border: color === c ? `2px solid ${NX.ink}` : '2px solid transparent',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {color === c && <Check size={14} style={{ color: '#fff' }} />}
          </button>
        ))}
      </div>

      {/* Icon */}
      <label style={{ ...labelStyle, marginTop: 16 }}>Icon</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {DEPT_ICONS.map(({ key, Icon }) => (
          <button key={key} type="button" onClick={() => setIcon(key)} title={key} style={{
            width: 36, height: 36, borderRadius: 9, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: `1px solid ${icon === key ? color : NX.border}`,
            background: icon === key ? `${color}1a` : NX.surface,
            color: icon === key ? color : NX.dim,
          }}>
            <Icon size={18} />
          </button>
        ))}
      </div>

      {/* Members */}
      <label style={{ ...labelStyle, marginTop: 16 }}>Members</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: members.length ? 10 : 0 }}>
        {members.map((email) => (
          <span key={email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 6px 3px 3px', fontSize: 12.5 }}>
            <Avatar email={email} name={nameFor(email)} size={20} />
            <span style={{ color: NX.ink }}>{nameFor(email)}</span>
            <button onClick={() => removeMember(email)} title="Remove" style={{ ...btn('ghost'), padding: 1, color: NX.faint }}>
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <UserPlus size={15} style={{ color: NX.faint, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <PersonSelect value={null} onChange={addMember} people={people.filter((p) => !members.includes(p.email))} placeholder="Add member…" />
        </div>
      </div>
    </Modal>
  );
}
