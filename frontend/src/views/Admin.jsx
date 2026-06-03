import { useState, useMemo, useEffect } from 'react';
import { Search, Shield, AlertTriangle, RefreshCw, Users, CheckCircle, Crown } from 'lucide-react';
import { useRole, ROLES } from '../contexts/RoleContext';
import { useGraphUsers }  from '../hooks/useGraphUsers';
import { useMsal }        from '@azure/msal-react';
import { api }            from '../api';

const ROLE_ORDER = ['owner', 'administrator', 'manager', 'supervisor', 'employee'];

function RoleBadge({ role, size = 'sm' }) {
  const meta = ROLES[role] ?? ROLES.employee;
  const pad  = size === 'sm' ? '2px 9px' : '4px 12px';
  const fs   = size === 'sm' ? 11 : 12.5;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: pad, borderRadius: 20, fontSize: fs, fontWeight: 700,
      background: meta.bg, color: `hsl(${meta.color})`,
      whiteSpace: 'nowrap',
    }}>
      {role === 'owner' && <Crown size={10} />}
      {meta.label}
    </span>
  );
}

function PermissionMissing() {
  return (
    <div style={{
      border: '1px solid hsla(var(--color-orange),0.3)',
      background: 'hsla(var(--color-orange),0.06)',
      borderRadius: 14, padding: '28px 32px', marginTop: 24,
    }}>
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

export default function Admin() {
  const { myRole, myEmail, getRole, assignRole, refreshAllRoles, can } = useRole();
  const { users, loading: graphLoading, error } = useGraphUsers();
  const { accounts } = useMsal();
  const myEmail2 = accounts[0]?.username?.toLowerCase() ?? '';

  const [search,    setSearch]    = useState('');
  const [filter,    setFilter]    = useState('all');
  const [saved,     setSaved]     = useState({});
  const [saving,    setSaving]    = useState({});   // email → true while PUT in flight
  const [activeTab, setActiveTab] = useState('users');

  const loading = graphLoading;

  // Load all role assignments when admin page opens
  useEffect(() => { refreshAllRoles(); }, [refreshAllRoles]);

  // Once Graph users load, sync all emails to nexus_roles as Employee (no-op if row exists)
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

  // Build user list — Graph users + any locally assigned users not in Graph
  const graphEmails = new Set(users.map(u => (u.mail ?? u.userPrincipalName ?? '').toLowerCase()));

  const displayUsers = useMemo(() => {
    const base = users.map(u => ({
      id:    u.id,
      name:  u.displayName,
      email: (u.mail ?? u.userPrincipalName ?? '').toLowerCase(),
      title: u.jobTitle     ?? '—',
      dept:  u.department   ?? '—',
      role:  getRole(u.mail ?? u.userPrincipalName ?? ''),
    }));

    return base.filter(u => {
      const q = search.toLowerCase();
      const matchSearch = !q || u.name.toLowerCase().includes(q) || u.email.includes(q) || u.dept.toLowerCase().includes(q);
      const matchFilter = filter === 'all' || u.role === filter;
      return matchSearch && matchFilter;
    });
  }, [users, search, filter, getRole]);

  // Role counts
  const counts = useMemo(() => {
    const c = {};
    ROLE_ORDER.forEach(r => { c[r] = 0; });
    users.forEach(u => {
      const r = getRole(u.mail ?? u.userPrincipalName ?? '');
      c[r] = (c[r] ?? 0) + 1;
    });
    return c;
  }, [users, getRole]);

  const initials = name => name?.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase() ?? '?';

  const tabs = [
    { id: 'users',    label: 'Users & Roles' },
    { id: 'roles',    label: 'Role Permissions' },
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

      {/* ── Users & Roles ── */}
      {activeTab === 'users' && (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
            {ROLE_ORDER.map(role => {
              const meta = ROLES[role];
              return (
                <div key={role} style={{ background: 'var(--card)', border: `1px solid var(--line)`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer', transition: 'border-color .15s', borderTopWidth: 3, borderTopColor: `hsl(${meta.color})` }}
                  onClick={() => setFilter(f => f === role ? 'all' : role)}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: `hsl(${meta.color})`, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>{meta.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--ink)' }}>{counts[role] ?? 0}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{meta.description.split(',')[0]}</div>
                </div>
              );
            })}
          </div>

          {/* Search + filter */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="search-bar" style={{ width: 280 }}>
              <Search size={14} style={{ flexShrink: 0 }} />
              <input placeholder="Search by name, email or department…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {filter !== 'all' && (
              <button onClick={() => setFilter('all')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, border: '1px solid var(--line)', background: 'var(--card)', fontSize: 12, color: 'var(--muted)', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                Filtering: <RoleBadge role={filter} /> × Clear
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--muted)' }}>
              {loading ? 'Loading…' : `${displayUsers.length} user${displayUsers.length !== 1 ? 's' : ''}`}
            </span>
          </div>

          {/* Permission error */}
          {error?.includes('permission_denied') && <PermissionMissing />}

          {/* Loading skeleton */}
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[1,2,3,4,5].map(i => (
                <div key={i} style={{ height: 56, background: 'var(--mist)', borderRadius: 10, opacity: 1 - i * 0.12, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          )}

          {/* User table */}
          {!loading && !error?.includes('permission_denied') && (
            <>
              {displayUsers.length === 0 && !loading ? (
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
                        const currentRoleMeta = ROLES[u.role] ?? ROLES.employee;
                        return (
                          <tr key={u.id ?? u.email} style={{ opacity: isMe ? 1 : undefined }}>
                            {/* User cell */}
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

                            {/* Role selector */}
                            <td>
                              <select
                                value={u.role}
                                disabled={saving[u.email] || (!isOwner && u.role === 'owner')}
                                onChange={e => handleAssign(u.email, e.target.value)}
                                className="form-input"
                                style={{ padding: '5px 10px', fontSize: 12.5, height: 32, minWidth: 140 }}>
                                {ROLE_ORDER.map(r => {
                                  const rl = ROLES[r];
                                  // Non-owners can't assign owner role
                                  if (r === 'owner' && !isOwner) return null;
                                  return <option key={r} value={r}>{rl.label}</option>;
                                })}
                              </select>
                            </td>

                            {/* Saved feedback */}
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

      {/* ── Role Permissions ── */}
      {activeTab === 'roles' && (
        <>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>
            What each role can do in Nexus. Roles are cumulative — higher roles include all permissions of lower roles.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {ROLE_ORDER.map(role => {
              const meta = ROLES[role];
              const PERMS = {
                employee:      ['Raise inventory requests', 'View own requests & status', 'Return items', 'Receive notifications', 'View company inventory catalogue'],
                supervisor:    ['Mark inventory items as allocated', 'Confirm item returns & condition', 'View department-level activity', 'Access department reports'],
                manager:       ['Approve or reject inventory requests', 'Approve or reject purchase requisitions', 'View "Who Has What" across the company', 'Send overdue alerts to employees', 'Access Manager Dashboard'],
                administrator: ['Add, edit and retire inventory items', 'Update item quantities and categories', 'View all system data and reports', 'Access Administration panel', 'Export data to CSV'],
                owner:         ['Assign and change user roles', 'Promote users to Administrator', 'Full access to all Nexus features', 'System-wide configuration'],
              };
              return (
                <div key={role} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', borderLeft: `4px solid hsl(${meta.color})` }}>
                  <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--line)', background: `hsla(${meta.color},0.04)` }}>
                    {role === 'owner' && <Crown size={16} style={{ color: `hsl(${meta.color})` }} />}
                    {role !== 'owner' && <Shield size={16} style={{ color: `hsl(${meta.color})` }} />}
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 14, color: `hsl(${meta.color})` }}>{meta.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 10 }}>{meta.description}</span>
                    </div>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                      {counts[role] ?? 0} user{(counts[role] ?? 0) !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div style={{ padding: '12px 18px', display: 'flex', flexWrap: 'wrap', gap: '6px 24px' }}>
                    {PERMS[role].map(p => (
                      <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--muted)' }}>
                        <CheckCircle size={12} style={{ color: `hsl(${meta.color})`, flexShrink: 0 }} />
                        {p}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
