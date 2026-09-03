/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { api, setActAsSessionId, getActAsSessionId } from '../api';
import { apiTokenRequest } from '../authConfig';
import { queryClient, qk } from '../lib/queryClient';
import { BFF_MODE } from '../bffAuth';

const RoleCtx = createContext(null);

// Canonical list of screens/modules - single source of truth shared by
// navigation (Sidebar), routing (App's VIEW_LABELS), and the group editor's
// module-access checkboxes, so they can never drift out of sync.
export const MODULES = [
  { id: 'dashboard',           label: 'Dashboard' },
  { id: 'timeclock',           label: 'Time Clock' },
  { id: 'employee-tracking',   label: 'Employee Tracking' },
  { id: 'myhr',                label: 'My Workday' },
  { id: 'manager-dashboard',   label: 'Manager Dashboard' },
  { id: 'tasks',               label: 'Tasks' },
  { id: 'tickets',             label: 'Tickets' },
  { id: 'sop',                 label: 'Knowledge Base' },
  { id: 'it',                  label: 'IT' },
  { id: 'ops',                 label: 'Construction' },
  { id: 'operations',          label: 'Operations' },
  { id: 'development',         label: 'Development' },
  { id: 'property-asset',      label: 'Asset Management' },
  { id: 'accounting',          label: 'Accounting' },
  { id: 'investor-relations',  label: 'Investor Relations' },
  { id: 'hr',                  label: 'People' },
  { id: 'hr_comp',             label: 'People - Compensation (salary/bank)' },
  { id: 'documents',           label: 'Documents' },
  { id: 'marketing',           label: 'Marketing' },
  { id: 'external-links',      label: 'External Links' },
  { id: 'inventory',           label: 'Item Management' },
  { id: 'admin',               label: 'Nexus Access Manager' },
  { id: 'support',             label: 'Support' },
  { id: 'testing',             label: 'Testing' },
  { id: 'credvault',           label: 'Credential Vault' },
  { id: 'egnyte',              label: 'Files' },
];

// Per-module permission levels an Access Group can grant - mirrors a
// folder-permission row (Viewer/Editor/Full/Owner): visibility and capability
// are decided together, as one explicit, auditable choice per screen.
// Rank order matters - a higher level always implies everything lower grants.
export const MODULE_LEVELS = {
  viewer: { label: 'Viewer', rank: 1, description: 'See and use the screen normally' },
  editor: { label: 'Editor', rank: 2, description: 'Also create and edit records' },
  full:   { label: 'Full',   rank: 3, description: 'Also delete records' },
  owner:  { label: 'Owner',  rank: 4, description: 'Full access + manage who else has it' },
};

// How an EXTERNAL (B2B guest) account's tier renders wherever a role/tier
// label is shown - topbar chip, account dropdown, mobile menu, person cards
// (Visesh, Aug 18: externals read "External", never "Employee"). Same shape as
// a ROLES entry so render sites can swap it in; level mirrors the server's
// employee-level hard cap. Internal employees are untouched.
export const EXTERNAL_ROLE_META = {
  label: 'External', level: 1, color: 'var(--color-blue)', bg: 'hsla(var(--color-blue),0.12)',
  description: 'Partner guest account - access limited to explicitly granted modules',
};

export const ROLES = {
  employee:      { label: 'Employee',      level: 1, color: 'var(--color-blue)',   bg: 'hsla(var(--color-blue),0.12)',   description: 'Raise requests, view own activity' },
  supervisor:    { label: 'Supervisor',     level: 2, color: 'var(--color-green)',  bg: 'hsla(var(--color-green),0.12)',  description: 'Allocate items, manage returns' },
  manager:       { label: 'Manager',        level: 3, color: 'var(--color-orange)', bg: 'hsla(var(--color-orange),0.12)', description: 'Approve requests, team oversight - no access-granting or deletion rights' },
  administrator: { label: 'IT Admin',       level: 4, color: 'var(--color-purple)', bg: 'hsla(var(--color-purple),0.12)', description: 'Manage settings & inventory, grant access up to Manager - cannot manage other admins or delete core records' },
  owner:         { label: 'Global Admin',   level: 5, color: 'var(--color-gold)',   bg: 'hsla(var(--color-gold),0.12)',   description: 'Full, unrestricted access - including managing other admins and deleting core records' },
};

