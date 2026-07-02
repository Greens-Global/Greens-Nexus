/**
 * NEXUS INTEGRATION: the prototype shipped a hardcoded "owner, level 5, can-do-everything"
 * session stub. Inside the Nexus platform, identity + RBAC come from RoleContext (MSAL-backed).
 * This maps Nexus's role into the { can, level, role } shape every permission check in the asset
 * module already expects (canManage, private-asset visibility, etc.), and pushes the real
 * display name into format.currentUser() so the activity log attributes edits to the actual user
 * (a name, never a raw email — house rule).
 */
import { useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { useRole, ROLES } from '../../contexts/RoleContext.jsx';
import { setCurrentUser } from './format.js';

export function useSession() {
  const role = useRole();
  const { accounts } = useMsal();

  const acct = accounts?.[0];
  const displayName = acct?.name || (acct?.username || '').split('@')[0] || 'You';
  useEffect(() => { setCurrentUser(displayName); }, [displayName]);

  const myRole = role?.myRole || 'employee';
  const level = ROLES?.[myRole]?.level ?? 1;
  return {
    can: role?.can || (() => false),
    level,
    role: myRole,
  };
}
