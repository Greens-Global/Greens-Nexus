/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback } from 'react';
import { useMsal } from '@azure/msal-react';

const RoleCtx = createContext(null);

export const ROLES = {
  employee:      { label: 'Employee',      level: 1, color: 'var(--color-blue)',   bg: 'hsla(var(--color-blue),0.12)',   description: 'Raise requests, view own activity' },
  supervisor:    { label: 'Supervisor',     level: 2, color: 'var(--color-green)',  bg: 'hsla(var(--color-green),0.12)',  description: 'Allocate items, manage returns' },
  manager:       { label: 'Manager',        level: 3, color: 'var(--color-orange)', bg: 'hsla(var(--color-orange),0.12)', description: 'Approve requests, team oversight' },
  administrator: { label: 'Administrator',  level: 4, color: 'var(--color-purple)', bg: 'hsla(var(--color-purple),0.12)', description: 'System settings, manage inventory' },
  owner:         { label: 'Owner',          level: 5, color: 'var(--color-gold)',   bg: 'hsla(var(--color-gold),0.12)',   description: 'Full access including role management' },
};

const STORAGE_KEY = 'gg-nexus-roles';

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); } catch { return {}; }
}
function save(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function RoleProvider({ children }) {
  const { accounts } = useMsal();
  const myEmail      = (accounts[0]?.username ?? '').toLowerCase();

  const [roleMap, setRoleMap] = useState(() => {
    const stored = load();
    // Seed: Visesh is Owner by default if no roles assigned yet
    if (Object.keys(stored).length === 0 && myEmail) {
      const seed = { [myEmail]: 'owner' };
      save(seed);
      return seed;
    }
    // Auto-assign owner to current user if they have no role and nobody else is owner
    if (myEmail && !stored[myEmail] && !Object.values(stored).includes('owner')) {
      const updated = { ...stored, [myEmail]: 'owner' };
      save(updated);
      return updated;
    }
    return stored;
  });

  const assignRole = useCallback((email, role) => {
    const updated = { ...roleMap, [email.toLowerCase()]: role };
    setRoleMap(updated);
    save(updated);
  }, [roleMap]);

  const getRole    = useCallback((email) => roleMap[email?.toLowerCase()] ?? 'employee', [roleMap]);
  const myRole     = getRole(myEmail);
  const myLevel    = ROLES[myRole]?.level ?? 1;
  const can        = (minRole) => myLevel >= (ROLES[minRole]?.level ?? 1);

  return (
    <RoleCtx.Provider value={{ roleMap, myRole, myEmail, can, getRole, assignRole, ROLES }}>
      {children}
    </RoleCtx.Provider>
  );
}

export function useRole() { return useContext(RoleCtx); }
