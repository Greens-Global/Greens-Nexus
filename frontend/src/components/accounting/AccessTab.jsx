import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Check, Download, Search, ShieldCheck, X } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { useNameResolver } from '../../lib/useNameResolver';
import { formatDateTime } from '../../lib/datetime';
import { control, entityOptions } from './reportControls';

// Accounting -> Access (Neil, Sep 25): "even the accounting team should only
// have access to certain items ... different people at different levels on
// different entities." Family and personal entities are in the same ledger as
// the companies; this is where the person who runs accounting decides who
// reads which.
//
// Everyone holding the Accounting grant is listed. "All entities" is the
// default; limiting a person to a set of entities takes effect on their next
// click - reports, search, drill-downs and journal entries all stop at that
// set, the consolidated dashboard tabs close for them, and so does the
// accounting app (it has no entity limits of its own). Administrators and
// owners are never limited and are not listed.
//
// Sep 30 (Charmi, call of 09/29): "Select All" in the entity picker, then
// untick the few that do not apply; and a Last Opened column - when each
// person last opened Accounting, and how many times.
//
// Sep 30 (Visesh): "Bring From Intacct" reads who may see which entities in
// Intacct itself, matches the Intacct users to Nexus people by email, shows
// the two side by side, and sets the ticked people's Nexus limits to match.
//
// Oct 7 (Charmi, item 41: "Access need to include access for PFS"): owners
// see a PFS column - None / Viewer / Editor per person - that writes the
// PFS module grant (routers/pfs_access.py); an owner reads "Owner" and cannot
// be changed; a grant from another group is shown as a note. People with PFS
// access but no Accounting access are listed under the table, and anyone on
// Nexus People can be added there. Every change is audited server side.

const LEVELS = { viewer: 'Viewer', editor: 'Editor', full: 'Full', owner: 'Owner' };
const PFS_LEVELS = [['none', 'None'], ['viewer', 'Viewer'], ['editor', 'Editor']];

