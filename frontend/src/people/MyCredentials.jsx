import { useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { CredentialState } from './credentialState';

// My HR > My Licenses & Certifications (Neil, 11/11/2026, Deputy parity):
// what HR has on file for me and when each expires, read only - HR adds and
// renews them. Nothing at all until there is one. The bell reminds me ahead
// of an expiry (reminders.py).
export default function MyCredentials() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    api.myCredentials().then((r) => { if (live) setRows(r?.credentials || []); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="dash-card" data-my-credentials>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <BadgeCheck size={15} style={{ color: 'var(--muted)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>My Licenses & Certifications</span>
      </div>
      {rows.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
          <span style={{ fontWeight: 600, flex: '1 1 160px' }}>{c.name}</span>
          <CredentialState state={c.state} />
          <span style={{ color: 'var(--muted)' }}>{c.expiresOn ? `Expires ${formatDate(c.expiresOn)}` : 'No expiry'}</span>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Renewed one? Send it to HR with Ask HR and they will update it here.</div>
    </div>
  );
}
