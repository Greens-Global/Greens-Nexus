// The Client rows on Edit Job (Round Three item 2, Neil, 11/11/2026). Who
// the job is built for is one of Intacct's CUSTOMERS - found through the
// accounting app's copy of Intacct (routers/construction_subs.py, names and
// ids only), never a Nexus customer list. Picking one copies Intacct's
// contact as who signs (change orders and field tickets default to it);
// both stay editable. A Greens build is an Aarav Construction job whose
// client is the Greens company that owns the property. Saved with Edit
// Job's one Save (useClientDraft), like the Books rows.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { SettingRow, SettingCard } from '../components/settings/SettingsUI';

const quiet = { fontSize: '0.8rem', color: 'var(--text-secondary)' };

function CustomerPicker({ projectId, value, onPick }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [error, setError] = useState('');
  const text = q.trim();
  useEffect(() => {
    if (!text) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api.searchJobCustomers(projectId, text)
        .then((d) => { if (live) { setFound(d?.customers || []); setError(''); } })
        .catch((e) => { if (live) setError(e?.message || 'The customer list could not be read.'); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [text, projectId]);
  const shown = text ? found : [];
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input className="form-input" aria-label="Find a customer" placeholder={value ? 'Find another customer…' : 'Find a customer on the Intacct list…'}
        value={q} style={{ width: '100%' }} onChange={(e) => setQ(e.target.value)} />
      {shown.length > 0 && (
        <ul role="listbox" aria-label="Customers" style={{ listStyle: 'none', margin: '4px 0 0', padding: 4, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-card)', position: 'absolute', left: 0, right: 0, zIndex: 5, boxShadow: 'var(--shadow-md)' }}>
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" role="option" aria-selected={c.id === value}
                onClick={() => { onPick(c); setFound([]); setQ(''); }}
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '6px 8px', fontFamily: 'inherit', fontSize: '0.86rem', cursor: 'pointer', color: 'var(--text-primary)' }}>
                {c.name} <span style={{ ...quiet, fontSize: '0.76rem' }}>{c.id}{c.inactive ? ' · Inactive in Intacct' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div role="alert" style={{ marginTop: 4, fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{error}</div>}
    </div>
  );
}

export default function ClientRows({ client }) {
  const { draft, patch, projectId } = client;
  return (
    <SettingCard>
      <SettingRow title="Client" desc="Who the job is built for - a customer in Intacct (Accounting > Vendors & Customers). Nothing is written to Intacct.">
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }} data-job-client="">
          {draft.clientId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: '0.88rem' }}>{draft.clientName || draft.clientId}</b>
              <span style={quiet}>{draft.clientId}</span>
              <button type="button" className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                onClick={() => patch({ clientId: '', clientName: '', contactName: '', contactEmail: '' })}>Clear</button>
            </div>
          )}
          <CustomerPicker projectId={projectId} value={draft.clientId}
            onPick={(c) => patch({ clientId: c.id, clientName: c.name, contactName: c.contactName || '', contactEmail: (c.contactEmail || '').toLowerCase() })} />
        </div>
      </SettingRow>
      {draft.clientId && (
        <>
          <SettingRow title="Who Signs" htmlFor="job-client-contact" desc="Change orders and field tickets go to this person by default. Filled in from Intacct's contact."
            control={<input id="job-client-contact" aria-label="Who Signs" className="form-input" style={{ width: 'min(260px, 52vw)' }}
              value={draft.contactName} onChange={(e) => patch({ contactName: e.target.value })} placeholder="Their name" />} />
          <SettingRow title="Their Email" htmlFor="job-client-email"
            control={<input id="job-client-email" aria-label="Their Email" type="email" className="form-input" style={{ width: 'min(260px, 52vw)' }}
              value={draft.contactEmail} onChange={(e) => patch({ contactEmail: e.target.value })} placeholder="Where Nexus Sign sends it" />} />
        </>
      )}
    </SettingCard>
  );
}
