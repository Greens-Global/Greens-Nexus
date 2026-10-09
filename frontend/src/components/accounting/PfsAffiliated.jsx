import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { EntityPicker, control } from './reportControls';
import { pctText, rolesOf } from './pfsAffiliatedExport';
import { isLockedError } from './PfsLock';

// Accounting -> PFS -> Affiliated Entities (Charmi, 10/04): "list all entities
// that are joint and several between the 2 borrowers - the banker wants
// ownership and beneficial ownership interest in all entities: single member
// LLC, partnerships, multi-member LLC, corporations, trusts, etc."
//
// One row per entity: its name and type, each borrower's ownership percent
// and role, the beneficial ownership percent and a note. A name can be picked
// from the ledger's entities. Rows keep the order they are put in (arrows
// move them) and print in that order on the PDF and the Excel workbook
// (pfsAffiliatedExport.js). Kept per statement file, server side
// (routers/pfs_affiliates.py).
//
// Oct 7 (Neil/Charmi): a role PER BORROWER ("Neil may be a managing member,
// but Archana is not"), set beside that borrower's ownership %; EIN and State
// are no longer asked for or shown (still kept on the row); an empty percent
// reads "-"; Prefill From the Ledger is the module's entity picker - search
// by name or number, historical (H) entities left out.
//
// Also here: the Executive Profiles section of History and Profile - one box
// per borrower, each headed with the person's name (Oct 7, item 15).

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const FALLBACK_META = {
  entityTypes: [
    { key: 'single_member_llc', label: 'Single-Member LLC' }, { key: 'multi_member_llc', label: 'Multi-Member LLC' },
    { key: 'general_partnership', label: 'General Partnership' }, { key: 'limited_partnership', label: 'Limited Partnership' },
    { key: 'c_corporation', label: 'C Corporation' }, { key: 's_corporation', label: 'S Corporation' }, { key: 'trust', label: 'Trust' }, { key: 'other', label: 'Other' },
  ],
  roles: ['Member', 'Manager', 'Managing Member', 'Partner', 'General Partner', 'Limited Partner', 'Shareholder', 'Officer', 'Trustee', 'Beneficiary'],
};
const EMPTY = { name: '', entityType: 'single_member_llc', ownership: {}, roles: {}, beneficialPct: '', notes: '', ledgerEntity: '' };

