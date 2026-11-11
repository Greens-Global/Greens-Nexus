import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Archive, RotateCcw, Plus } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { SkeletonBlocks } from './AsyncState';
import { SettingRow, SwitchRow } from './settings/SettingsUI';

// Settings > People & Access > Licenses & Certifications (Neil, 11/11/2026,
// Deputy parity - "training modules"): the kinds of license or
// certification people hold - Driver's License, Forklift Certification,
// OSHA 10, CPR / First Aid. At "Every company" the ones every company uses;
// with a company picked, that company's own. HR adds a person's records on
// their Job tab; a shift type can need one (Shifts > Settings > Shift Types).
// A type is archived, never deleted: its records keep their name.

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

function describe(t) {
  const bits = [];
  bits.push(!t.expires ? 'Does not expire' : t.validityMonths ? `Good for ${t.validityMonths} months` : 'Expires - date per person');
  bits.push(`${t.inUse || 0} ${t.inUse === 1 ? 'person holds it' : 'on file'}`);
  if (t.description) bits.push(t.description);
  return bits.join(' · ');
}

function TypeEditor({ type, company, companyName, onClose, onSaved, toastErr }) {
  const start = useMemo(() => ({
    name: type?.name || '', description: type?.description || '',
    expires: type ? !!type.expires : true, validityMonths: String(type?.validityMonths || ''),
  }), [type]);
  const [f, setF] = useState(start);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((m) => ({ ...m, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const months = Number(f.validityMonths || 0);
  const problem = !f.name.trim() ? 'Give it a name.'
    : (!Number.isInteger(months) || months < 0 || months > 240) ? 'Good for is a whole number of months, 0 to 240.' : '';

  async function save() {
    if (problem) { toastErr?.(problem); return; }
    setBusy(true);
    const body = { name: f.name.trim(), description: f.description.trim(), expires: !!f.expires, validityMonths: f.expires ? months : 0 };
    try {
      const saved = type ? await api.updateHrCredentialType(type.id, body)
        : await api.createHrCredentialType({ ...body, companyId: company || '' });
      onSaved(saved, !type);
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  const footer = (
    <>
      {problem && <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 'auto' }}>{problem}</span>}
      <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="primary-btn" onClick={save} disabled={busy || !!problem || (type && !dirty)}>{busy ? 'Saving…' : type ? 'Save' : 'Add'}</button>
    </>
  );
  return (
    <Modal title={type ? `Edit ${type.name}` : 'Add License or Certification'} onClose={onClose} footer={footer} isDirty={dirty} onSave={save}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {type ? 'Records already on file keep their dates.' : <>For {company ? `${companyName || 'this company'}'s people` : 'everyone in every company'}.</>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div>
            <label style={FL} htmlFor="ctx-name">Name</label>
            <input id="ctx-name" className="form-input" style={{ width: '100%' }} value={f.name} maxLength={80}
              onChange={(e) => set('name', e.target.value)} placeholder="e.g. Forklift Certification" autoFocus />
          </div>
          <div>
            <label style={FL} htmlFor="ctx-months">Good For (Months)</label>
            <input id="ctx-months" className="form-input" type="number" min="0" max="240" step="1" style={{ width: '100%' }}
              value={f.validityMonths} disabled={!f.expires} placeholder="Set per person"
              onChange={(e) => set('validityMonths', e.target.value)} />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Fills the expiry from the issue date. Blank = typed per person.</div>
          </div>
        </div>
        <div className="nx-set-card">
          <SwitchRow id="ctx-expires" title="Expires" desc="Off for something that never lapses - a one-time course or a degree."
            checked={f.expires} onChange={(v) => set('expires', v)} />
        </div>
        <div>
          <label style={FL} htmlFor="ctx-desc">Description</label>
          <input id="ctx-desc" className="form-input" style={{ width: '100%' }} value={f.description} maxLength={200}
            onChange={(e) => set('description', e.target.value)} placeholder="Optional - who needs it, where to get it" />
        </div>
      </div>
    </Modal>
  );
}

export default function CredentialTypesSettings({ company = '', toastOk, toastErr }) {
  const [types, setTypes] = useState(null);
  const [entities, setEntities] = useState([]);
  const [editing, setEditing] = useState(null);   // null | 'new' | a type
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => api.hrCredentialTypes(true)
    .then((r) => { setErr(''); setTypes(r || []); })
    .catch((e) => { setTypes((m) => m || []); setErr(e?.message || 'Could not load the list.'); }), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.getEntities().then(setEntities).catch(() => setEntities([])); }, []);

  const companyName = entities.find((e) => e.id === company)?.name || '';
  const mine = useMemo(() => (types || []).filter((t) => (t.companyId || '') === (company || '')), [types, company]);
  const live = mine.filter((t) => !t.archived);
  const archived = mine.filter((t) => t.archived);
  const inherited = company ? (types || []).filter((t) => !t.companyId && !t.archived) : [];

  async function patch(t, body, done) {
    setBusyId(t.id);
    try { await api.updateHrCredentialType(t.id, body); toastOk?.(done); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusyId('');
  }

  if (!types) return <div style={{ padding: 16 }}><SkeletonBlocks count={3} height={44} /></div>;
  const btn = { padding: '4px 7px', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 };
  return (
    <div data-credential-types>
      {err && <div role="alert" style={{ padding: '12px 18px', fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{err}</div>}
      {company && (
        <div style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>
          {inherited.length
            ? <>Every company&apos;s list applies here too: {inherited.map((t) => t.name).join(', ')}. It is set up with Applies To on Every company.</>
            : <>These are {companyName ? `${companyName}'s` : "this company's"} alone. The list for every company is set up with Applies To on Every company.</>}
        </div>
      )}
      {live.length === 0 && (
        <div style={{ padding: '16px 18px', fontSize: 12.5, color: 'var(--muted)' }}>
          Nothing set up yet. Add the licenses and certifications your people hold - a driver&apos;s license, a forklift card, OSHA 10, CPR / First Aid.
        </div>
      )}
      {live.map((t) => (
        <SettingRow key={t.id} title={t.name} desc={describe(t)} control={(
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" style={btn} onClick={() => setEditing(t)}><Pencil size={12} /> Edit</button>
            <button type="button" className="secondary-btn" style={btn} disabled={busyId === t.id}
              title="Hide it from new records and shift types - records already on file are kept"
              onClick={() => patch(t, { archived: true }, `${t.name} archived - records on file are kept.`)}><Archive size={12} /> Archive</button>
          </span>
        )} />
      ))}
      <div style={{ padding: '12px 18px', borderTop: live.length ? '1px solid var(--line)' : undefined }}>
        <button type="button" className="secondary-btn" onClick={() => setEditing('new')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Plus size={13} /> Add License or Certification
        </button>
      </div>
      {archived.length > 0 && (
        <>
          <div style={{ padding: '10px 18px 0', fontSize: 12, fontWeight: 600, color: 'var(--muted)', borderTop: '1px solid var(--line)' }}>Archived</div>
          {archived.map((t) => (
            <SettingRow key={t.id} muted title={t.name} desc={`${describe(t)} · hidden, records kept`} control={(
              <button type="button" className="secondary-btn" style={btn} disabled={busyId === t.id}
                onClick={() => patch(t, { archived: false }, `${t.name} restored.`)}><RotateCcw size={12} /> Restore</button>
            )} />
          ))}
        </>
      )}
      {editing && (
        <TypeEditor type={editing === 'new' ? null : editing} company={company} companyName={companyName}
          onClose={() => setEditing(null)} toastErr={toastErr}
          onSaved={(saved, isNew) => { setEditing(null); toastOk?.(isNew ? `${saved.name} added.` : `${saved.name} saved.`); load(); }} />
      )}
    </div>
  );
}
