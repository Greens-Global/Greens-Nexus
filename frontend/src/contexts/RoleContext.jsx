/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useMsal } from '@azure/msal-react';
import { api }     from '../api';

const RoleCtx = createContext(null);

// Canonical list of screens/modules — single source of truth shared by
// navigation (Sidebar), routing (App's VIEW_LABELS), and the group editor's
// module-access checkboxes, so they can never drift out of sync.
export const MODULES = [
  { id: 'dashboard',           label: 'Dashboard' },
  { id: 'manager-dashboard',   label: 'Manager Dashboard' },
  { id: 'purchase',            label: 'Purchase Requisition' },
  { id: 'tasks',               label: 'Tasks' },
  { id: 'sop',                 label: 'Knowledge Base' },
  { id: 'it',                  label: 'IT' },
  { id: 'ops',                 label: 'Construction' },
  { id: 'operations',          label: 'Operations' },
  { id: 'development',         label: 'Development' },
  { id: 'property-asset',      label: 'Asset Management' },
  { id: 'accounting',          label: 'Accounting' },
  { id: 'investor-relations',  label: 'Investor Relations' },
  { id: 'hr',                  label: 'HR' },
  { id: 'marketing',           label: 'Marketing' },
  { id: 'external-links',      label: 'External Links' },
  { id: 'inventory',           label: 'Item Management' },
  { id: 'admin',               label: 'Nexus Access Manager' },
  { id: 'support',             label: 'Support' },
];

// Per-module permission levels an Access Group can grant — mirrors a
// folder-permission row (Viewer/Editor/Full/Owner): visibility and capability
// are decided together, as one explicit, auditable choice per screen.
// Rank order matters — a higher level always implies everything lower grants.
export const MODULE_LEVELS = {
  viewer: { label: 'Viewer', rank: 1, description: 'See and use the screen normally' },
  editor: { label: 'Editor', rank: 2, description: 'Also create and edit records' },
  full:   { label: 'Full',   rank: 3, description: 'Also delete records' },
  owner:  { label: 'Owner',  rank: 4, description: 'Full access + manage who else has it' },
};

export const ROLES = {
  employee:      { label: 'Employee',      level: 1, color: 'var(--color-blue)',   bg: 'hsla(var(--color-blue),0.12)',   description: 'Raise requests, view own activity' },
  supervisor:    { label: 'Supervisor',     level: 2, color: 'var(--color-green)',  bg: 'hsla(var(--color-green),0.12)',  description: 'Allocate items, manage returns' },
  manager:       { label: 'Manager',        level: 3, color: 'var(--color-orange)', bg: 'hsla(var(--color-orange),0.12)', description: 'Approve requests, team oversight — no access-granting or deletion rights' },
  administrator: { label: 'IT Admin',       level: 4, color: 'var(--color-purple)', bg: 'hsla(var(--color-purple),0.12)', description: 'Manage settings & inventory, grant access up to Manager — cannot manage other admins or delete core records' },
  owner:         { label: 'Global Admin',   level: 5, color: 'var(--color-gold)',   bg: 'hsla(var(--color-gold),0.12)',   description: 'Full, unrestricted access — including managing other admins and deleting core records' },
};