export default function PfsAffiliated({ profile, canEdit = false, onLocked }) {
  const [data, setData] = useState(null);       // { borrowers, rows }
  const [meta, setMeta] = useState(FALLBACK_META);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState('');
  const fail = useCallback((e, fallback) => {
    if (isLockedError(e)) { onLocked?.(profile.id); return; }
    setError(e?.message || fallback);
  }, [onLocked, profile.id]);
  const load = useCallback(() => api.getPfsAffiliates(profile.id)
    .then((d) => setData({ borrowers: d?.borrowers || [], rows: d?.rows || [] }))
    .catch((e) => { setData((x) => x || { borrowers: [], rows: [] }); fail(e, 'Could not load the affiliated entities.'); }), [profile.id, fail]);
  useEffect(() => { load(); }, [load]);   // keyed by the file (PfsTab), so a new file starts empty
  useEffect(() => { api.getPfsAffiliatesMeta().then((m) => m?.entityTypes && setMeta(m)).catch(() => {}); }, []);

  const borrowers = data?.borrowers?.length ? data.borrowers : [{ key: 'primary', name: profile.name }];
  const rows = data?.rows || [];
  const move = (i, by) => {
    const ids = rows.map((r) => r.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setData((d) => ({ ...d, rows: ids.map((id) => rows.find((r) => r.id === id)) }));
    api.reorderPfsAffiliates(profile.id, ids).then((r) => setData((d) => ({ ...d, rows: r?.rows || d.rows }))).catch((e) => { fail(e, 'Could not move the entity.'); load(); });
  };
  const remove = (r) => api.deletePfsAffiliate(profile.id, r.id).then(load).catch((e) => fail(e, 'Could not remove the entity.'));

  if (!data) return <SkeletonBlocks count={2} />;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <strong style={{ fontSize: '0.9rem' }}>Affiliated Entities</strong>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Every entity {borrowers.length > 1 ? 'the borrowers hold' : 'the borrower holds'} an interest in - LLCs, partnerships, corporations, trusts - with each borrower's ownership and role, and the beneficial ownership. Printed on the statement in this order; a ledger line of a listed entity takes its share from here.
            </div>
          </div>
          {canEdit && (
            <button type="button" className="primary-btn" onClick={() => setEditing({ ...EMPTY })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
              <Plus size={14} /> Add Entity
            </button>
          )}
        </div>
        {error && <div style={bad}>{error}</div>}
        {!rows.length && <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>No affiliated entities listed yet.{canEdit ? ' Add Entity lists one; a name can be picked from the ledger.' : ''}</div>}
        {rows.length > 0 && (
          <div className="acct-lines-wrap" style={{ maxHeight: 'none' }}>
            <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
              <thead>
                <tr>
                  <th scope="col">Entity Name</th><th scope="col">Entity Type</th>
                  {borrowers.map((b) => [
                    <th key={`${b.key}-pct`} scope="col" className="acct-num">{b.name} %</th>,
                    <th key={`${b.key}-role`} scope="col">{b.name} Role</th>,
                  ])}
                  <th scope="col" className="acct-num">Beneficial %</th><th scope="col">Notes</th>
                  {canEdit && <th scope="col" aria-label="Change" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const roles = rolesOf(r);
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.ledgerEntity ? <span className="acct-code" style={{ marginLeft: 8 }}>{r.ledgerEntity}</span> : null}</td>
                      <td>{r.entityTypeLabel}</td>
                      {borrowers.map((b) => [
                        <td key={`${b.key}-pct`} className="acct-num">{pctText(r.ownership?.[b.key])}</td>,
                        <td key={`${b.key}-role`}>{roles[b.key] || <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>,
                      ])}
                      <td className="acct-num">{pctText(r.beneficialPct)}</td>
                      <td style={{ color: 'var(--text-secondary)', maxWidth: 260 }}>{r.notes}</td>
                      {canEdit && (
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {confirm === r.id ? (
                            <>
                              <button type="button" className="acct-drill" style={{ color: 'var(--bad-fg, #dc2626)', marginRight: 10 }} onClick={() => { setConfirm(''); remove(r); }}>Remove</button>
                              <button type="button" className="acct-drill" onClick={() => setConfirm('')}>Keep</button>
                            </>
                          ) : (
                            <>
                              <button type="button" style={icon} aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                              <button type="button" style={icon} aria-label={`Move ${r.name} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                              <button type="button" style={icon} aria-label={`Change ${r.name}`} onClick={() => setEditing({ ...EMPTY, ...r, roles: roles, beneficialPct: r.beneficialPct ?? '' })}><Pencil size={14} /></button>
                              <button type="button" style={icon} aria-label={`Remove ${r.name}`} onClick={() => setConfirm(r.id)}><Trash2 size={14} /></button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <AffiliateEditor row={editing} borrowers={borrowers} meta={meta} onClose={() => setEditing(null)}
          onSave={(body) => (editing.id ? api.updatePfsAffiliate(profile.id, editing.id, body) : api.addPfsAffiliate(profile.id, body))
            .then(() => { setEditing(null); return load(); })
            .catch((e) => { if (isLockedError(e)) { setEditing(null); onLocked?.(profile.id); return undefined; } throw e; })} />
      )}
    </div>
  );
}

function AffiliateEditor({ row, borrowers, meta, onClose, onSave }) {
  const [r, setR] = useState(row);
  const [entities, setEntities] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (p) => setR((x) => ({ ...x, ...p }));
  useEffect(() => {
    api.getPfsLedgerEntities().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pctBad = (v) => v !== '' && v != null && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100);
  const invalid = !r.name.trim() || borrowers.some((b) => pctBad(r.ownership?.[b.key])) || pctBad(r.beneficialPct);
  const save = (e) => {
    e.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError('');
    const ownership = {};
    const roles = {};
    borrowers.forEach((b) => {
      const v = r.ownership?.[b.key];
      if (v !== '' && v != null) ownership[b.key] = Number(v);
      const role = (r.roles?.[b.key] || '').trim();
      if (role) roles[b.key] = role;
    });
    onSave({
      name: r.name.trim(), entityType: r.entityType, ownership, roles, role: roles.primary || '',
      beneficialPct: r.beneficialPct === '' || r.beneficialPct == null ? null : Number(r.beneficialPct), notes: r.notes || '', ledgerEntity: r.ledgerEntity || '',
    }).catch((err) => { setError(err?.message || 'Could not save.'); setBusy(false); });
  };
  const pickEntity = (code) => {
    const e = (entities || []).find((x) => x.code === code);
    if (e) set({ name: e.name || e.code, ledgerEntity: e.code });
    else set({ ledgerEntity: '' });
  };
  const field = (id, text, input) => (<div><label style={label} htmlFor={id}>{text}</label>{input}</div>);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form className="modal-content" role="dialog" aria-modal="true" aria-label={row.id ? `Change ${row.name}` : 'Add an affiliated entity'} onClick={(e) => e.stopPropagation()} onSubmit={save} style={{ maxWidth: 680 }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{row.id ? 'Change Entity' : 'Add Entity'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          <div>
            <span style={label}>Prefill From the Ledger</span>
            {entities === null ? <SkeletonBlocks count={1} height={30} /> : (
              <EntityPicker entities={entities} value={r.ledgerEntity || ''} onChange={pickEntity} ariaLabel="Prefill From the Ledger"
                noneLabel="Not Linked to the Ledger" style={{ width: '100%', maxWidth: 'none' }} />
            )}
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Search by name or entity number, or type a name below.</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            {field('pfs-aff-name', 'Entity Name', <input id="pfs-aff-name" type="text" value={r.name} maxLength={160} autoFocus onChange={(e) => set({ name: e.target.value })} style={{ ...control, width: '100%' }} />)}
            {field('pfs-aff-type', 'Entity Type', (
              <select id="pfs-aff-type" value={r.entityType} onChange={(e) => set({ entityType: e.target.value })} style={{ ...control, width: '100%' }}>
                {meta.entityTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            ))}
          </div>
          {/* Oct 7 (Neil): each borrower's ownership and role side by side. */}
          {borrowers.map((b) => {
            const role = r.roles?.[b.key] || '';
            return (
              <fieldset key={b.key} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '8px 12px 10px', margin: 0 }}>
                <legend style={{ fontSize: '0.78rem', fontWeight: 700, padding: '0 4px' }}>{b.name}</legend>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 1fr) minmax(160px, 2fr)', gap: 10 }}>
                  <div>
                    <label style={label} htmlFor={`pfs-aff-own-${b.key}`}>Ownership %</label>
                    <input id={`pfs-aff-own-${b.key}`} type="number" min="0" max="100" step="0.01" aria-label={`${b.name} Ownership %`} value={r.ownership?.[b.key] ?? ''}
                      onChange={(e) => set({ ownership: { ...(r.ownership || {}), [b.key]: e.target.value } })} style={{ ...control, width: '100%' }} />
                  </div>
                  <div>
                    <label style={label} htmlFor={`pfs-aff-role-${b.key}`}>Role</label>
                    <select id={`pfs-aff-role-${b.key}`} aria-label={`${b.name} Role`} value={role} onChange={(e) => set({ roles: { ...(r.roles || {}), [b.key]: e.target.value } })} style={{ ...control, width: '100%' }}>
                      <option value="">Not Set</option>
                      {meta.roles.map((x) => <option key={x} value={x}>{x}</option>)}
                      {role && !meta.roles.includes(role) && <option value={role}>{role}</option>}
                    </select>
                  </div>
                </div>
              </fieldset>
            );
          })}
          <div style={{ maxWidth: 220 }}>
            <label style={label} htmlFor="pfs-aff-ben">Beneficial Ownership %</label>
            <input id="pfs-aff-ben" type="number" min="0" max="100" step="0.01" value={r.beneficialPct ?? ''} onChange={(e) => set({ beneficialPct: e.target.value })} style={{ ...control, width: '100%' }} />
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>When set, it is the statement's share of this entity; otherwise the borrowers' percents add up.</div>
          </div>
          {field('pfs-aff-notes', 'Notes', <input id="pfs-aff-notes" type="text" value={r.notes || ''} maxLength={400} onChange={(e) => set({ notes: e.target.value })} style={{ ...control, width: '100%' }} />)}
          {invalid && r.name.trim() && <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>Percents are between 0 and 100.</div>}
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={invalid || busy}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

/** Executive Profiles (Oct 7, item 15): one box per borrower, each headed
 * with the person's name - side by side on a wide screen, stacked on a narrow
 * one - and one Save Changes for the section. Both are kept through the
 * executive-profiles endpoint (key primary | co) and print after each other. */
export function PfsExecutiveProfiles({ profile, canEdit = false, onLocked, onSaved }) {
  const [saved, setSaved] = useState(null);      // [{ key, name, text }] from the server
  const [texts, setTexts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getPfsExecutiveProfiles(profile.id)
      .then((r) => {
        if (!alive) return;
        const list = r?.profiles?.length ? r.profiles : [{ key: 'primary', name: profile.name, text: profile.executiveProfile || '' }];
        setSaved(list);
        setTexts((t) => Object.fromEntries(list.map((p) => [p.key, t[p.key] ?? p.text ?? ''])));   // never over what is being typed
      })
      .catch((e) => {
        if (!alive) return;
        if (isLockedError(e)) onLocked?.(profile.id); else setError(e?.message || 'Could not load the profiles.');
        setSaved([{ key: 'primary', name: profile.name, text: profile.executiveProfile || '' }]);
        setTexts((t) => ({ primary: t.primary ?? profile.executiveProfile ?? '' }));
      });
    return () => { alive = false; };
  }, [profile.id, profile.name, profile.executiveProfile, onLocked]);
  if (!saved) return <SkeletonBlocks count={1} height={120} />;
  const changed = saved.filter((p) => (texts[p.key] ?? '') !== (p.text || ''));
  const save = async () => {
    if (!changed.length || busy) return;
    setBusy(true);
    setError('');
    setDone(false);
    try {
      let last = null;
      for (const p of changed) last = await api.savePfsExecutiveProfile(profile.id, p.key, texts[p.key] ?? '');
      const list = last?.profiles?.length ? last.profiles : saved.map((p) => ({ ...p, text: texts[p.key] ?? '' }));
      setSaved(list.map((p) => ({ ...p, text: changed.some((c) => c.key === p.key) ? (texts[p.key] ?? '') : p.text })));
      setDone(true);
      onSaved?.();
    } catch (e) {
      if (isLockedError(e)) onLocked?.(profile.id); else setError(e?.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Executive Profiles" style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <strong style={{ fontSize: '0.9rem' }}>Executive Profiles</strong>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2 }}>One for each borrower: who they are, what they have built, and their history with lenders. Each prints under the person's name.</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        {saved.map((p) => (
          <div key={p.key}>
            <label style={{ ...label, fontSize: '0.8rem', color: 'var(--text-primary)' }} htmlFor={`pfs-exec-${p.key}`}>{p.name || (p.key === 'co' ? 'Co-Borrower' : profile.name)}</label>
            <textarea id={`pfs-exec-${p.key}`} aria-label={`Executive Profile - ${p.name}`} value={texts[p.key] ?? ''} disabled={!canEdit} maxLength={6000} rows={9}
              onChange={(e) => { const v = e.target.value; setTexts((t) => ({ ...t, [p.key]: v })); setDone(false); }}
              placeholder="Who they are, what they have built, and their history with lenders."
              style={{ ...control, width: '100%', height: 'auto', padding: 9, lineHeight: 1.5, resize: 'vertical' }} />
          </div>
        ))}
      </div>
      {error && <div style={bad}>{error}</div>}
      {done && !changed.length && <div style={{ fontSize: '0.78rem', color: 'hsl(var(--color-green))', fontWeight: 600 }}>Saved.</div>}
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="primary-btn" onClick={save} disabled={!changed.length || busy} style={{ fontSize: '0.8rem' }}>{busy ? 'Saving...' : 'Save Profiles'}</button>
          {changed.length > 0 && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>}
        </div>
      )}
    </section>
  );
}
