// Task Module — Teams / Departments. Grid of department cards + add/edit modal
// (name, color, icon, members) + a member-request inbox for admins. Ported from
// the export's TeamsPage / DepartmentDetail, restyled to the Nexus inline idiom.
import { useMemo, useState } from 'react';
import {
  Users, Plus, X, Trash2, Check, Clock, UserPlus,
  Building2, Cpu, HardHat, Cog, Code2, Calculator, Megaphone, Briefcase,
  Wrench, FlaskConical, ShieldCheck, Rocket, PenTool, Landmark, Truck,
  Headphones, HeartPulse,
} from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { Avatar, EmptyState, Modal, usePeople, PersonSelect } from './components';
import { useTasks } from './TasksContext';

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

export default function TeamsView() {
  const { departments, memberRequests, tasks, nameOf, deptName, deleteDepartment, decideMemberRequest } = useTasks();
  const [editing, setEditing] = useState(null); // dept object, or {} for new, or null

  const taskCountByDept = useMemo(() => {
    const m = {};
    for (const t of tasks) if (t.departmentId) m[t.departmentId] = (m[t.departmentId] || 0) + 1;
    return m;
  }, [tasks]);

  const pending = useMemo(
    () => memberRequests.filter((r) => (r.status || 'pending') === 'pending'),
    [memberRequests],
  );

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
                      <button onClick={() => decideMemberRequest(r.id, 'approved').catch(() => window.alert('You do not have permission to decide member requests.'))}
                        style={{ ...btn('ghost'), color: NX.green, background: '#e3f5ea', padding: '6px 10px' }}>
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
          <EmptyState icon={Users} title="No departments yet" hint="Create a department to group members and their work." />
        ) : (
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {departments.map((d) => (
              <DeptCard key={d.id} dept={d} nameOf={nameOf} taskCount={taskCountByDept[d.id] || 0} onEdit={() => setEditing(d)} />
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

function DeptCard({ dept, nameOf, taskCount, onEdit }) {
  const Icon = deptIcon(dept.icon);
  const color = dept.color || NX.blue;
  const members = dept.memberIds || [];
  const shown = members.slice(0, 6);
  const extra = members.length - shown.length;
  return (
    <div onClick={onEdit} style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 14, padding: 16, cursor: 'pointer', transition: 'border-color 0.13s' }}
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

function DeptModal({ dept, onClose, onDelete }) {
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
      alert('Could not save the department.');
    }
  };

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