export default function AccessTab() {
  const { myEmail, myRole } = useRole();
  const owner = myRole === 'owner';
  const [pfs, setPfs] = useState(null);            // owners: everyone's PFS access, by email
  const [pfsError, setPfsError] = useState('');
  const [pfsExtra, setPfsExtra] = useState([]);    // people added to the PFS-only list on this visit
  const nameOf = useNameResolver();
  const [people, setPeople] = useState(null);
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);   // { email, entities }
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');

  const load = useCallback(() => api.getAccountingAccess()
    .then((d) => { setPeople(d?.people || []); setError(''); })
    .catch((e) => { setPeople((p) => p || []); setError(e?.message || 'Could not load who has access.'); }), []);
  useEffect(() => {
    load();
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, [load]);
  useEffect(() => {
    if (!owner) return undefined;
    let alive = true;
    api.getPfsAccessPeople()
      .then((d) => { if (alive) setPfs(new Map((d?.people || []).map((p) => [p.email, p]))); })
      .catch(() => { if (alive) setPfs(null); });
    return () => { alive = false; };
  }, [owner]);
  const setPfsLevel = (email, level) => {
    setPfsError('');
    return api.setPfsAccessLevel(email, level)
      .then((row) => setPfs((m) => { const n = new Map(m); n.set(email, { ...(m.get(email) || {}), ...row }); return n; }))
      .catch((e) => setPfsError(e?.message || 'Could not change the PFS access.'));
  };
  // PFS access for people outside the Accounting list.
  const listed = useMemo(() => new Set((people || []).map((p) => p.email)), [people]);
  const pfsOnly = useMemo(() => (pfs ? [...pfs.values()].filter((p) => !listed.has(p.email) && (p.level !== 'none' || pfsExtra.includes(p.email))) : [])
    .map((p) => ({ ...p, name: p.name || nameOf(p.email) || p.email })).sort((a, b) => a.name.localeCompare(b.name, 'en-US')), [pfs, listed, pfsExtra, nameOf]);
  const pfsCandidates = useMemo(() => (pfs ? [...pfs.values()].filter((p) => !listed.has(p.email) && p.level === 'none' && !pfsExtra.includes(p.email)) : [])
    .map((p) => ({ ...p, name: p.name || nameOf(p.email) || p.email })).sort((a, b) => a.name.localeCompare(b.name, 'en-US')), [pfs, listed, pfsExtra, nameOf]);

  const names = useMemo(() => new Map(entities.map((e) => [e.code, e.name || e.code])), [entities]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (people || []).map((p) => ({ ...p, name: nameOf(p.email) || p.email }));
    list.sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
    return s ? list.filter((p) => p.name.toLowerCase().includes(s) || p.entities.some((c) => c.toLowerCase().includes(s) || (names.get(c) || '').toLowerCase().includes(s))) : list;
  }, [people, q, nameOf, names]);
  const limited = (people || []).filter((p) => p.entities.length).length;

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };

  return (
    <AsyncSection loading={people === null} skeleton={<SkeletonBlocks count={3} height={70} />}>
      <div style={{ ...card, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <h3 style={{ fontSize: '0.98rem', margin: 0 }}>Who Can Read Which Entities</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {(people || []).length} {(people || []).length === 1 ? 'person has' : 'people have'} Accounting access - {limited ? `${limited} limited to certain entities` : 'nobody is limited yet'}. Administrators always see everything.
            </div>
          </div>
          <div style={{ position: 'relative', width: 260, maxWidth: '100%' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person or an entity" aria-label="Search a person or an entity" style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </div>
          <button type="button" className="secondary-btn" onClick={() => setImporting(true)} title="Read who may see which entities in Intacct and set the same limits here"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }}>
            <Download size={13} /> Bring From Intacct
          </button>
        </div>
        {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem', marginBottom: 10 }}>{error}</div>}

        <div className="acct-lines-wrap">
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead>
              <tr><th scope="col">Person</th><th scope="col">Accounting Level</th><th scope="col">Entities</th>{pfs && <th scope="col">PFS</th>}<th scope="col">Last Opened</th><th scope="col" aria-label="Change" /></tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.email}>
                  <td style={{ fontWeight: 600 }}>{p.name}{!p.hasGrant && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · no longer has Accounting access</span>}</td>
                  <td>{LEVELS[p.level] || '-'}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {p.entities.length === 0 ? <span style={{ color: 'var(--text-secondary)' }}>All entities</span> : (
                      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                        {p.entities.map((c) => (
                          <span key={c} title={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, fontSize: '0.74rem', border: '1px solid var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}>
                            <Building2 size={11} /> {names.get(c) || c}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  {pfs && <td><PfsLevel row={pfs.get(p.email)} email={p.email} name={p.name} onSet={setPfsLevel} /></td>}
                  <td style={{ color: p.lastOpened ? undefined : 'var(--text-muted)' }} title={p.opens ? `${p.opens.toLocaleString('en-US')} ${p.opens === 1 ? 'visit' : 'visits'}` : undefined}>
                    {p.lastOpened ? `${formatDateTime(p.lastOpened)}${p.opens > 1 ? ` · ${p.opens.toLocaleString('en-US')} visits` : ''}` : 'Not yet'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {p.email === (myEmail || '').toLowerCase()
                      ? <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }} title="Someone else has to change your own access">You</span>
                      : <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '3px 10px' }} onClick={() => setEditing({ email: p.email, name: p.name, entities: p.entities })}>Change</button>}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr><td colSpan={pfs ? 6 : 5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px 10px', whiteSpace: 'normal' }}>
                  {(people || []).length ? 'Nobody matches that search.' : 'Nobody holds the Accounting grant yet. Grant it in Settings, then set entity limits here.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {pfsError && <div role="alert" style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem', marginTop: 10 }}>{pfsError}</div>}
        {pfs && (
          <section aria-label="PFS Access Without Accounting" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <h4 style={{ fontSize: '0.88rem', margin: 0 }}>PFS Access Without Accounting</h4>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2 }}>Personal financial statements open only for owners and the people given PFS access. A borrower does not see their own file without it.</div>
              </div>
              <select value="" aria-label="Give PFS Access to a Person" onChange={(e) => { const v = e.target.value; if (v) setPfsExtra((x) => [...x, v]); }} style={{ ...control, maxWidth: 280 }}>
                <option value="">Give PFS Access to a Person...</option>
                {pfsCandidates.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
              </select>
            </div>
            {pfsOnly.length > 0 ? (
              <div className="acct-lines-wrap">
                <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                  <thead><tr><th scope="col">Person</th><th scope="col">PFS</th></tr></thead>
                  <tbody>
                    {pfsOnly.map((p) => (
                      <tr key={p.email}><td style={{ fontWeight: 600 }}>{p.name}</td><td><PfsLevel row={p} email={p.email} name={p.name} onSet={setPfsLevel} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Nobody outside the list above has PFS access.</div>}
          </section>
        )}
        <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>A limit covers an entity and everything under it. A limited person works in Reports, Packages and MRI only: the dashboard tabs and the accounting app show consolidated figures, so they close. Every change is written to the audit log. Last Opened is when the person last opened any Accounting tab.</span>
        </div>
      </div>
      {editing && <EntityLimit person={editing} entities={entities} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {importing && <IntacctImport names={names} onClose={() => setImporting(false)} onApplied={() => { setImporting(false); load(); }} />}
    </AsyncSection>
  );
}

// One person's PFS access (owners only): None / Viewer / Editor; "Owner"
// for an owner (always sees PFS, never changed here); a grant from another
// group is shown as a note - it stays until that group changes.
function PfsLevel({ row, email, name, onSet }) {
  const [busy, setBusy] = useState(false);
  const r = row || { email, level: 'none', managedLevel: 'none', otherGroups: [], canChange: true };
  if (r.isOwner || r.level === 'owner') return <span style={{ fontWeight: 600 }}>Owner</span>;
  const other = (r.otherGroups || []).filter((g) => g.level && g.level !== 'none');
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <select value={r.managedLevel || 'none'} disabled={busy || r.canChange === false} aria-label={`PFS access for ${name}`}
        onChange={(e) => { setBusy(true); Promise.resolve(onSet(email, e.target.value)).finally(() => setBusy(false)); }}
        style={{ ...control, height: 26, fontSize: '0.76rem', width: 110 }}>
        {PFS_LEVELS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
      {other.length > 0 && (
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          Also {other.map((g) => `${LEVELS[g.level] || g.level} through ${g.name}`).join(', ')}
        </span>
      )}
    </div>
  );
}

// Entity access as Intacct has it, beside what Nexus has. Tick who to bring
// over; Apply sets their Nexus limit to the Intacct list.
function IntacctImport({ names, onClose, onApplied }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getAccountingAccessFromIntacct()
      .then((d) => { if (!alive) return; setData(d); setPicked(new Set((d?.people || []).filter((p) => p.matched && p.differs && !p.unknown).map((p) => p.email))); })
      .catch((e) => { if (alive) { setData({ people: [], notes: [] }); setError(e?.message || 'Could not read Intacct.'); } });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const people = data?.people || [];
  // A restricted Intacct user whose entity list could not be read is shown,
  // never ticked: applying would turn "restricted" into "every entity".
  const matched = people.filter((p) => p.matched && !p.unknown);
  const toggle = (email) => setPicked((s) => { const n = new Set(s); if (n.has(email)) n.delete(email); else n.add(email); return n; });
  const list = (codes) => (codes.length ? codes.map((c) => names.get(c) ? `${names.get(c)} (${c})` : c).join(', ') : 'All entities');
  const apply = () => {
    if (!picked.size || busy) return;
    setBusy(true);
    setError('');
    api.applyAccountingAccessFromIntacct([...picked])
      .then((r) => { setResult(r); setTimeout(onApplied, 1200); })
      .catch((e) => { setError(e?.message || 'Could not apply.'); setBusy(false); });
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Entity access from Intacct" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '96vw', width: 'min(1100px, 96vw)', maxHeight: '92vh' }}>
        <div className="modal-header" style={{ padding: '12px 18px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Entity Access From Intacct</h3>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Who may see which entities in Intacct, matched to Nexus people by email. Tick who to bring over; Apply sets their Nexus limit to the Intacct list. An unrestricted Intacct user gets every entity here too.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '6px 18px 10px', display: 'grid', gap: 8 }}>
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{error}</div>}
          {(data?.notes || []).map((n) => <div key={n} style={{ fontSize: '0.78rem', color: '#92400e' }}>{n}</div>)}
          {!data && !error && <SkeletonBlocks count={4} />}
          {data && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                <span>{people.length} Intacct {people.length === 1 ? 'user' : 'users'} · {matched.length} matched to Nexus people · {picked.size} ticked</span>
                {matched.length > 0 && (
                  <button type="button" onClick={() => setPicked(picked.size === matched.length ? new Set() : new Set(matched.map((p) => p.email)))}
                    style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.76rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', padding: 0 }}>
                    {picked.size === matched.length ? 'Clear All' : 'Select All Matched'}
                  </button>
                )}
              </div>
              <div className="acct-lines-wrap" style={{ maxHeight: 'calc(92vh - 240px)' }}>
                <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                  <thead>
                    <tr><th scope="col" aria-label="Pick" style={{ width: 30 }} /><th scope="col">Intacct User</th><th scope="col">Nexus Person</th><th scope="col">In Intacct</th><th scope="col">In Nexus Now</th></tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={`${p.login}-${p.email}`} style={{ opacity: p.matched ? 1 : 0.6 }}>
                        <td>{p.matched && !p.unknown ? <input type="checkbox" aria-label={`Bring ${p.name || p.intacctName}`} checked={picked.has(p.email)} onChange={() => toggle(p.email)} /> : null}</td>
                        <td title={p.email || undefined}>{p.intacctName || p.login}{p.login && p.intacctName ? <span className="acct-code" style={{ marginLeft: 8 }}>{p.login}</span> : null}{p.status && !/active/i.test(p.status) ? <span style={{ marginLeft: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{p.status}</span> : null}</td>
                        <td>{p.matched ? <>{p.name}{!p.hasGrant && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · no Accounting access yet</span>}</> : <span style={{ color: 'var(--text-muted)' }}>{p.email ? 'Not in Nexus People' : 'No email in Intacct'}</span>}</td>
                        <td style={{ whiteSpace: 'normal', maxWidth: 360, fontWeight: p.differs ? 600 : 400 }}>
                          {p.unknown
                            ? <span style={{ color: 'var(--bad-fg, #dc2626)', fontWeight: 600 }} title="Intacct says this user is restricted, but the connection's login may not read which entities. Grant it the User Restrictions permission in Intacct and open this again.">Restricted - entities not readable</span>
                            : list(p.entities)}
                          {p.departments?.length ? <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Departments in Intacct: {p.departments.join(', ')} (not carried over)</span> : null}
                        </td>
                        <td style={{ whiteSpace: 'normal', maxWidth: 360, color: p.matched ? undefined : 'var(--text-muted)' }}>{p.matched ? list(p.current) : '-'}{p.matched && !p.differs ? <span style={{ marginLeft: 6, fontSize: '0.72rem', color: 'var(--ok-fg, #15803d)' }}>Same</span> : null}</td>
                      </tr>
                    ))}
                    {!people.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '18px 10px' }}>Intacct returned no users.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {result && <div role="status" style={{ fontSize: '0.8rem', color: 'var(--ok-fg, #15803d)' }}>{result.applied.length} {result.applied.length === 1 ? 'person' : 'people'} now limited as Intacct has them.</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={apply} disabled={!picked.size || busy || !!result}>{busy ? 'Applying...' : `Apply to ${picked.size || ''} ${picked.size === 1 ? 'Person' : 'People'}`.replace('  ', ' ')}</button>
        </div>
      </div>
    </div>
  );
}

function EntityLimit({ person, entities, onClose, onSaved }) {
  const [mode, setMode] = useState(person.entities.length ? 'some' : 'all');
  const [picked, setPicked] = useState(() => new Set(person.entities));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showHistorical, setShowHistorical] = useState(false);
  const options = useMemo(() => entityOptions(entities, { showHistorical, keep: [...picked] }), [entities, showHistorical, picked]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.code.toLowerCase().includes(s) || (o.name || '').toLowerCase().includes(s)) : options;
  }, [options, q]);
  // Select All ticks every entity on the list (what a search narrowed it to, when one is typed).
  const allShown = shown.length > 0 && shown.every((o) => picked.has(o.code));
  const selectAll = () => setPicked((p) => { const n = new Set(p); if (allShown) shown.forEach((o) => n.delete(o.code)); else shown.forEach((o) => n.add(o.code)); return n; });
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const toggle = (code) => setPicked((p) => { const n = new Set(p); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const save = () => {
    if (busy || (mode === 'some' && !picked.size)) return;
    setBusy(true);
    setError('');
    api.setAccountingAccess(person.email, mode === 'all' ? [] : [...picked])
      .then(onSaved)
      .catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  const choice = (on) => ({ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' });
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={`Entities ${person.name} can read`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Entities {person.name} Can Read</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>Applies to reports, search, drill-downs and journal entries.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 8 }}>
          <label style={choice(mode === 'all')}>
            <input type="radio" name="acct-limit" checked={mode === 'all'} onChange={() => setMode('all')} style={{ marginTop: 3 }} />
            <span><strong style={{ fontSize: '0.86rem' }}>All entities</strong><br /><span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>Everything on the ledger, the dashboard tabs and the accounting app.</span></span>
          </label>
          <label style={choice(mode === 'some')}>
            <input type="radio" name="acct-limit" checked={mode === 'some'} onChange={() => setMode('some')} style={{ marginTop: 3 }} />
            <span><strong style={{ fontSize: '0.86rem' }}>Only the entities picked below</strong><br /><span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>Reports, Packages and MRI only. The dashboard tabs and the accounting app close for this person.</span></span>
          </label>
          {mode === 'some' && (
            <div>
              <div style={{ position: 'relative' }}>
                <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
                <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search entity by name or code" aria-label="Search entity by name or code" autoFocus style={{ ...control, width: '100%', paddingLeft: 26 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 6 }}>
                <button type="button" onClick={selectAll} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.76rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', padding: 0 }}>
                  {allShown ? 'Clear All' : q.trim() ? 'Select All Shown' : 'Select All'}
                </button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showHistorical} onChange={(e) => setShowHistorical(e.target.checked)} /> Show historical (H) entities
                </label>
              </div>
              <div role="listbox" aria-multiselectable="true" aria-label="Entities" style={{ maxHeight: 'min(520px, calc(100vh - 420px))', overflowY: 'auto', marginTop: 6, border: '1px solid var(--border-color)', borderRadius: 8, padding: 4, display: 'grid', gap: 1 }}>
                {shown.map((o) => {
                  const on = picked.has(o.code);
                  return (
                    <button key={o.code} type="button" role="option" aria-selected={on} onClick={() => toggle(o.code)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '5px 8px', font: 'inherit', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                      <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{on ? <Check size={14} /> : null}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: o.depth ? 14 : 0 }}>{o.name || o.code}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{o.code}</span>
                    </button>
                  );
                })}
                {!shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 8 }}>No entity matches.</div>}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>{picked.size} picked. Picking an entity includes everything under it.</div>
            </div>
          )}
          {error && <div style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={busy || (mode === 'some' && !picked.size)}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
