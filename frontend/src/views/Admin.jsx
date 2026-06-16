import { useState, useMemo, useEffect } from 'react';
import { Search, Shield, AlertTriangle, Users, CheckCircle, Crown, Plus, X, UserPlus, Pencil, Trash2, Layers } from 'lucide-react';
import { useRole, ROLES, MODULES, MODULE_LEVELS } from '../contexts/RoleContext';
import { useGraphUsers }  from '../hooks/useGraphUsers';
import { useMsal }        from '@azure/msal-react';
import { api }            from '../api';
import { cleanName }      from '../lib/utils';

const ROLE_ORDER = ['owner', 'administrator', 'manager', 'supervisor', 'employee'];

// Phones get a card list + tap-to-edit role sheet instead of the table
// (the role dropdown column sat off-screen on mobile)
function useIsMobileAdmin() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const h = e => setMobile(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return mobile;
}

// ── Permissions matrix data ──────────────────────────────────────────────────
const PERMISSION_MATRIX = [
  {
    section: 'CORE',
    rows: [
      { feature: 'Dashboard',           owner: true, administrator: true, manager: true,  supervisor: true,  employee: true  },
      { feature: 'Manager Dashboard',   owner: true, administrator: true, manager: true,  supervisor: true,  employee: false },
    ],
  },
  {
    section: 'INVENTORY MANAGEMENT',
    rows: [
      { feature: 'View Inventory Catalogue', owner: true, administrator: true, manager: true, supervisor: true,  employee: true  },
      { feature: 'Raise Requests',           owner: true, administrator: true, manager: true, supervisor: true,  employee: true  },
      { feature: 'Request on Behalf',        owner: true, administrator: true, manager: true, supervisor: true,  employee: false },
      { feature: 'Approve / Reject Requests',owner: true, administrator: true, manager: true, supervisor: false, employee: false },
      { feature: 'Allocate Items',           owner: true, administrator: true, manager: true, supervisor: true,  employee: false },
      { feature: 'Return Items',             owner: true, administrator: true, manager: true, supervisor: true,  employee: true  },
      { feature: 'Send Overdue Alerts',      owner: true, administrator: true, manager: true, supervisor: false, employee: false },
    ],
  },
  {
    section: 'IT & INFRASTRUCTURE',
    rows: [
      { feature: 'Network Dashboard',    owner: true,  administrator: true,  manager: true,   supervisor: false, employee: false },
      { feature: 'Asset Management',     owner: true,  administrator: true,  manager: true,   supervisor: 'View',employee: false },
      { feature: 'Website Management',   owner: true,  administrator: true,  manager: true,   supervisor: false, employee: false },
      { feature: 'Nexus Access Manager', owner: true,  administrator: true,  manager: false,  supervisor: false, employee: false },
    ],
  },
  {
    section: 'FINANCE',
    rows: [
      { feature: 'Purchase Requisition', owner: true, administrator: true, manager: true,  supervisor: true,  employee: 'Own' },
      { feature: 'Accounting',           owner: true, administrator: true, manager: true,  supervisor: false, employee: false },
      { feature: 'Investor Relations',   owner: true, administrator: true, manager: false, supervisor: false, employee: false },
    ],
  },
  {
    section: 'OPERATIONS',
    rows: [
      { feature: 'Construction',  owner: true, administrator: true, manager: true, supervisor: true,  employee: false },
      { feature: 'Operations',    owner: true, administrator: true, manager: true, supervisor: true,  employee: false },
      { feature: 'Development',   owner: true, administrator: true, manager: true, supervisor: false, employee: false },
      { feature: 'HR',            owner: true, administrator: true, manager: true, supervisor: false, employee: false },
      { feature: 'Marketing',     owner: true, administrator: true, manager: true, supervisor: false, employee: false },
    ],
  },
  {
    section: 'GENERAL ACCESS',
    rows: [
      { feature: 'Knowledge Base',  owner: true, administrator: true, manager: true, supervisor: true, employee: true },
      { feature: 'Tasks',           owner: true, administrator: true, manager: true, supervisor: true, employee: true },
      { feature: 'Support',         owner: true, administrator: true, manager: true, supervisor: true, employee: true },
      { feature: 'External Links',  owner: true, administrator: true, manager: true, supervisor: true, employee: true },
    ],
  },
  {
    section: 'SYSTEM SETTINGS',
    rows: [
      { feature: 'Add Users',                owner: true,  administrator: true,     manager: false, supervisor: false, employee: false },
      { feature: 'Assign Roles',             owner: true,  administrator: 'Up to Manager', manager: false, supervisor: false, employee: false },
      { feature: 'Manage Other Admins',      owner: true,  administrator: false,    manager: false, supervisor: false, employee: false },
      { feature: 'Send Notifications',       owner: true,  administrator: true,     manager: true,  supervisor: true,  employee: false },
      { feature: 'View Audit Logs',          owner: true,  administrator: true,     manager: false, supervisor: false, employee: false },
      { feature: 'Permanently Delete Records', owner: true, administrator: false,   manager: false, supervisor: false, employee: false },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function RoleBadge({ role, size = 'sm' }) {
  const meta = ROLES[role] ?? ROLES.employee;
  const pad  = size === 'sm' ? '2px 9px' : '4px 12px';
  const fs   = size === 'sm' ? 11 : 12.5;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: pad, borderRadius: 20, fontSize: fs, fontWeight: 700,
      background: meta.bg, color: `hsl(${meta.color})`, whiteSpace: 'nowrap',
    }}>
      {role === 'owner' && <Crown size={10} />}
      {meta.label}
    </span>
  );
}