export function RoleProvider({ children }) {
  const { instance, accounts, inProgress } = useMsal();
  // E2E builds have no MSAL account - use a placeholder identity so the role
  // still loads from the API (the NEXUS_SKIP_AUTH backend resolves who we are
  // server-side). Without this, headless runs are stuck as 'employee' and the
  // nightly QA specs can never exercise manager/admin surfaces.
  const _e2eEmail       = import.meta.env.VITE_E2E === 'true' ? 'e2e@local' : '';
  const realEmail       = (accounts[0]?.username ?? _e2eEmail).toLowerCase();

  // Live MSAL interaction status, readable inside the async role-fetch callback
  // (the effect closure would otherwise capture a stale value).
  const inProgressRef = useRef(inProgress);
  useEffect(() => { inProgressRef.current = inProgress; }, [inProgress]);

  const [myRole,    setMyRole]    = useState('employee');
  const [allRoles,  setAllRoles]  = useState({});   // { email: role }
  const [loading,   setLoading]   = useState(true);
  const [groups,    setGroups]    = useState([]);   // [{ id, name, department, allowed_modules, members, ... }]
  // External (Entra B2B guest) accounts see ONLY their granted modules -
  // Sidebar and ProtectedView narrow on this flag (server enforces the same
  // boundary in auth.apply_external_policy; this is just matching UI).
  const [isExternal, setIsExternal] = useState(false);
  // Company-scoped People access (Neil, Aug 25): a list of HrEntity ids when
  // this admin's HR grant is limited to specific companies, else null
  // (unrestricted). Server-enforced in auth.hr_scope; HR.jsx uses this to hide
  // company-wide actions (Sync M365, Company setup) and show the scope chip.
  const [hrScope, setHrScope] = useState(null);

  // ── Act As (Jul 2026) ──────────────────────────────────────────────────────
  // { sessionId, targetEmail, targetName, expiresAt } while impersonating, else
  // null. api.js already persists the session id and attaches it to every
  // request, so the getMyRole() effect below transparently comes back with the
  // TARGET's role on a fresh page load - this only needs to restore the
  // display info (name/banner), not re-derive access.
  const ACT_AS_INFO_KEY = 'nexus:act-as-info';
  const [actingAs, setActingAsState] = useState(() => {
    try {
      const raw = sessionStorage.getItem(ACT_AS_INFO_KEY);
      const info = raw ? JSON.parse(raw) : null;
      if (info?.expiresAt && getActAsSessionId() && new Date(info.expiresAt).getTime() > Date.now()) {
        return info;
      }
    } catch { /* ignore malformed storage */ }
    sessionStorage.removeItem(ACT_AS_INFO_KEY);
    setActAsSessionId(null);
    return null;
  });

  // The identity every client-side "mine" derivation keys on. While acting,
  // this is the TARGET (Jul 28 bug: the sidebar gated modules against the
  // ADMIN's group memberships, so impersonating Pranshu showed fewer modules
  // than Pranshu really has). The server already overlays the same way via
  // X-Act-As-Session; realEmail stays available for identity-anchored UI.
  const myEmail = (actingAs?.targetEmail || realEmail).toLowerCase();

  // Fetch current user's role and group memberships on mount / account change.
  // Groups must be loaded here (not just in Admin) so that myGrantedModules is
  // populated for all users - otherwise group-granted sidebar items never appear.
  // Role fetch retries up to 3× with backoff; groups fail silently.
  useEffect(() => {
    let cancelled = false;
    if (!myEmail) {
      // MSAL (and the dev-login bypass) start with an empty accounts[] on the
      // very first render - msal-react only populates it after
      // handleRedirectPromise() resolves (see msalInstance.js). Do not drop
      // straight to the employee default and mark loading done: that flashes
      // "Access Restricted" on every gated view on a hard reload/deep link,
      // right up until the real account/role arrives a moment later. Give it
      // a bounded window before treating this as genuinely signed out.
      const t = setTimeout(() => { if (!cancelled) setLoading(false); }, 2500);
      return () => { cancelled = true; clearTimeout(t); };
    }

    const tryFetch = (attempt = 1) => {
      api.getMyRole()
        .then(data => {
          if (!cancelled) {
            setMyRole(data.role ?? 'employee');
            setIsExternal(!!data.is_external);
            setHrScope(Array.isArray(data.hr_scope) ? data.hr_scope : null);
            setLoading(false);
          }
        })
        .catch((err) => {
          // A 401 means the ID token was rejected - the silent (hidden-iframe)
          // token renewal failed. That iframe depends on third-party cookies, so
          // when a browser blocks them (or a CSP/extension blocks the frame) it
          // fails for anyone whose cached token has expired, and every call 401s
          // → the user is stranded on 'employee' access no matter their real role.
          // Recover with ONE top-level interactive redirect: it's first-party, so
          // it isn't subject to the third-party-cookie/frame restrictions the
          // iframe hit, and it returns with a fresh token. Guarded so it can never
          // loop (at most once per 5 min) and skipped in E2E / when signed out.
          if (err?.status === 401 && import.meta.env.VITE_E2E !== 'true'
              && !BFF_MODE   // BFF: api.js already redirected to /api/auth/login
              && accounts.length && inProgressRef.current === InteractionStatus.None) {
            const KEY = 'nexus:reauth-at';
            const last = Number(sessionStorage.getItem(KEY) || 0);
            if (Date.now() - last > 5 * 60_000) {
              sessionStorage.setItem(KEY, String(Date.now()));
              const account = instance.getActiveAccount() || accounts[0];
              instance.acquireTokenRedirect({ ...apiTokenRequest, account }).catch(() => {});
              return;   // page is navigating to Microsoft and back
            }
          }
          if (!cancelled && attempt < 3) {
            setTimeout(() => tryFetch(attempt + 1), 1000 * attempt);
          } else if (!cancelled) {
            setMyRole('employee');
            setLoading(false);
          }
        });
    };

    tryFetch();
    // Load groups so myGrantedModules is accurate for every user on every page.
    // Routed through the shared TanStack cache (qk.groups) so this dedupes with
    // every useGroups() screen - whoever loads first, the other reuses it - and
    // a group mutation invalidates one cache for all of them. getMyRole above is
    // deliberately NOT wrapped: its bespoke 3x-retry + 401 interactive-redirect
    // recovery must stay exactly as-is, and a context already shares its result
    // app-wide, so there is nothing to gain and real reliability to lose.
    queryClient.fetchQuery({ queryKey: qk.groups, queryFn: api.getGroups, staleTime: 30_000 })
      .then(data => { if (!cancelled) setGroups(data); }).catch(() => {});

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

  // Assign a role - writes to backend, refreshes local state
  const assignRole = useCallback(async (email, role, displayName) => {
    const lowerEmail = email.toLowerCase();
    await api.assignRole(lowerEmail, role, myEmail, displayName);
    setAllRoles(prev => ({ ...prev, [lowerEmail]: role }));
    // If assigning own role, update myRole too
    if (lowerEmail === myEmail) setMyRole(role);
  }, [myEmail]);

  const getRole = useCallback((email) =>
    allRoles[email?.toLowerCase()] ?? 'employee', [allRoles]);

  // Begin impersonating `targetEmail`. The backend re-validates permission
  // (strictly-lower-role target, Manager+ or an 'act-as' Access Group grant)
  // on every request via the session id, not just here - this call only opens
  // the session and refreshes local role/UI state to match immediately.
  const startActAs = useCallback(async (targetEmail) => {
    const result = await api.startActAs(targetEmail);
    const info = {
      sessionId: result.session_id, targetEmail: result.target_email,
      targetName: result.target_name, expiresAt: result.expires_at,
    };
    setActAsSessionId(info.sessionId);
    sessionStorage.setItem(ACT_AS_INFO_KEY, JSON.stringify(info));
    // FULL RELOAD, not a role refetch (Jul 28 bug: "Act As shows my own stuff").
    // Refreshing only myRole left every mounted context and view - notifications,
    // dashboards, Time Clock, My HR, the api GET cache - holding the ADMIN's
    // already-fetched data, so nothing visibly changed but the banner. A boot
    // from scratch re-runs every fetch with the X-Act-As-Session header attached
    // (it persists in sessionStorage), so the whole app comes up as the target.
    window.location.assign('/');
    return info;
  }, []);

  const stopActAs = useCallback(async () => {
    const sessionId = getActAsSessionId();
    setActAsSessionId(null);
    sessionStorage.removeItem(ACT_AS_INFO_KEY);
    if (sessionId) {
      try { await api.stopActAs(sessionId); } catch { /* best-effort - TTL expiry covers it either way */ }
    }
    // Same reasoning as startActAs: reboot the app as the real account so no
    // view keeps serving the target's data after exiting.
    window.location.assign('/');
  }, []);

  // ── Access Groups ──────────────────────────────────────────────────────────
  const refreshGroups = useCallback(() => {
    // Force-fresh (staleTime 0) and write through the shared cache so every
    // useGroups() consumer reflects the change too.
    queryClient.fetchQuery({ queryKey: qk.groups, queryFn: api.getGroups, staleTime: 0 })
      .then(setGroups).catch(() => {});
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
  // {"inventory": "full", "it": "viewer"}) - purely additive on top of
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

  // True if the user can act on `moduleId` at least at `minModuleLevel` -
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
      myRole, myEmail, realEmail, loading, isExternal, hrScope,
      allRoles, getRole, refreshAllRoles,
      can, assignRole, ROLES,
      groups, refreshGroups, createGroup, updateGroup, deleteGroup,
      addGroupMembers, removeGroupMember, assignGroupRole,
      myGrantedModules, canAccessModule,
      actingAs, startActAs, stopActAs,
    }}>
      {children}
    </RoleCtx.Provider>
  );
}

export function useRole() { return useContext(RoleCtx); }
