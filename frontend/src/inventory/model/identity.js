// Item Management - who "I" am (Items redesign, Neil 11/02/2026).
// The acting identity, never MSAL's accounts[0]: while an administrator Acts
// As someone, Items shows THAT person's things and files requests under their
// name (the server overlays the same person through the Act As session).
import { useMsal } from '@azure/msal-react';
import { useRole } from '../../contexts/RoleContext';
import { cleanName } from '../../lib/utils';

export function useItemsIdentity() {
  const { myEmail, actingAs } = useRole();
  const { accounts } = useMsal();
  const email = String(myEmail || accounts?.[0]?.username || '').toLowerCase();
  const name = actingAs?.targetName || cleanName(accounts?.[0]?.name || '') || email.split('@')[0] || 'Me';
  return { myEmail: email, myName: cleanName(name) };
}
