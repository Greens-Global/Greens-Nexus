/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useMsal } from '@azure/msal-react';
import { api }     from '../api';

const RoleCtx = createContext(null);

export const ROLES = {
  employee:      { label: 'Employee',      level: 1, color: 'var(--color-blue)',   bg: 'hsla(var(--color-blue),0.12)',   description: 'Raise requests, view own activity' },
  supervisor:    { label: 'Supervisor',     level: 2, color: 'var(--color-green)',  bg: 'hsla(var(--color-green),0.12)',  description: 'Allocate items, manage returns' },
  manager:       { label: 'Manager',        level: 3, color: 'var(--color-orange)', bg: 'hsla(var(--color-orange),0.12)', description: 'Approve requests, team oversight' },
  administrator: { label: 'Administrator',  level: 4, color: 'var(--color-purple)', bg: 'hsla(var(--color-purple),0.12)', description: 'System settings, manage inventory' },
  owner:         { label: 'Owner',          level: 5, color: 'var(--color-gold)',   bg: 'hsla(var(--color-gold),0.12)',   description: 'Full access including role management' },
};

export function RoleProvider({ children }) {
  const { accounts }    = useMsal();
  const myEmail         = (accounts[0]?.username ?? '').toLowerCase();

  const [myRole,    setMyRole]    = useState('employee');
  const [allRoles,  setAllRoles]  = useState({});   // { email: role }
  const [loading,   setLoading]   = useState(true);

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

  const myLevel = ROLES[myRole]?.level ?? 1;
  const can     = (minRole) => myLevel >= (ROLES[minRole]?.level ?? 1);

  return (
    <RoleCtx.Provider value={{
      myRole, myEmail, loading,
      allRoles, getRole, refreshAllRoles,
      can, assignRole, ROLES,
    }}>
      {children}
    </RoleCtx.Provider>
  );
}

export function useRole() { return useContext(RoleCtx); }
