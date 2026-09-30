import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Check, Search, ShieldCheck, X } from 'lucide-react';
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

const LEVELS = { viewer: 'Viewer', editor: 'Editor', full: 'Full', owner: 'Owner' };

export default function AccessTab() {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();
  const [people, setPeople] = useState(null);
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);   // { email, entities }
  const [q, setQ] = useState('');

  const load = useCallback(() => api.getAccountingAccess()
    .then((d) => { setPeople(d?.people || []); setError(''); })
    .catch((e) => { setPeople((p) => p || []); setError(e?.message || 'Could not load who has access.'); }), []);
  useEffect(() => {
    load();
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, [load]);

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
        </div>
        {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem', marginBottom: 10 }}>{error}</div>}

        <div className="acct-lines-wrap">
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead>
              <tr><th scope="col">Person</th><th scope="col">Accounting Level</th><th scope="col">Entities</th><th scope="col">Last Opened</th><th scope="col" aria-label="Change" /></tr>
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
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px 10px', whiteSpace: 'normal' }}>
                  {(people || []).length ? 'Nobody matches that search.' : 'Nobody holds the Accounting grant yet. Grant it in Settings, then set entity limits here.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>A limit covers an entity and everything under it. A limited person works in Reports, Packages and MRI only: the dashboard tabs and the accounting app show consolidated figures, so they close. Every change is written to the audit log. Last Opened is when the person last opened any Accounting tab.</span>
        </div>
      </div>
      {editing && <EntityLimit person={editing} entities={entities} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </AsyncSection>
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