export function RoleProvider({ children }) {
  const { accounts }    = useMsal();
  const myEmail         = (accounts[0]?.username ?? '').toLowerCase();

  const [myRole,    setMyRole]    = useState('employee');
  const [allRoles,  setAllRoles]  = useState({});   // { email: role }
  const [loading,   setLoading]   = useState(true);
  const [groups,    setGroups]    = useState([]);   // [{ id, name, department, allowed_modules, members, ... }]

  // Fetch current user's role on mount / account change.
  // Retries up to 3 times with backoff — guards against the MSAL token
  // not being ready on the very first render.
  useEffect(() => {
    if (!myEmail) { setLoading(false); return; }
    let cancelled = false;

    const tryFetch = (attempt = 1) => {
      api.getMyRole()
        .then(data => {
          if (!cancelled) {
            setMyRole(data.role ?? 'employee');
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled && attempt < 3) {
            setTimeout(() => tryFetch(attempt + 1), 1000 * attempt);
          } else if (!cancelled) {
            setMyRole('employee');
            setLoading(false);
          }
        });
    };

    tryFetch();
    return () => { cancelled = true; };
  }, [myEmail]);

  // Fetch all role assignments (used by Admin page)
  const refreshAllRoles = useCallback(() => {
    api.getAllRoles()
      .then(list => {
        const map = {};
        list.forEach(r => { map[r.email.toLowerCase()] = r.role; });
        setAllRoles(map);
      })
      .catch(() => {});
  }, []);

  // Assign a role — writes to backend, refreshes local state
  const assignRole = useCallback(async (email, role, displayName) => {
    const lowerEmail = email.toLowerCase();
    await api.assignRole(lowerEmail, role, myEmail, displayName);
    setAllRoles(prev => ({ ...prev, [lowerEmail]: role }));
    // If assigning own role, update myRole too
    if (lowerEmail === myEmail) setMyRole(role);
  }, [myEmail]);

  const getRole = useCallback((email) =>
    allRoles[email?.toLowerCase()] ?? 'employee', [allRoles]);

  // ── Access Groups ──────────────────────────────────────────────────────────
  const refreshGroups = useCallback(() => {
    api.getGroups().then(setGroups).catch(() => {});
  }, []);

  const createGroup = useCallback(async (body) => {
    const created = await api.createGroup(body);
    setGroups(prev => [...prev, created]);
    return created;
  }, []);

  const updateGroup = useCallback(async (id, body) => {
    const updated = await api.updateGroup(id, body);
    setGroups(prev => prev.map(g => g.id === id ? updated : g));
    return updated;
  }, []);

  const deleteGroup = useCallback(async (id) => {
    await api.deleteGroup(id);
    setGroups(prev => prev.filter(g => g.id !== id));
  }, []);

  const addGroupMembers = useCallback(async (id, emails) => {
    const updated = await api.addGroupMembers(id, emails);
    setGroups(prev => prev.map(g => g.id === id ? updated : g));
    return updated;
  }, []);

  const removeGroupMember = useCallback(async (id, email) => {
    const updated = await api.removeGroupMember(id, email);
    setGroups(prev => prev.map(g => g.id === id ? updated : g));
    return updated;
  }, []);

  // Bulk-assign a role to every member of a group. Returns { updated, skipped }
  // so the caller can surface which members were granted vs. blocked by the
  // same delegation rules enforced for single-user assignment.
  const assignGroupRole = useCallback(async (id, role) => {
    const result = await api.assignGroupRole(id, role, myEmail);
    if (result.updated?.length) {
      setAllRoles(prev => {
        const next = { ...prev };
        result.updated.forEach(email => { next[email.toLowerCase()] = role; });
        return next;
      });
      if (result.updated.includes(myEmail)) setMyRole(role);
    }
    return result;
  }, [myEmail]);

  // Modules granted to the current user via any group they belong to, mapped
  // to the highest permission level any of those groups grants for it (e.g.
  // {"inventory": "full", "it": "viewer"}) — purely additive on top of
  // role-based nav access (Sidebar.jsx): membership can only ever widen
  // access, never narrow it. A module present in this map (any level) is
  // visible in the nav; the level additionally decides what they can DO there.
  const myGrantedModules = useMemo(() => {
    const map = new Map();
    groups.forEach(g => {
      if (!g.members?.includes(myEmail)) return;
      (g.allowed_modules || []).forEach(({ id, level }) => {
        const prevRank = MODULE_LEVELS[map.get(id)]?.rank ?? 0;
        const nextRank = MODULE_LEVELS[level]?.rank ?? MODULE_LEVELS.viewer.rank;
        if (nextRank > prevRank) map.set(id, level);
      });
    });
    return map;
  }, [groups, myEmail]);

  const myLevel = ROLES[myRole]?.level ?? 1;
  const can     = (minRole) => myLevel >= (ROLES[minRole]?.level ?? 1);

  // True if the user can act on `moduleId` at least at `minModuleLevel` —
  // either because their global role already implies it (`minRole`), or
  // because an Access Group grants that module at/above `minModuleLevel`
  // (e.g. canAccessModule('inventory', 'manager', 'editor')).
  const canAccessModule = (moduleId, minRole, minModuleLevel = 'viewer') => {
    if (!minRole || can(minRole)) return true;
    const grantedRank = MODULE_LEVELS[myGrantedModules.get(moduleId)]?.rank ?? 0;
    return grantedRank >= (MODULE_LEVELS[minModuleLevel]?.rank ?? 1);
  };

  return (
    <RoleCtx.Provider value={{
      myRole, myEmail, loading,
      allRoles, getRole, refreshAllRoles,
      can, assignRole, ROLES,
      groups, refreshGroups, createGroup, updateGroup, deleteGroup,
      addGroupMembers, removeGroupMember, assignGroupRole,
      myGrantedModules, canAccessModule,
    }}>
      {children}
    </RoleCtx.Provider>
  );
}

export function useRole() { return useContext(RoleCtx); }
