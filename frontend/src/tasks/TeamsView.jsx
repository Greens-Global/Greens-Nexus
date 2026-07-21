// Task Module — Teams / Departments. Grid of department cards + add/edit modal
// (name, color, icon, members) + a member-request inbox for admins. Ported from
// the export's TeamsPage / DepartmentDetail, restyled to the Nexus inline idiom.
import { useMemo, useRef, useState } from 'react';
import {
  Users, X, Trash2, Check, Clock, UserPlus, ArrowLeft, ChevronDown, ChevronRight,
  FolderKanban, LayoutGrid, ListChecks, Plus as PlusIcon,
  Building2, Cpu, HardHat, Cog, Code2, Calculator, Megaphone, Briefcase,
  Wrench, FlaskConical, ShieldCheck, Rocket, PenTool, Landmark, Truck,
  Headphones, HeartPulse,
} from 'lucide-react';
import { NX, FONT, btn, input as inputStyle, STATUS_META } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect, useClickOutside } from './components';
import { useTasks } from './TasksContext';
import { topLevel } from './lib';
import { CalendarView } from './views/extras';

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
export function deptIcon(key) { return (key && ICON_MAP[key]) || Building2; }
export { DEPT_ICONS };

export const DEPT_COLORS = [
  '#2563eb', '#0d9488', '#16a34a', '#7c3aed',
  '#d97706', '#dc2626', '#db2777', '#0891b2',
  '#4f46e5', '#ca8a04', '#65a30d', '#475569',
];

export default function TeamsView({ onNavigate }) {
  const { departments, memberRequests, tasks, nameOf, deptName, deleteDepartment, decideMemberRequest } = useTasks();
  const [editing, setEditing] = useState(null); // dept object, or {} for new, or null
  const [detailId, setDetailId] = useState(null);

  const taskCountByDept = useMemo(() => {
    const m = {};
    for (const t of tasks) if (t.departmentId) m[t.departmentId] = (m[t.departmentId] || 0) + 1;
    return m;
  }, [tasks]);

  const pending = useMemo(
    () => memberRequests.filter((r) => (r.status || 'pending') === 'pending'),
    [memberRequests],
  );

  if (detailId) {
    const dept = departments.find((d) => d.id === detailId);
    if (!dept) { setDetailId(null); return null; }
    return (
      <DepartmentDetail
        dept={dept} onBack={() => setDetailId(null)}
        onEdit={() => setEditing(dept)} onNavigate={onNavigate}
      />
    );
  }

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: NX.canvas }}>
      {/* Toolbar — creating a new department is a Manage-only action (Manage → Departments);
          this page is for browsing/editing existing ones. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, flexWrap: 'wrap', background: NX.surface, flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Teams</div>
        <div style={{ fontSize: 13, color: NX.dim }}>Teams group members and their work.</div>
      </div>

      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
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
                          color: isRemove ? NX.red : NX.green, background: isRemove ? 'rgba(220,38,38,0.15)' : 'rgba(22,163,74,0.15)',
                        }}>{isRemove ? 'Remove' : 'Add'}</span>
                      </div>
                      <div style={{ fontSize: 12, color: NX.faint, marginTop: 1 }}>
                        {isRemove ? 'Removal' : 'Invite'} for {deptName(r.departmentId) || 'a team'}
                        {r.requestedById ? ` · requested by ${nameOf(r.requestedById)}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                      <button onClick={() => decideMemberRequest(r.id, 'approved').catch(() => window.alert('You do not have permission to decide member requests.'))}
                        style={{ ...btn('ghost'), color: NX.green, background: 'rgba(22,163,74,0.15)', padding: '6px 10px' }}>
                        <Check size={14} />Approve
                      </button>
                      <button onClick={() => decideMemberRequest(r.id, 'rejected').catch(() => window.alert('You do not have permission to decide member requests.'))}
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
          <EmptyState icon={Users} title="No Teams Yet" hint="Create a team to group members and their work." />
        ) : (
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
            {departments.map((d) => (
              <DeptCard key={d.id} dept={d} nameOf={nameOf} taskCount={taskCountByDept[d.id] || 0} onOpen={() => setDetailId(d.id)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <DeptModal
          dept={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onDelete={editing.id ? () => { if (confirm(`Delete "${editing.name}"? This can't be undone.`)) { deleteDepartment(editing.id); setEditing(null); } } : null}
        />
      )}
    </div>
  );
}

function DeptCard({ dept, nameOf, taskCount, onOpen }) {
  const Icon = deptIcon(dept.icon);
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const shown = members.slice(0, 6);
  const extra = members.length - shown.length;
  return (
    <div onClick={onOpen} style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 14, padding: 16, cursor: 'pointer', transition: 'border-color 0.13s' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.primary; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${color}1a`, color }}>
          <Icon size={21} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dept.name}</div>
          <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>
            {members.length} member{members.length === 1 ? '' : 's'} · {taskCount} task{taskCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: NX.faint, marginBottom: 7 }}>Teammates</div>
        {members.length === 0 ? (
          <div style={{ fontSize: 12.5, color: NX.faint }}>No members yet.</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {shown.map((email) => (
              <span key={email} style={{ marginRight: -6, border: `2px solid ${NX.surface}`, borderRadius: '50%', display: 'inline-flex' }}>
                <Avatar email={email} name={nameOf(email)} size={28} />
              </span>
            ))}
            {extra > 0 && (
              <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 600, color: NX.dim }}>+{extra}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function DeptModal({ dept, onClose, onDelete }) {
  const { createDepartment, updateDepartment } = useTasks();
  const people = usePeople();
  const nameOfLocal = (email) => people.find((p) => p.email === email)?.name || email;

  const [name, setName] = useState(dept?.name || '');
  const [color, setColor] = useState(dept?.color || DEPT_COLORS[0]);
  const [icon, setIcon] = useState(dept?.icon || 'building');
  const [members, setMembers] = useState(dept?.memberIds || []);
  const [saving, setSaving] = useState(false);

  const addMember = (email) => {
    if (!email) return;
    setMembers((m) => (m.includes(email) ? m : [...m, email]));
  };
  const removeMember = (email) => setMembers((m) => m.filter((e) => e !== email));

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const payload = { name: name.trim(), color, icon, memberIds: members };
    try {
      if (dept) await updateDepartment(dept.id, payload);
      else await createDepartment(payload);
      onClose();
    } catch (e) {
      setSaving(false);
      alert('Could not save the team.');
    }
  };

  return (
    <Modal
      title={dept ? 'Edit Team' : 'Create a Team'}
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
            {dept ? 'Save Changes' : 'Create Team'}
          </button>
        </>
      )}
    >
      {/* Name */}
      <label style={labelStyle}>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering" autoFocus style={inputStyle} />

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
            <Avatar email={email} name={nameOfLocal(email)} size={20} />
            <span style={{ color: NX.ink }}>{nameOfLocal(email)}</span>
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