function CellValue({ val }) {
  if (val === true)    return <span style={{ fontSize: 15, color: 'hsl(var(--color-green))' }}>✓</span>;
  if (val === false)   return <span style={{ fontSize: 15, color: 'var(--line)', userSelect: 'none' }}>✗</span>;
  if (val === 'View')  return <span style={{ fontSize: 11, fontWeight: 600, color: 'hsl(var(--color-blue))' }}>View</span>;
  if (val === 'Own')   return <span style={{ fontSize: 11, fontWeight: 600, color: 'hsl(var(--color-orange))' }}>Own</span>;
  return null;
}

function PermissionMissing() {
  return (
    <div style={{ border: '1px solid hsla(var(--color-orange),0.3)', background: 'hsla(var(--color-orange),0.06)', borderRadius: 14, padding: '28px 32px', marginTop: 24 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <AlertTriangle size={22} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0, marginTop: 2 }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Graph API permission required</div>
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.7, margin: 0 }}>
            To fetch real employee data from Microsoft 365, add <code style={{ background: 'var(--mist)', padding: '1px 6px', borderRadius: 4 }}>User.ReadBasic.All</code> to your Azure AD app registration and grant admin consent.
          </p>
          <ol style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 2, marginTop: 10, paddingLeft: 18 }}>
            <li>Go to <strong>Azure Portal → Azure Active Directory → App Registrations → Greens Nexus</strong></li>
            <li>API Permissions → Add a permission → Microsoft Graph → Delegated → <code>User.ReadBasic.All</code></li>
            <li>Click <strong>Grant admin consent</strong></li>
            <li>Reload this page</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

