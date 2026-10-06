import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { control } from './reportControls';
import { isLockedError } from './PfsLock';

// Accounting -> PFS -> Affiliated Entities (Charmi, 10/04): "list all entities
// that are joint and several between the 2 borrowers - the banker wants
// ownership and beneficial ownership interest in all entities: single member
// LLC, partnerships, multi-member LLC, corporations, trusts, etc."
//
// One row per entity: its name and type, the last four digits of its EIN
// (never more - the server refuses a longer number), its state, each
// borrower's ownership percent, the beneficial ownership percent, the role
// and a note. A name can be picked from the ledger's entities. Rows keep the
// order they are put in (arrows move them) and print in that order on the PDF
// and the Excel workbook (pfsAffiliatedExport.js). Kept per statement file, server
// side (routers/pfs_affiliates.py).
//
// Also here: the co-borrower's executive profile (Charmi, 10/04: "Executive
// profile should be there for both borrowers"), saved on its own.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const FALLBACK_META = {
  entityTypes: [
    { key: 'single_member_llc', label: 'Single-Member LLC' }, { key: 'multi_member_llc', label: 'Multi-Member LLC' },
    { key: 'general_partnership', label: 'General Partnership' }, { key: 'limited_partnership', label: 'Limited Partnership' },
    { key: 'c_corporation', label: 'C Corporation' }, { key: 's_corporation', label: 'S Corporation' }, { key: 'trust', label: 'Trust' }, { key: 'other', label: 'Other' },
  ],
  roles: ['Member', 'Manager', 'Managing Member', 'Partner', 'General Partner', 'Limited Partner', 'Shareholder', 'Officer', 'Trustee', 'Beneficiary'],
};
const pctText = (n) => (n == null || n === '' ? '' : `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);
const EMPTY = { name: '', entityType: 'single_member_llc', einLast4: '', state: '', ownership: {}, beneficialPct: '', role: '', notes: '', ledgerEntity: '' };

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
              Every entity {borrowers.length > 1 ? 'the borrowers hold' : 'the borrower holds'} an interest in - LLCs, partnerships, corporations, trusts - with each borrower's ownership and the beneficial ownership. Printed on the statement in this order.
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
                  <th scope="col">Entity Name</th><th scope="col">Entity Type</th><th scope="col">EIN (Last 4)</th><th scope="col">State</th>
                  {borrowers.map((b) => <th key={b.key} scope="col" className="acct-num">{b.name} %</th>)}
                  <th scope="col" className="acct-num">Beneficial %</th><th scope="col">Role</th><th scope="col">Notes</th>
                  {canEdit && <th scope="col" aria-label="Change" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.name}{r.ledgerEntity ? <span className="acct-code" style={{ marginLeft: 8 }}>{r.ledgerEntity}</span> : null}</td>
                    <td>{r.entityTypeLabel}</td>
                    <td>{r.einLast4 ? `XX-XXX${r.einLast4}` : ''}</td>
                    <td>{r.state}</td>
                    {borrowers.map((b) => <td key={b.key} className="acct-num">{pctText(r.ownership?.[b.key])}</td>)}
                    <td className="acct-num">{pctText(r.beneficialPct)}</td>
                    <td>{r.role}</td>
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
                            <button type="button" style={icon} aria-label={`Change ${r.name}`} onClick={() => setEditing({ ...EMPTY, ...r, beneficialPct: r.beneficialPct ?? '' })}><Pencil size={14} /></button>
                            <button type="button" style={icon} aria-label={`Remove ${r.name}`} onClick={() => setConfirm(r.id)}><Trash2 size={14} /></button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
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
    borrowers.forEach((b) => { const v = r.ownership?.[b.key]; if (v !== '' && v != null) ownership[b.key] = Number(v); });
    onSave({
      name: r.name.trim(), entityType: r.entityType, einLast4: r.einLast4 || '', state: r.state || '', ownership,
      beneficialPct: r.beneficialPct === '' || r.beneficialPct == null ? null : Number(r.beneficialPct), role: r.role || '', notes: r.notes || '', ledgerEntity: r.ledgerEntity || '',
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
      <form className="modal-content" role="dialog" aria-modal="true" aria-label={row.id ? `Change ${row.name}` : 'Add an affiliated entity'} onClick={(e) => e.stopPropagation()} onSubmit={save} style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{row.id ? 'Change Entity' : 'Add Entity'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          {field('pfs-aff-ledger', 'Prefill From the Ledger', (
            <select id="pfs-aff-ledger" value={r.ledgerEntity || ''} onChange={(e) => pickEntity(e.target.value)} style={{ ...control, width: '100%' }}>
              <option value="">{entities ? 'Pick an entity, or type a name below...' : 'Loading...'}</option>
              {(entities || []).map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
            </select>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            {field('pfs-aff-name', 'Entity Name', <input id="pfs-aff-name" type="text" value={r.name} maxLength={160} autoFocus onChange={(e) => set({ name: e.target.value })} style={{ ...control, width: '100%' }} />)}
            {field('pfs-aff-type', 'Entity Type', (
              <select id="pfs-aff-type" value={r.entityType} onChange={(e) => set({ entityType: e.target.value })} style={{ ...control, width: '100%' }}>
                {meta.entityTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <div>
              <label style={label} htmlFor="pfs-aff-ein">EIN - Last 4 Digits</label>
              <input id="pfs-aff-ein" type="text" inputMode="numeric" value={r.einLast4 || ''} maxLength={4} placeholder="Optional"
                onChange={(e) => set({ einLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Never the full number.</div>
            </div>
            {field('pfs-aff-state', 'State', (
              <>
                <input id="pfs-aff-state" type="text" list="pfs-aff-states" value={r.state || ''} maxLength={40} onChange={(e) => set({ state: e.target.value })} style={{ ...control, width: '100%' }} />
                <datalist id="pfs-aff-states">{US_STATES.map((s) => <option key={s} value={s} />)}</datalist>
              </>
            ))}
            {field('pfs-aff-role', 'Role', (
              <select id="pfs-aff-role" value={r.role || ''} onChange={(e) => set({ role: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="">Not set</option>
                {meta.roles.map((x) => <option key={x} value={x}>{x}</option>)}
                {r.role && !meta.roles.includes(r.role) && <option value={r.role}>{r.role}</option>}
              </select>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {borrowers.map((b) => (
              <div key={b.key}>
                <label style={label} htmlFor={`pfs-aff-own-${b.key}`}>{b.name} - Ownership %</label>
                <input id={`pfs-aff-own-${b.key}`} type="number" min="0" max="100" step="0.01" value={r.ownership?.[b.key] ?? ''}
                  onChange={(e) => set({ ownership: { ...(r.ownership || {}), [b.key]: e.target.value } })} style={{ ...control, width: '100%' }} />
              </div>
            ))}
            <div>
              <label style={label} htmlFor="pfs-aff-ben">Beneficial Ownership %</label>
              <input id="pfs-aff-ben" type="number" min="0" max="100" step="0.01" value={r.beneficialPct ?? ''} onChange={(e) => set({ beneficialPct: e.target.value })} style={{ ...control, width: '100%' }} />
            </div>
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

/** The co-borrower's executive profile, under the borrower's on the History
 * and Profile tab - one per borrower, each saved on its own. Shown when the
 * statement has a co-borrower (or spouse), or is a joint statement. */
export function PfsCoExecutiveProfile({ profile, canEdit = false, onLocked }) {
  const d = profile?.details || {};
  const coName = (d.coBorrower?.name || d.spouse || '').trim();
  const shown = !!coName || profile?.kind === 'joint';
  const [saved, setSaved] = useState(null);     // { name, text } from the server
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!shown) return undefined;
    let alive = true;
    api.getPfsExecutiveProfiles(profile.id)
      .then((r) => {
        if (!alive) return;
        const co = (r?.profiles || []).find((p) => p.key === 'co') || { name: coName || 'Co-Borrower', text: '' };
        setSaved({ name: co.name, text: co.text || '' });
        setText((t) => t || co.text || '');   // never over what is being typed
      })
      .catch((e) => { if (!alive) return; if (isLockedError(e)) onLocked?.(profile.id); else setError(e?.message || 'Could not load the profile.'); setSaved({ name: coName || 'Co-Borrower', text: '' }); });
    return () => { alive = false; };
  }, [profile.id, shown, coName, onLocked]);
  if (!shown) return null;
  if (!saved) return <SkeletonBlocks count={1} />;
  const save = () => {
    setBusy(true);
    setError('');
    setDone(false);
    api.savePfsExecutiveProfile(profile.id, 'co', text)
      .then((r) => { const co = (r?.profiles || []).find((p) => p.key === 'co'); setSaved({ name: co?.name || saved.name, text: co?.text ?? text }); setDone(true); })
      .catch((e) => { if (isLockedError(e)) onLocked?.(profile.id); else setError(e?.message || 'Could not save.'); })
      .finally(() => setBusy(false));
  };
  const dirty = text !== saved.text;
  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <label style={label} htmlFor="pfs-exec-co">Executive Profile - {saved.name || coName || 'Co-Borrower'}</label>
        <textarea id="pfs-exec-co" value={text} disabled={!canEdit} maxLength={6000} rows={7} onChange={(e) => { setText(e.target.value); setDone(false); }}
          placeholder="Who they are, what they have built, and their history with lenders."
          style={{ ...control, width: '100%', height: 'auto', padding: 9, lineHeight: 1.5, resize: 'vertical' }} />
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>The co-borrower's own profile, saved separately and printed after the borrower's.</div>
      </div>
      {error && <div style={bad}>{error}</div>}
      {done && !dirty && <div style={{ fontSize: '0.78rem', color: 'hsl(var(--color-green))', fontWeight: 600 }}>Saved.</div>}
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy} style={{ fontSize: '0.8rem' }}>{busy ? 'Saving...' : `Save ${(saved.name || 'Co-Borrower').split(' ')[0]}'s Profile`}</button>
          {dirty && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}