const labelStyle = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

// ── Department detail — Overview / Members / All work / Calendar ─────────────
const DETAIL_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'members', label: 'Members' },
  { key: 'work', label: 'All Work' },
  { key: 'calendar', label: 'Calendar' },
];

function DepartmentDetail({ dept, onBack, onEdit, onNavigate }) {
  const { projects, tasks, nameOf } = useTasks();
  const [tab, setTab] = useState('overview');
  const Icon = deptIcon(dept.icon);
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const inDept = (p) => (p.departmentIds?.length ? p.departmentIds : (p.departmentId ? [p.departmentId] : [])).includes(dept.id);
  const deptProjects = projects.filter(inDept);

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: NX.surface }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 0' }}>
        <button onClick={onBack} title="Back to Teams" style={{ ...btn('ghost'), padding: 6, marginLeft: -6 }}><ArrowLeft size={18} /></button>
        <span style={{ width: 44, height: 44, borderRadius: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${color}1a`, color }}>
          <Icon size={22} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <button onClick={onEdit} style={{ ...btn('ghost'), padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 22, fontWeight: 700, color: NX.ink }} title="Edit Team">
            {dept.name}<ChevronDown size={17} style={{ color: NX.faint }} />
          </button>
          <div style={{ fontSize: 12, color: NX.faint }}>
            {members.length} member{members.length === 1 ? '' : 's'} · {deptProjects.length} project{deptProjects.length === 1 ? '' : 's'}
          </div>
        </div>
        <MemberStack members={members} nameOf={nameOf} />
      </div>

      {/* Tabs */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 14, padding: '0 20px', borderBottom: `1px solid ${NX.border}`, overflowX: 'auto', flexShrink: 0 }}>
        {DETAIL_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            display: 'flex', alignItems: 'center', padding: '10px 12px', whiteSpace: 'nowrap',
            border: 'none', background: 'transparent', cursor: 'pointer',
            borderBottom: `2px solid ${tab === t.key ? NX.primary : 'transparent'}`,
            fontSize: 14, fontWeight: 600, fontFamily: FONT, color: tab === t.key ? NX.ink : NX.dim,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Body */}
      <div className="nx-scroll nx-gutter" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px' }}>
        {tab === 'overview' && <DeptOverviewTab dept={dept} deptProjects={deptProjects} onSeeMembers={() => setTab('members')} onNavigate={onNavigate} />}
        {tab === 'members' && <DeptMembersTab dept={dept} />}
        {tab === 'work' && <DeptWorkTab deptProjects={deptProjects} tasks={tasks} onNavigate={onNavigate} />}
        {tab === 'calendar' && <DeptCalendarTab deptProjects={deptProjects} tasks={tasks} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}

function MemberStack({ members, nameOf }) {
  const shown = members.slice(0, 5);
  const extra = members.length - shown.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {shown.map((email) => (
        <span key={email} style={{ marginLeft: -8, border: `2px solid ${NX.surface}`, borderRadius: '50%', display: 'inline-flex' }}>
          <Avatar email={email} name={nameOf(email)} size={30} />
        </span>
      ))}
      {extra > 0 && (
        <span style={{ marginLeft: 4, width: 30, height: 30, borderRadius: '50%', background: NX.surface2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: NX.dim, border: `2px solid ${NX.surface}` }}>+{extra}</span>
      )}
    </div>
  );
}

function DeptOverviewTab({ dept, deptProjects, onSeeMembers, onNavigate }) {
  const { tasks, nameOf, updateProject, projects } = useTasks();
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const shown = members.slice(0, 8);
  const [assignOpen, setAssignOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const assignRef = useRef(null);
  const addRef = useRef(null);
  useClickOutside(assignRef, () => setAssignOpen(false), assignOpen);
  useClickOutside(addRef, () => setAddOpen(false), addOpen);
  const people = usePeople();
  const teamsOf = (p) => (p.departmentIds?.length ? p.departmentIds : (p.departmentId ? [p.departmentId] : []));
  const otherProjects = projects.filter((p) => !teamsOf(p).includes(dept.id));

  const countFor = (projectId) => tasks.filter((t) => t.projectId === projectId).length;

  return (
    <div>
      {/* Hero banner */}
      <div style={{ height: 112, borderRadius: 16, marginBottom: 20, background: `linear-gradient(120deg, ${color}22, ${color}0a)` }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* Projects */}
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 16, background: NX.surface, padding: 16, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700 }}><LayoutGrid size={16} style={{ color: NX.faint }} /> Projects</div>
            <div ref={assignRef} style={{ position: 'relative' }}>
              <button onClick={() => setAssignOpen((o) => !o)} style={{ ...btn('ghost'), border: `1px dashed ${NX.border}`, padding: '4px 8px', fontSize: 12 }}><PlusIcon size={12} /> Assign project</button>
              {assignOpen && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 240, maxHeight: 260, overflowY: 'auto', background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 60, padding: 4 }}>
                  {otherProjects.length === 0 ? (
                    <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No other projects to assign.</div>
                  ) : otherProjects.map((p) => (
                    <button key={p.id} onClick={() => { updateProject(p.id, { departmentIds: [...teamsOf(p), dept.id] }).catch(() => {}); setAssignOpen(false); }}
                      style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', fontSize: 13 }}>
                      <FolderKanban size={14} style={{ color: NX.faint }} />{p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {deptProjects.length === 0 ? (
            <p style={{ fontSize: 13, color: NX.faint }}>No projects yet. Assign one to give members access.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {deptProjects.map((p) => (
                <button key={p.id} onClick={() => onNavigate && onNavigate({ projectId: p.id })}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 10, padding: '10px 12px', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = NX.primary; e.currentTarget.style.background = NX.hover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = NX.border; e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: NX.surface2, color: NX.faint }}><FolderKanban size={14} /></span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ fontSize: 12, color: NX.faint }}>{countFor(p.id)} task{countFor(p.id) === 1 ? '' : 's'}</span>
                  <ChevronRight size={15} style={{ color: NX.faint }} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Members */}
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 16, background: NX.surface, padding: 16, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Members</div>
            <button onClick={onSeeMembers} style={{ ...btn('ghost'), padding: 0, fontSize: 12, fontWeight: 600, color: NX.primary }}>View all {members.length}</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, position: 'relative' }}>
            {shown.map((email) => <Avatar key={email} email={email} name={nameOf(email)} size={40} />)}
            <span ref={addRef} style={{ position: 'relative' }}>
              <button onClick={() => setAddOpen((o) => !o)} title="Add Member" style={{
                width: 40, height: 40, borderRadius: '50%', border: `1px dashed ${NX.border}`, background: 'transparent',
                color: NX.dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}><PlusIcon size={16} /></button>
              {addOpen && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 220, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 60, padding: 8 }}>
                  <AddMemberInline dept={dept} people={people.filter((p) => !members.includes(p.email))} onDone={() => setAddOpen(false)} />
                </div>
              )}
            </span>
          </div>
          {members.length === 0 && <p style={{ marginTop: 8, fontSize: 12, color: NX.faint }}>No members yet.</p>}
        </div>
      </div>
    </div>
  );
}

function AddMemberInline({ dept, people, onDone }) {
  const { updateDepartment } = useTasks();
  const add = (email) => {
    if (!email) return;
    updateDepartment(dept.id, { memberIds: [...(dept.memberIds || []), email] }).catch(() => {});
    onDone();
  };
  return <PersonSelect value={null} onChange={add} people={people} placeholder="Add member…" />;
}

function DeptMembersTab({ dept }) {
  const { nameOf, updateDepartment } = useTasks();
  const people = usePeople();
  const members = dept.memberIds || [];
  const remove = (email) => { if (confirm(`Remove ${nameOf(email)} from ${dept.name}?`)) updateDepartment(dept.id, { memberIds: members.filter((e) => e !== email) }).catch(() => {}); };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{members.length} member{members.length === 1 ? '' : 's'}</div>
        <div style={{ width: 220 }}><AddMemberInline dept={dept} people={people.filter((p) => !members.includes(p.email))} onDone={() => {}} /></div>
      </div>
      <div style={{ border: `1px solid ${NX.border}`, borderRadius: 16, background: NX.surface, overflow: 'hidden' }}>
        {members.map((email) => (
          <div key={email} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${NX.border2}` }}>
            <Avatar email={email} name={nameOf(email)} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(email)}</div>
              <div style={{ fontSize: 12, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>
            </div>
            <button onClick={() => remove(email)} title="Remove from team" style={{ ...btn('ghost'), padding: '5px 8px', color: NX.dim, fontSize: 12 }}><X size={13} />Remove</button>
          </div>
        ))}
        {members.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: NX.faint }}>No members yet. Add teammates to give them access to this team.</div>}
      </div>
    </div>
  );
}

