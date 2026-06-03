import { useState, useMemo, useEffect } from 'react';
import { Search, Shield, AlertTriangle, Users, CheckCircle, Crown, Plus, X, UserPlus } from 'lucide-react';
import { useRole, ROLES } from '../contexts/RoleContext';
import { useGraphUsers }  from '../hooks/useGraphUsers';
import { useMsal }        from '@azure/msal-react';
import { api }            from '../api';

const ROLE_ORDER = ['owner', 'administrator', 'manager', 'supervisor', 'employee'];

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
      { feature: 'Add / Remove Users', owner: true,  administrator: true,  manager: false, supervisor: false, employee: false },
      { feature: 'Assign Roles',       owner: true,  administrator: false, manager: false, supervisor: false, employee: false },
      { feature: 'Send Notifications', owner: true,  administrator: true,  manager: true,  supervisor: true,  employee: false },
      { feature: 'View Audit Logs',    owner: true,  administrator: true,  manager: false, supervisor: false, employee: false },
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

// ── Main component ────────────────────────────────────────────────────────────
export default function Admin() {
  const { myRole, myEmail, getRole, assignRole, refreshAllRoles, can } = useRole();
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

  const loading = graphLoading;

  useEffect(() => { refreshAllRoles(); }, [refreshAllRoles]);

  useEffect(() => {
    if (!graphLoading && users.length > 0) {
      const emails = users.map(u => (u.mail ?? u.userPrincipalName ?? '').toLowerCase()).filter(Boolean);
      if (emails.length) api.syncRoles(emails).catch(() => {});
    }
  }, [graphLoading, users]);

  const isOwner = myRole === 'owner';
  const isAdmin = can('administrator');

  async function handleAssign(email, role) {
    setSaving(p => ({ ...p, [email]: true }));
    try {
      await assignRole(email, role);
      setSaved(p => ({ ...p, [email]: true }));
      setTimeout(() => setSaved(p => { const n = {...p}; delete n[email]; return n; }), 1800);
    } catch (err) {
      alert(err.message ?? 'Failed to update role');
    } finally {
      setSaving(p => { const n = {...p}; delete n[email]; return n; });
    }
  }

  async function handleAddUser({ name, email, dept, title, role }) {
    setAddingSaving(true);
    try {
      await assignRole(email, role);
      setManualUsers(p => {
        if (p.some(u => u.email === email)) return p.map(u => u.email === email ? { ...u, name, dept, title, role } : u);
        return [...p, { id: email, name, email, dept, title, role }];
      });
      setShowAddUser(false);
    } catch (err) {
      alert(err.message ?? 'Failed to add user');
    } finally {
      setAddingSaving(false);
    }
  }

  const graphEmails = new Set(users.map(u => (u.mail ?? u.userPrincipalName ?? '').toLowerCase()));

  const displayUsers = useMemo(() => {
    const fromGraph = users.map(u => ({
      id:    u.id,
      name:  u.displayName,
      email: (u.mail ?? u.userPrincipalName ?? '').toLowerCase(),
      title: u.jobTitle   ?? '—',
      dept:  u.department ?? '—',
      role:  getRole(u.mail ?? u.userPrincipalName ?? ''),
    }));
    // Include manually added users not in Graph
    const fromManual = manualUsers
      .filter(u => !graphEmails.has(u.email))
      .map(u => ({ ...u, role: getRole(u.email) }));
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
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
                  {users.length === 0 ? 'No users loaded from Microsoft 365 yet.' : 'No users match your filter.'}
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
                                disabled={saving[u.email] || (!isOwner && u.role === 'owner')}
                                onChange={e => handleAssign(u.email, e.target.value)}
                                className="form-input"
                                style={{ padding: '5px 10px', fontSize: 12.5, height: 32, minWidth: 140 }}>
                                {ROLE_ORDER.map(r => {
                                  if (r === 'owner' && !isOwner) return null;
                                  return <option key={r} value={r}>{ROLES[r].label}</option>;
                                })}
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

          <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--mist)', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '11px 16px', textAlign: 'left', fontWeight: 700, fontSize: 11.5, color: 'var(--muted)', letterSpacing: '.04em', textTransform: 'uppercase', width: '32%' }}>
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

      {showAddUser && (
        <AddUserModal
          saving={addingSaving}
          onClose={() => setShowAddUser(false)}
          onAdd={handleAddUser}
        />
      )}
    </div>
  );
}
