// Investor Chart (Neil, Aug 11): investors do not report to anyone - they are
// MANAGED BY a relationship owner (Neil, RJK, ...). This is the org chart's
// sibling view: one group per owner, the investors they manage inside it, and
// "Managed by" as the single editable fact. It reads the SAME book of business
// as the Investor Relations module (ir_investors.relationship_owner_email) -
// no second list of investors, no schema of its own.
//
// Deliberately select-based rather than drag: reassigning an investor is a
// deliberate act on one card, not a spatial arrangement.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Briefcase, Loader2, Plus, X } from 'lucide-react';
import { api } from '../api';

const personName = (employees, email) => {
  const em = (email || '').toLowerCase();
  if (!em) return '';
  const p = (employees || []).find(e => (e.workEmail || '').toLowerCase() === em);
  if (p) return [p.firstName, p.lastName].filter(Boolean).join(' ');
  return em.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

export default function InvestorChart({ employees = [], toastOk, toastErr }) {
  const [investors, setInvestors] = useState(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState('');
  const [adding, setAdding] = useState(null);   // {name, email, owner} | null
  const [addBusy, setAddBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api.getIrInvestors()
      .then(rows => setInvestors(rows || []))
      .catch(e => {
        if (e?.status === 403) setDenied(true);
        else setError(e?.message || 'Could not load the investor book.');
        setInvestors([]);
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  const ownerOptions = useMemo(() => (
    (employees || [])
      .filter(e => e.status !== 'offboarded' && e.workEmail)
      .map(e => ({ email: e.workEmail.toLowerCase(), name: [e.firstName, e.lastName].filter(Boolean).join(' ') || e.workEmail }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ), [employees]);

  const groups = useMemo(() => {
    const by = new Map();
    for (const v of investors || []) {
      const key = (v.relationshipOwnerEmail || v.relationship_owner_email || '').toLowerCase();
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(v);
    }
    for (const arr of by.values()) arr.sort((a, b) => (a.displayName || a.display_name || '').localeCompare(b.displayName || b.display_name || ''));
    // Owners with the most investors first; the unassigned bucket always last.
    return [...by.entries()].sort((a, b) =>
      (a[0] === '' ? 1 : b[0] === '' ? -1 : b[1].length - a[1].length));
  }, [investors]);

  const reassign = async (inv, ownerEmail) => {
    const id = inv.id;
    setSaving(id);
    try {
      await api.updateIrInvestor(id, { relationshipOwnerEmail: ownerEmail });
      setInvestors(list => list.map(v => (v.id === id
        ? { ...v, relationshipOwnerEmail: ownerEmail, relationship_owner_email: ownerEmail }
        : v)));
      toastOk?.(ownerEmail
        ? `${inv.displayName || inv.display_name} is now managed by ${personName(employees, ownerEmail)}.`
        : `${inv.displayName || inv.display_name} is now unassigned.`);
    } catch (e) { toastErr?.(e?.message || 'Could not change the relationship owner.'); }
    setSaving('');
  };

  const saveAdd = async () => {
    if (addBusy) return;
    if (!adding.name.trim()) { toastErr?.('Give the investor a name.'); return; }
    setAddBusy(true);
    try {
      await api.createIrInvestor({
        displayName: adding.name.trim(), email: adding.email.trim(),
        relationshipOwnerEmail: adding.owner,
      });
      toastOk?.(`${adding.name.trim()} added to the investor book.`);
      setAdding(null);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not add the investor.'); }
    setAddBusy(false);
  };

  if (denied) return (
    <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
      <Briefcase size={30} style={{ opacity: .3, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>Needs Investor Relations access</div>
      <div style={{ fontSize: 13 }}>The investor chart reads the Investor Relations book - ask for the IR grant to see it.</div>
    </div>
  );

  if (investors === null) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '46px 0', color: 'var(--muted)', fontSize: 13 }}>
      <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading the investor book…
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Investors don&apos;t report to anyone - each is managed by a relationship owner. Same book as Investor Relations.
        </span>
        <span style={{ flex: 1 }} />
        <button className="primary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}
          onClick={() => setAdding({ name: '', email: '', owner: '' })}>
          <Plus size={13} /> Add Investor
        </button>
      </div>

      {error && <div style={{ color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {investors.length === 0 && !error ? (
        <div style={{ textAlign: 'center', padding: '44px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <Briefcase size={30} style={{ opacity: .3, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>No investors yet</div>
          <div style={{ fontSize: 13 }}>Add them here or in the Investor Relations module - the two stay in step.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 14, alignItems: 'start' }}>
          {groups.map(([ownerEmail, list]) => (
            <div key={ownerEmail || '__none__'} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8,
                background: ownerEmail ? 'var(--mist)' : 'hsla(var(--color-orange),0.07)' }}>
                <Briefcase size={14} style={{ color: ownerEmail ? 'var(--muted)' : 'hsl(var(--color-orange))', flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ownerEmail ? `Managed by ${personName(employees, ownerEmail)}` : 'No relationship owner yet'}
                </span>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)' }}>{list.length}</span>
              </div>
              {list.map(v => {
                const name = v.displayName || v.display_name || '(unnamed)';
                const cur = (v.relationshipOwnerEmail || v.relationship_owner_email || '').toLowerCase();
                return (
                  <div key={v.id} style={{ padding: '9px 14px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                      {(v.status || '') && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'capitalize' }}>{v.status}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Managed by</span>
                      <select className="form-input" value={cur} disabled={saving === v.id}
                        onChange={ev => reassign(v, ev.target.value)}
                        style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '4px 24px 4px 8px', height: 28 }}>
                        <option value="">Nobody yet</option>
                        {ownerOptions.map(o => <option key={o.email} value={o.email}>{o.name}</option>)}
                      </select>
                      {saving === v.id && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)', flexShrink: 0 }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setAdding(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="wkc-chip"><Briefcase size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Add Investor</h3>
              <button onClick={() => setAdding(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
              <div><label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Name</label>
                <input className="form-input" autoFocus placeholder="e.g. Malay Shah" value={adding.name}
                  onChange={e => setAdding(p => ({ ...p, name: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Email (optional)</label>
                <input className="form-input" placeholder="name@example.com" value={adding.email}
                  onChange={e => setAdding(p => ({ ...p, email: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Managed by</label>
                <select className="form-input" value={adding.owner} onChange={e => setAdding(p => ({ ...p, owner: e.target.value }))} style={{ width: '100%' }}>
                  <option value="">Nobody yet</option>
                  {ownerOptions.map(o => <option key={o.email} value={o.email}>{o.name}</option>)}
                </select></div>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setAdding(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveAdd} disabled={addBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {addBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={13} />} Add Investor
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
