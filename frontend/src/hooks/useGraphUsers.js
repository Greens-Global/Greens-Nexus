import { useMsal }                         from '@azure/msal-react';
import { InteractionRequiredAuthError }    from '@azure/msal-browser';
import { useState, useEffect } from 'react';

const GRAPH_URL = 'https://graph.microsoft.com/v1.0/users'
  + '?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,accountEnabled'
  + '&$top=999&$orderby=displayName';

const GRAPH_SCOPE = ['User.ReadBasic.All'];

async function fetchUsers(instance, account) {
  const req = { scopes: GRAPH_SCOPE, account };

  let tokenRes;
  try {
    tokenRes = await instance.acquireTokenSilent(req);
  } catch (err) {
    // Consent not yet granted — trigger interactive popup
    if (err instanceof InteractionRequiredAuthError) {
      tokenRes = await instance.acquireTokenPopup(req);
    } else {
      throw err;
    }
  }

  const res = await fetch(GRAPH_URL, {
    headers: { Authorization: `Bearer ${tokenRes.accessToken}` },
  });

  if (res.status === 403) throw new Error('permission_denied');
  if (!res.ok)            throw new Error(`graph_error_${res.status}`);

  const data = await res.json();
  // Filter enabled accounts only (filter param not always supported without $count)
  return (data.value ?? []).filter(u => u.accountEnabled !== false);
}

export function useGraphUsers() {
  const { instance, accounts } = useMsal();
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!accounts.length) { setLoading(false); return; }

    fetchUsers(instance, accounts[0])
      .then(list => { setUsers(list); setLoading(false); })
      .catch(err  => { setError(err.message); setLoading(false); });
  }, [instance, accounts]);

  return { users, loading, error };
}