// ── Add User Modal ────────────────────────────────────────────────────────────
function AddUserModal({ onClose, onAdd, saving }) {
  const [name,  setName]  = useState('');
  const [email, setEmail] = useState('');
  const [dept,  setDept]  = useState('');
  const [title, setTitle] = useState('');
  const [role,  setRole]  = useState('employee');

  const valid = name.trim() && email.trim() && email.includes('@');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Add User</h3>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>Manually add a user and assign their Nexus role</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em' }}>FULL NAME *</label>
            <input className="form-input" style={{ width: '100%' }} placeholder="e.g. John Smith"
              value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em' }}>EMAIL ADDRESS *</label>
            <input className="form-input" style={{ width: '100%' }} placeholder="e.g. john@greensglobal.com" type="email"
              value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em' }}>DEPARTMENT</label>
            <input className="form-input" style={{ width: '100%' }} placeholder="e.g. IT"
              value={dept} onChange={e => setDept(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em' }}>JOB TITLE</label>
            <input className="form-input" style={{ width: '100%' }} placeholder="e.g. Engineer"
              value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em' }}>NEXUS ROLE</label>
            <select className="form-input" style={{ width: '100%' }} value={role} onChange={e => setRole(e.target.value)}>
              {ROLE_ORDER.map(r => <option key={r} value={r}>{ROLES[r].label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn"
            disabled={!valid || saving}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => onAdd({ name: name.trim(), email: email.trim().toLowerCase(), dept: dept.trim() || '—', title: title.trim() || '—', role })}>
            {saving ? 'Adding…' : <><UserPlus size={14} /> Add User</>}
          </button>
        </div>
      </div>
    </div>
  );
}

const FIELD_LABEL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em' };
const ICON_BTN    = { background: 'none', border: '1px solid var(--line)', borderRadius: 8, width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--muted)' };

// ── Create / Edit Group modal ─────────────────────────────────────────────────
function GroupModal({ group, allUsers, assignableRoles, ROLES, onClose, onSave, onAssignRole, saving }) {
  const isEdit = !!group;
  const [name,         setName]         = useState(group?.name ?? '');
  const [department,   setDepartment]   = useState(group?.department ?? '');
  // Map<moduleId, level> — each granted screen carries an explicit permission
  // level (Viewer/Editor/Full/Owner), decided together as one choice, mirroring
  // a folder-permission row rather than a bare on/off checkbox.
  const [modules,      setModules]      = useState(() => new Map((group?.allowed_modules ?? []).map(m => [m.id, m.level || 'viewer'])));
  const [members,      setMembers]      = useState(() => group?.members ?? []);
  const [memberSearch, setMemberSearch] = useState('');
  const [bulkRole,     setBulkRole]     = useState(() => assignableRoles()[0] ?? 'employee');
  const [bulkResult,   setBulkResult]   = useState(null);
  const [bulkSaving,   setBulkSaving]   = useState(false);

  const valid = name.trim().length > 0;

  function toggleModule(id) {
    setModules(prev => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, 'viewer');
      return next;
    });
  }

  function setModuleLevel(id, level) {
    setModules(prev => new Map(prev).set(id, level));
  }

  const memberSet = useMemo(() => new Set(members), [members]);
  const candidates = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return [];
    return allUsers.filter(u => !memberSet.has(u.email) &&
      (u.name.toLowerCase().includes(q) || u.email.includes(q))).slice(0, 8);
  }, [allUsers, memberSearch, memberSet]);

  const memberDetails = useMemo(() =>
    members.map(email => allUsers.find(u => u.email === email) ?? { email, name: email }),
    [members, allUsers]);

  async function handleApplyBulkRole() {
    setBulkSaving(true);
    setBulkResult(null);
    try {
      setBulkResult(await onAssignRole(group.id, bulkRole));
    } catch (err) {
      setBulkResult({ error: err.message ?? 'Failed to assign role — please try again' });
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: '100%', maxWidth: 660, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{isEdit ? `Edit ${group.name}` : 'Create Group'}</h3>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>Organize people, grant screen access, and manage roles together</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Name + department */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
          <div>
            <label style={FIELD_LABEL}>GROUP NAME *</label>
            <input className="form-input" style={{ width: '100%' }} placeholder="e.g. Accounting"
              value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={FIELD_LABEL}>DEPARTMENT</label>
            <input className="form-input" style={{ width: '100%' }} placeholder="optional, e.g. Finance"
              value={department} onChange={e => setDepartment(e.target.value)} />
          </div>
        </div>

        {/* Members */}
        <div style={{ marginBottom: 20 }}>
          <label style={FIELD_LABEL}>MEMBERS ({members.length})</label>
          <div className="search-bar" style={{ marginBottom: 8 }}>
            <Search size={14} style={{ flexShrink: 0 }} />
            <input placeholder="Search people by name or email to add…" value={memberSearch} onChange={e => setMemberSearch(e.target.value)} />
          </div>
          {candidates.length > 0 && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
              {candidates.map(u => (
                <button key={u.email} type="button"
                  onClick={() => { setMembers(p => [...p, u.email]); setMemberSearch(''); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '8px 12px', background: 'none', border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter, sans-serif' }}>
                  <span style={{ fontSize: 13 }}>{u.name} <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>· {u.email}</span></span>
                  <Plus size={13} style={{ color: 'var(--muted)' }} />
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {memberDetails.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No members yet — search above to add people.</span>}
            {memberDetails.map(u => (
              <span key={u.email} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 12px', borderRadius: 20, background: 'var(--mist)', fontSize: 12.5 }}>
                {u.name}
                <button type="button" onClick={() => setMembers(p => p.filter(e => e !== u.email))}
                  style={{ display: 'inline-flex', background: 'var(--card)', border: 'none', borderRadius: '50%', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--muted)' }}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Module access */}
        <div style={{ marginBottom: 20 }}>
          <label style={FIELD_LABEL}>SCREENS &amp; PERMISSION LEVELS</label>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
            Granting a screen also sets what members can <em>do</em> there — visibility and capability are decided together, like a folder-permission entry. This is additive on top of whatever a member's individual role already grants, and can never take access away.
            {' '}<strong>Viewer</strong> {MODULE_LEVELS.viewer.description.toLowerCase()} · <strong>Editor</strong> {MODULE_LEVELS.editor.description.toLowerCase()} · <strong>Full</strong> {MODULE_LEVELS.full.description.toLowerCase()} · <strong>Owner</strong> {MODULE_LEVELS.owner.description.toLowerCase()}.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
            {MODULES.map(m => {
              const granted = modules.has(m.id);
              const level   = modules.get(m.id) ?? 'viewer';
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={granted} onChange={() => toggleModule(m.id)} />
                    {m.label}
                  </label>
                  {granted && (
                    <select className="form-input" style={{ fontSize: 12, padding: '3px 8px', minWidth: 90 }}
                      value={level} onChange={e => setModuleLevel(m.id, e.target.value)}
                      title={MODULE_LEVELS[level]?.description}>
                      {Object.entries(MODULE_LEVELS).map(([key, lvl]) => (
                        <option key={key} value={key}>{lvl.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bulk role assignment — only meaningful once the group exists */}
        {isEdit && (
          <div style={{ marginBottom: 20, border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
            <label style={FIELD_LABEL}>BULK ROLE ASSIGNMENT</label>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>
              Assign one role to every member of this group at once — the same delegation rules apply as assigning roles individually.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="form-input" style={{ minWidth: 160 }} value={bulkRole} onChange={e => setBulkRole(e.target.value)}>
                {assignableRoles().map(r => <option key={r} value={r}>{ROLES[r].label}</option>)}
              </select>
              <button className="primary-btn" disabled={!members.length || bulkSaving} onClick={handleApplyBulkRole}>
                {bulkSaving ? 'Applying…' : `Apply to ${members.length} member${members.length !== 1 ? 's' : ''}`}
              </button>
            </div>
            {bulkResult && (
              <div style={{ marginTop: 10, fontSize: 12.5 }}>
                {bulkResult.error ? (
                  <span style={{ color: 'var(--color-red, #f87171)' }}>{bulkResult.error}</span>
                ) : (
                  <>
                    {bulkResult.updated?.length > 0 && (
                      <div style={{ color: 'hsl(var(--color-green))', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CheckCircle size={13} /> Updated {bulkResult.updated.length} member{bulkResult.updated.length !== 1 ? 's' : ''} to {ROLES[bulkRole]?.label}
                      </div>
                    )}
                    {bulkResult.skipped?.length > 0 && (
                      <div style={{ color: 'var(--color-orange, #fb923c)', marginTop: 4 }}>
                        Skipped {bulkResult.skipped.length}: {bulkResult.skipped.map(s => s.email).join(', ')} — {bulkResult.skipped[0].reason}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn"
            disabled={!valid || saving}
            onClick={() => onSave({ name: name.trim(), department: department.trim(), allowed_modules: [...modules].map(([id, level]) => ({ id, level })), members })}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Admin() {
  const {
    myRole, myEmail, getRole, assignRole, refreshAllRoles, can,
    groups, refreshGroups, createGroup, updateGroup, deleteGroup,
    addGroupMembers, removeGroupMember, assignGroupRole,
  } = useRole();
  const { users, loading: graphLoading, error } = useGraphUsers();
  const { accounts } = useMsal();
  const myEmail2 = accounts[0]?.username?.toLowerCase() ?? '';

  const [search,       setSearch]       = useState('');
  const [filter,       setFilter]       = useState('all');
  const [saved,        setSaved]        = useState({});
  const [saving,       setSaving]       = useState({});
  const [activeTab,    setActiveTab]    = useState('users');
  const [showAddUser,  setShowAddUser]  = useState(false);
  const [addingSaving, setAddingSaving] = useState(false);
  const [manualUsers,  setManualUsers]  = useState([]);
  const [roleError,    setRoleError]    = useState('');

  const [editingGroup, setEditingGroup] = useState(null);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupSaving,  setGroupSaving]  = useState(false);
  const [groupError,   setGroupError]   = useState('');
  const isMobile = useIsMobileAdmin();
  const [roleSheetUser, setRoleSheetUser] = useState(null); // phone: tap a user → role sheet

  const loading = graphLoading;

  useEffect(() => { refreshAllRoles(); }, [refreshAllRoles]);
  useEffect(() => { refreshGroups(); }, [refreshGroups]);

  useEffect(() => {
    if (!graphLoading && users.length > 0) {
      const emails = users.map(u => (u.mail ?? u.userPrincipalName ?? '').toLowerCase()).filter(Boolean);
      if (emails.length) api.syncRoles(emails).catch(() => {});
    }
  }, [graphLoading, users]);

  const isOwner  = myRole === 'owner';
  const isAdmin  = can('administrator');
  const myLevel  = ROLES[myRole]?.level ?? 1;

  // IT Admins may delegate access only "down" (strictly below their own level)
  // and can't touch anyone who's already an admin — only Global Admin can
  // create, edit, or demote other admins. Mirrors the backend check in
  // routers/roles.py so the UI doesn't offer choices that'll just 403.
  function canEditRoleOf(targetRole) {
    if (isOwner) return true;
    return (ROLES[targetRole]?.level ?? 1) < ROLES.administrator.level;
  }
  function assignableRoles() {
    if (isOwner) return ROLE_ORDER;
    return ROLE_ORDER.filter(r => (ROLES[r]?.level ?? 1) < myLevel);
  }

  async function handleAssign(email, role, displayName) {
    setRoleError('');
    setSaving(p => ({ ...p, [email]: true }));
    try {
      await assignRole(email, role, displayName);
      setSaved(p => ({ ...p, [email]: true }));
      setTimeout(() => setSaved(p => { const n = {...p}; delete n[email]; return n; }), 1800);
    } catch (err) {
      setRoleError(err.message ?? 'Failed to update role — please try again');
      setTimeout(() => setRoleError(''), 4000);
    } finally {
      setSaving(p => { const n = {...p}; delete n[email]; return n; });
    }
  }

  async function handleAddUser({ name, email, dept, title, role }) {
    setAddingSaving(true);
    setRoleError('');
    try {
      await assignRole(email, role, name);
      setManualUsers(p => {
        if (p.some(u => u.email === email)) return p.map(u => u.email === email ? { ...u, name, dept, title, role } : u);
        return [...p, { id: email, name, email, dept, title, role }];
      });
      setShowAddUser(false);
    } catch (err) {
      setRoleError(err.message ?? 'Failed to add user — please try again');
      setTimeout(() => setRoleError(''), 4000);
    } finally {
      setAddingSaving(false);
    }
  }

  async function handleSaveGroup({ name, department, allowed_modules, members }) {
    setGroupSaving(true);
    setGroupError('');
    try {
      if (editingGroup) {
        await updateGroup(editingGroup.id, { name, department, allowed_modules });
        const before  = new Set(editingGroup.members);
        const after   = new Set(members);
        const toAdd   = members.filter(e => !before.has(e));
        const toDrop  = editingGroup.members.filter(e => !after.has(e));
        if (toAdd.length) await addGroupMembers(editingGroup.id, toAdd);
        for (const email of toDrop) await removeGroupMember(editingGroup.id, email);
      } else {
        await createGroup({ name, department, allowed_modules, member_emails: members });
      }
      setShowGroupModal(false);
      setEditingGroup(null);
    } catch (err) {
      setGroupError(err.message ?? 'Failed to save group — please try again');
      setTimeout(() => setGroupError(''), 4000);
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleDeleteGroup(group) {
    if (!window.confirm(`Delete "${group.name}"? Members will lose any screen access granted by this group. This can't be undone.`)) return;
    try {
      await deleteGroup(group.id);
    } catch (err) {
      setGroupError(err.message ?? 'Failed to delete group — please try again');
      setTimeout(() => setGroupError(''), 4000);
    }
  }

  const graphEmails = new Set(users.map(u => (u.mail ?? u.userPrincipalName ?? '').toLowerCase()));

  const displayUsers = useMemo(() => {
    const fromGraph = users.map(u => ({
      id:    u.id,
      name:  cleanName(u.displayName),
      email: (u.mail ?? u.userPrincipalName ?? '').toLowerCase(),
      title: u.jobTitle   ?? '—',
      dept:  u.department ?? '—',
      role:  getRole(u.mail ?? u.userPrincipalName ?? ''),
    }));
    // Include manually added users not in Graph
    const fromManual = manualUsers
      .filter(u => !graphEmails.has(u.email))
      .map(u => ({ ...u, name: cleanName(u.name || ''), role: getRole(u.email) }));
    const combined = [...fromGraph, ...fromManual];

    return combined.filter(u => {
      const q = search.toLowerCase();
      const matchSearch = !q || u.name.toLowerCase().includes(q) || u.email.includes(q) || u.dept.toLowerCase().includes(q);
      const matchFilter = filter === 'all' || u.role === filter;
      return matchSearch && matchFilter;
    });
  }, [users, manualUsers, graphEmails, search, filter, getRole]);

  const counts = useMemo(() => {
    const c = {};
    ROLE_ORDER.forEach(r => { c[r] = 0; });
    [...users, ...manualUsers.filter(u => !graphEmails.has(u.email))].forEach(u => {
      const r = getRole(u.mail ?? u.userPrincipalName ?? u.email ?? '');
      c[r] = (c[r] ?? 0) + 1;
    });
    return c;
  }, [users, manualUsers, graphEmails, getRole]);

  const initials = name => name?.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase() ?? '?';

  const tabs = [
    { id: 'users',  label: 'Users & Roles' },
    { id: 'matrix', label: 'Permissions Matrix' },
    { id: 'groups', label: 'Groups' },
  ];

  if (!isAdmin) {
    return (
      <div className="view-header">
        <div className="view-title-group">
          <h2>Administration</h2>
          <p>You need Administrator or Owner access to view this section.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Administration</h2>
          <p>Manage Nexus users, roles, and system permissions</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RoleBadge role={myRole} size="md" />
        </div>
      </div>

      {roleError && (
        <div style={{ background: 'hsla(0,80%,50%,0.12)', border: '1px solid hsla(0,80%,50%,0.3)', color: 'var(--color-red, #f87171)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 }}>
          {roleError}
        </div>
      )}

      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={activeTab === t.id ? 'tab-pill active' : 'tab-pill'}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Users & Roles ──────────────────────────────────────────────────── */}
      {activeTab === 'users' && (
        <>
          {/* KPI row */}
          <div className="role-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
            {ROLE_ORDER.map(role => {
              const meta = ROLES[role];
              return (
                <div key={role}
                  style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', cursor: 'pointer', transition: 'border-color .15s', borderTopWidth: 3, borderTopColor: `hsl(${meta.color})` }}
                  onClick={() => setFilter(f => f === role ? 'all' : role)}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: `hsl(${meta.color})`, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>{meta.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--ink)' }}>{counts[role] ?? 0}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{meta.description.split(',')[0]}</div>
                </div>
              );
            })}
          </div>

          {/* Search + filter + Add User */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="search-bar" style={{ width: 280 }}>
              <Search size={14} style={{ flexShrink: 0 }} />
              <input placeholder="Search by name, email or department…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {filter !== 'all' && (
              <button onClick={() => setFilter('all')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 12, color: 'var(--muted)', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                Filtering: <RoleBadge role={filter} /> × Clear
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--muted)' }}>
              {loading ? 'Loading…' : `${displayUsers.length} user${displayUsers.length !== 1 ? 's' : ''}`}
            </span>
            <button className="primary-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              onClick={() => setShowAddUser(true)}>
              <Plus size={14} /> Add User
            </button>
          </div>

          {error?.includes('permission_denied') && <PermissionMissing />}

          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[1,2,3,4,5].map(i => (
                <div key={i} style={{ height: 56, background: 'var(--mist)', borderRadius: 10, opacity: 1 - i * 0.12, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          )}

          {!loading && !error?.includes('permission_denied') && (
            <>
              {displayUsers.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '56px 0', color: 'var(--muted)', fontSize: 14 }}>
                  <Users size={32} style={{ opacity: .2, display: 'block', margin: '0 auto 10px' }} />
                  {error
                    ? 'Couldn\'t load users from Microsoft 365 — please refresh to try again.'
                    : users.length === 0 ? 'No users loaded from Microsoft 365 yet.' : 'No users match your filter.'}
                </div>
              ) : isMobile ? (
                /* Phone: cards + tap-to-edit role sheet — the table's role
                   dropdown column sat off-screen on mobile */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {displayUsers.map(u => {
                    const isMe = u.email === myEmail2;
                    const editable = canEditRoleOf(u.role);
                    return (
                      <button key={u.id ?? u.email}
                        onClick={() => editable && setRoleSheetUser(u)}
                        title={!editable ? "Only a Global Admin can manage another admin's access" : undefined}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', cursor: editable ? 'pointer' : 'default', textAlign: 'left', fontFamily: 'Inter,sans-serif', width: '100%', opacity: editable ? 1 : 0.65 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--pine)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                          {initials(u.name)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.name}{isMe && <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--mist)', color: 'var(--muted)', padding: '1px 6px', borderRadius: 4, marginLeft: 6 }}>You</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                        </div>
                        {saved[u.email]
                          ? <CheckCircle size={15} color="hsl(var(--color-green))" style={{ flexShrink: 0 }} />
                          : <RoleBadge role={u.role} />}
                      </button>
                    );
                  })}
                  {/* Role sheet — global mobile CSS renders this as a bottom sheet */}
                  {roleSheetUser && (
                    <div role="dialog" aria-modal="true"
                      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                      onClick={e => e.target === e.currentTarget && setRoleSheetUser(null)}>
                      <div style={{ background: 'var(--card)', borderRadius: 14, padding: 22, width: '100%', maxWidth: 420 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{roleSheetUser.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{roleSheetUser.email}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {assignableRoles().map(r => (
                            <button key={r} disabled={saving[roleSheetUser.email]}
                              onClick={() => { handleAssign(roleSheetUser.email, r, roleSheetUser.name); setRoleSheetUser(null); }}
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 15px', borderRadius: 10, border: `1.5px solid ${roleSheetUser.role === r ? 'var(--pine)' : 'var(--line)'}`, background: roleSheetUser.role === r ? 'var(--mist)' : 'var(--card)', fontFamily: 'Inter,sans-serif', fontSize: 14, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' }}>
                              <span>{ROLES[r].label}</span>
                              {roleSheetUser.role === r && <CheckCircle size={15} color="hsl(var(--color-green))" />}
                            </button>
                          ))}
                        </div>
                        <button className="secondary-btn" style={{ width: '100%', marginTop: 12 }} onClick={() => setRoleSheetUser(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
                  <table className="req-table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Department</th>
                        <th>Job Title</th>
                        <th>Nexus Role</th>
                        <th>Assign Role</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayUsers.map(u => {
                        const isMe = u.email === myEmail2;
                        return (
                          <tr key={u.id ?? u.email}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--pine)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                                  {initials(u.name)}
                                </div>
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {u.name}
                                    {isMe && <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--mist)', color: 'var(--muted)', padding: '1px 6px', borderRadius: 4 }}>You</span>}
                                  </div>
                                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{u.email}</div>
                                </div>
                              </div>
                            </td>
                            <td style={{ color: 'var(--muted)', fontSize: 13 }}>{u.dept}</td>
                            <td style={{ color: 'var(--muted)', fontSize: 13 }}>{u.title}</td>
                            <td><RoleBadge role={u.role} /></td>
                            <td>
                              <select
                                value={u.role}
                                disabled={saving[u.email] || !canEditRoleOf(u.role)}
                                title={!canEditRoleOf(u.role) ? "Only a Global Admin can manage another admin's access" : undefined}
                                onChange={e => handleAssign(u.email, e.target.value, u.name)}
                                className="form-input"
                                style={{ padding: '5px 10px', fontSize: 12.5, height: 32, minWidth: 140 }}>
                                {assignableRoles().includes(u.role)
                                  ? null
                                  : <option value={u.role}>{ROLES[u.role]?.label ?? u.role}</option>}
                                {assignableRoles().map(r => (
                                  <option key={r} value={r}>{ROLES[r].label}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ width: 70 }}>
                              {saved[u.email] && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'hsl(var(--color-green))', fontWeight: 600 }}>
                                  <CheckCircle size={13} /> Saved
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Permissions Matrix ─────────────────────────────────────────────── */}
      {activeTab === 'matrix' && (
        <>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>
            Define exactly what each role can see and do across every portal.
          </p>

          {/* Role-matrix is a true grid (roles as columns) — cards don't fit,
              so it scrolls sideways on phones instead */}
          <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflowX: 'auto', overflowY: 'hidden', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--mist)', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '11px 16px', textAlign: 'left', fontWeight: 700, fontSize: 11.5, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase', width: '32%', minWidth: 160 }}>
                    Feature / Portal
                  </th>
                  {ROLE_ORDER.map(role => {
                    const meta = ROLES[role];
                    return (
                      <th key={role} style={{ padding: '11px 10px', textAlign: 'center', fontWeight: 700, fontSize: 11.5, color: `hsl(${meta.color})`, letterSpacing: '.04em', textTransform: 'uppercase', minWidth: 110 }}>
                        {role === 'owner' && <Crown size={10} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />}
                        {meta.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_MATRIX.map(({ section, rows }) => (
                  <>
                    {/* Section header */}
                    <tr key={`sec-${section}`} style={{ background: 'var(--paper)' }}>
                      <td colSpan={6} style={{ padding: '7px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--muted)', textTransform: 'uppercase' }}>
                        {section}
                      </td>
                    </tr>
                    {rows.map((row, i) => (
                      <tr key={row.feature}
                        style={{ borderBottom: '1px solid var(--line)', background: i % 2 === 1 ? 'hsla(0,0%,50%,0.025)' : 'transparent' }}>
                        <td style={{ padding: '10px 16px', fontWeight: 500, fontSize: 13, color: 'var(--ink)' }}>{row.feature}</td>
                        {ROLE_ORDER.map(role => (
                          <td key={role} style={{ padding: '10px', textAlign: 'center' }}>
                            <CellValue val={row[role]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 20, marginTop: 16, flexWrap: 'wrap' }}>
            {[
              { val: true,   label: 'Full access' },
              { val: false,  label: 'No access' },
              { val: 'View', label: 'View only' },
              { val: 'Own',  label: 'Own data only' },
            ].map(({ val, label }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
                <CellValue val={val} />
                {label}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Groups ─────────────────────────────────────────────────────────── */}
      {activeTab === 'groups' && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, maxWidth: 560 }}>
              Organize people into teams, grant them extra screens to see, and manage their roles together. Group access is additive — it only ever adds to what someone's role already allows.
            </p>
            <button className="primary-btn" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7 }}
              onClick={() => { setEditingGroup(null); setShowGroupModal(true); }}>
              <Plus size={14} /> Create Group
            </button>
          </div>

          {groupError && (
            <div style={{ background: 'hsla(0,80%,50%,0.12)', border: '1px solid hsla(0,80%,50%,0.3)', color: 'var(--color-red, #f87171)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 }}>
              {groupError}
            </div>
          )}

          {groups.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '56px 0', color: 'var(--muted)', fontSize: 14 }}>
              <Layers size={32} style={{ opacity: .2, display: 'block', margin: '0 auto 10px' }} />
              No groups yet — create one to organize people and manage their access together.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
              {groups.map(g => (
                <div key={g.id} style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{g.name}</div>
                      {g.department && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{g.department}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => { setEditingGroup(g); setShowGroupModal(true); }} title="Edit group" style={ICON_BTN}><Pencil size={14} /></button>
                      <button onClick={() => handleDeleteGroup(g)} title="Delete group" style={ICON_BTN}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>
                    <Users size={13} /> {g.members.length} member{g.members.length !== 1 ? 's' : ''}
                  </div>
                  {g.allowed_modules.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                      {g.allowed_modules.map(({ id, level }) => (
                        <span key={id} title={MODULE_LEVELS[level]?.description}
                          style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 20, background: 'hsla(var(--color-blue),0.12)', color: 'hsl(var(--color-blue))' }}>
                          {MODULES.find(m => m.id === id)?.label ?? id} · {MODULE_LEVELS[level]?.label ?? level}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {showAddUser && (
        <AddUserModal
          saving={addingSaving}
          onClose={() => setShowAddUser(false)}
          onAdd={handleAddUser}
        />
      )}

      {showGroupModal && (
        <GroupModal
          group={editingGroup}
          allUsers={displayUsers}
          assignableRoles={assignableRoles}
          ROLES={ROLES}
          saving={groupSaving}
          onClose={() => { setShowGroupModal(false); setEditingGroup(null); }}
          onSave={handleSaveGroup}
          onAssignRole={assignGroupRole}
        />
      )}
    </div>
  );
}