function DeptWorkTab({ deptProjects, tasks, onNavigate }) {
  const [openIds, setOpenIds] = useState(() => new Set(deptProjects.map((p) => p.id)));
  const toggle = (id) => setOpenIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (deptProjects.length === 0) {
    return <EmptyState icon={FolderKanban} title="No Projects Yet" hint="Assign a project to this team to see its work here." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {deptProjects.map((p) => {
        const projectTasks = topLevel(tasks.filter((t) => t.projectId === p.id));
        const open = openIds.has(p.id);
        return (
          <div key={p.id} style={{ border: `1px solid ${NX.border}`, borderRadius: 14, background: NX.surface, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: open ? `1px solid ${NX.border2}` : 'none' }}>
              <button onClick={() => toggle(p.id)} style={{ ...btn('ghost'), padding: 0, display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, justifyContent: 'flex-start' }}>
                <ChevronRight size={15} style={{ color: NX.faint, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }} />
                <FolderKanban size={14} style={{ color: NX.faint }} />
                <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span style={{ fontSize: 12, color: NX.faint }}>{projectTasks.length} task{projectTasks.length === 1 ? '' : 's'}</span>
              </button>
              <button onClick={() => onNavigate && onNavigate({ projectId: p.id })} style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12, fontWeight: 600, color: NX.primary }}>Open Project</button>
            </div>
            {open && (
              projectTasks.length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: 12, color: NX.faint }}>No tasks in this project.</div>
              ) : (
                <div>
                  {projectTasks.map((t) => {
                    const meta = STATUS_META[t.status] || { label: t.status, color: NX.dim, tint: NX.border2 };
                    return (
                      <div key={t.id} onClick={() => onNavigate && onNavigate({ projectId: p.id })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                        <ListChecks size={14} style={{ color: NX.faint, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: meta.color, background: meta.tint }}>{meta.label}</span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

function DeptCalendarTab({ deptProjects, tasks, onNavigate }) {
  const projectIds = new Set(deptProjects.map((p) => p.id));
  const deptTasks = topLevel(tasks.filter((t) => t.projectId && projectIds.has(t.projectId)));
  return <CalendarView tasks={deptTasks} onOpen={(id) => { const t = tasks.find((x) => x.id === id); if (t) onNavigate && onNavigate({ projectId: t.projectId }); }} />;
}
