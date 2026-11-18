import { useEffect, useMemo, useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import { api } from '../../../api';
import { DateField, Modal } from '../../../tasks/components';
import { FS } from '../../../lib/typeScale';
import { ENTITY_TYPES, MANAGEMENT, STATUSES, TAX_CLASSES } from './entityWords';

// Edit an entity's legal record (Accounting Editor; Dissolved / Sold take
// Full - routers/accounting_entities.py says the same). A field the linked
// Nexus company keeps (legal name, EIN, address, signatory) is shown as the
// company's and edited in Settings > Companies, never typed twice. Fill From
// offers what Nexus already holds - each with where it came from - and only
// what is picked goes into the form; nothing saves until Save.

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' ');

const FIELDS = ['kind', 'companyId', 'legalName', 'dba', 'entityType', 'taxClass', 'formedState', 'formedOn', 'status', 'endedOn', 'fiscalYearEnd',
  'address', 'registeredAgent', 'agentRenewsOn', 'foreignStates', 'management', 'managerCode', 'managerName', 'signers', 'steward', 'propertyIds', 'egnyteFolder', 'notes'];

function fromEntity(e) {
  return {
    kind: e.kind === 'location' ? 'location' : 'entity', companyId: e.company?.id || '', legalName: e.company ? '' : e.legalName || '', dba: e.dba || '',
    entityType: e.entityType || '', taxClass: e.taxClassTyped || '', formedState: e.formedState || '', formedOn: e.formedOn || '',
    status: e.status || 'active', endedOn: e.endedOn || '', fiscalYearEnd: e.fiscalYearEnd || '', address: e.company ? '' : e.address || '',
    registeredAgent: e.registeredAgent || '', agentRenewsOn: e.agentRenewsOn || '', foreignStates: e.foreignStates || [],
    management: e.management || '', managerCode: e.managerCode || '', managerName: e.managerName || '',
    signers: e.company ? [] : (e.signers || []).map((s) => ({ name: s.name || '', title: s.title || '', email: s.email || '' })),
    steward: e.steward || '', propertyIds: e.propertyIds || [], egnyteFolder: e.egnyteFolder || '', notes: e.notes || '',
  };
}

const Row = ({ label, children, hint }) => (
  <label className="ent-form-row">
    <span className="ent-form-label">{label}</span>
    <span className="ent-form-field">{children}{hint && <span className="ent-hint">{hint}</span>}</span>
  </label>
);

export default function EntityEditSheet({ entity, entities = [], canFull, onClose, onSaved }) {
  const start = useMemo(() => fromEntity(entity), [entity]);
  const [f, setF] = useState(start);
  const [ein, setEin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [companies, setCompanies] = useState([]);
  const [people, setPeople] = useState([]);
  const [properties, setProperties] = useState([]);
  const [suggest, setSuggest] = useState(null);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const dirty = ein !== '' || FIELDS.some((k) => JSON.stringify(f[k]) !== JSON.stringify(start[k]));

  useEffect(() => {
    api.getEntities().then((d) => setCompanies(Array.isArray(d) ? d : d?.entities || [])).catch(() => {});
    api.getPeopleDirectory().then((d) => setPeople(Array.isArray(d) ? d : d?.people || [])).catch(() => {});
    api.getTicketProperties().then((d) => setProperties(d?.properties || [])).catch(() => {});
  }, []);

  const company = companies.find((c) => c.id === f.companyId);
  const ended = f.status === 'dissolved' || f.status === 'sold';
  const statusLocked = !canFull && (['dissolved', 'sold'].includes(start.status) || false);
  const others = entities.filter((x) => x.kind === 'entity' && x.code !== entity.code);
  const propName = (id) => properties.find((p) => p.id === id)?.name || id;

  const fill = () => {
    setSuggest('loading');
    api.getLegalEntitySuggestions(entity.code).then((d) => setSuggest(d?.suggestions || {})).catch(() => setSuggest({}));
  };
  const SUGGEST_LABELS = { legalName: 'Legal Name', entityType: 'Type', companyId: 'Nexus Company', managerCode: 'Manager', management: 'Management', propertyIds: 'Owns' };
  const suggestText = (k, s) => (k === 'entityType' ? ENTITY_TYPES.find((t) => t[0] === s.value)?.[1] : k === 'companyId' ? s.label
    : k === 'managerCode' ? `${entities.find((x) => x.code === s.value)?.name || ''} (${s.value})` : k === 'management' ? MANAGEMENT.find((m) => m[0] === s.value)?.[1]
      : k === 'propertyIds' ? (s.labels || []).join(', ') : s.value);
  const take = (k, s) => {
    if (k === 'propertyIds') set({ propertyIds: [...new Set([...(f.propertyIds || []), ...s.value])] });
    else set({ [k]: s.value });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    const body = { rev: entity.rev || 0 };
    FIELDS.forEach((k) => { if (JSON.stringify(f[k]) !== JSON.stringify(start[k])) body[k] = f[k]; });
    if (ein) body.ein = ein;
    if (body.kind === 'entity' && entity.kind === 'entity') delete body.kind;
    try {
      await api.saveLegalEntity(entity.code, body);
      onSaved?.();
    } catch (e) {
      setError(e?.message || 'Could not save.');
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className="modal-footer" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {error && <span role="alert" style={{ color: 'var(--danger, #dc2626)', fontSize: FS.body, flex: 1 }}>{error}</span>}
      <span style={{ flex: error ? 0 : 1 }} />
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" disabled={!dirty || saving} onClick={() => save().catch(() => {})}>{saving ? 'Saving...' : 'Save'}</button>
    </div>
  );

  return (
    <Modal title={`Edit ${entity.name}`} onClose={onClose} footer={footer} isDirty={dirty} onSave={save} width="760px">
      <div className="ent-form">
        <div className="ent-fill">
          <button type="button" className="secondary-btn" onClick={fill} disabled={suggest === 'loading'}>
            <Sparkles size={14} aria-hidden="true" /> Fill From What Nexus Knows
          </button>
          <span className="ent-hint">Values already in Investor Relations, Settings, Management Fees and Asset Management. Nothing is used until you pick it.</span>
        </div>
        {suggest && suggest !== 'loading' && (
          <div className="ent-suggest">
            {Object.keys(suggest).length ? Object.entries(suggest).map(([k, s]) => (
              <div key={k} className="ent-suggest-row">
                <span><b>{SUGGEST_LABELS[k] || k}:</b> {suggestText(k, s)} <span className="ent-muted">- from {s.from}</span></span>
                <button type="button" className="ent-link" onClick={() => take(k, s)}>Use</button>
              </div>
            )) : <span className="ent-muted">Nexus holds nothing more about this entity yet.</span>}
          </div>
        )}

        <h3 className="ent-form-head">Who It Is</h3>
        <Row label="Kind" hint={entity.code.includes('-') ? 'Codes with a dash start as a location of the entity before the dash.' : ''}>
          <select className="form-input" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="entity">Legal Entity</option><option value="location">Location of Another Entity</option>
          </select>
        </Row>
        <Row label="Nexus Company" hint="When this entity is also a company in Settings > Companies, its legal name, EIN, address and signatory come from there.">
          <select className="form-input" value={f.companyId} onChange={(e) => set({ companyId: e.target.value })}>
            <option value="">Not a Nexus company</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name || c.legalName || c.name}</option>)}
          </select>
        </Row>
        {f.companyId ? (
          <p className="ent-hint" style={{ margin: '0 0 8px' }}>Legal name, EIN, address and signatory: {company?.legal_name || company?.legalName || company?.name || 'the linked company'} in Settings &gt; Companies.</p>
        ) : (
          <>
            <Row label="Legal Name"><input className="form-input" value={f.legalName} onChange={(e) => set({ legalName: e.target.value })} placeholder={entity.booksName} /></Row>
            <Row label="EIN" hint={entity.hasEin ? `Saved as ${entity.einMasked}. Type a new one to replace it.` : 'Nine digits. Kept encrypted; others see only the last four.'}>
              <input className="form-input" value={ein} onChange={(e) => setEin(e.target.value)} placeholder="12-3456789" autoComplete="off" inputMode="numeric" />
            </Row>
            <Row label="Principal Address"><input className="form-input" value={f.address} onChange={(e) => set({ address: e.target.value })} /></Row>
          </>
        )}
        <Row label="Doing Business As"><input className="form-input" value={f.dba} onChange={(e) => set({ dba: e.target.value })} /></Row>

        <h3 className="ent-form-head">Type and Tax</h3>
        <Row label="Entity Type">
          <select className="form-input" value={f.entityType} onChange={(e) => set({ entityType: e.target.value })}>
            <option value="">Not set</option>
            {ENTITY_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        <Row label="Taxed As" hint="Decides the shape on the structure chart. Leave it to the type unless an election changed it.">
          <select className="form-input" value={f.taxClass} onChange={(e) => set({ taxClass: e.target.value })}>
            <option value="">As the type is taxed by default</option>
            {TAX_CLASSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>

        <h3 className="ent-form-head">Formation and Status</h3>
        <Row label="State Formed">
          <select className="form-input" value={f.formedState} onChange={(e) => set({ formedState: e.target.value })}>
            <option value="">Not set</option>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="IN">IN (India)</option>
          </select>
        </Row>
        <Row label="Date Formed"><DateField value={f.formedOn} onChange={(v) => set({ formedOn: v || '' })} /></Row>
        <Row label="Fiscal Year Ends" hint="Month and day, like 12-31.">
          <input className="form-input" value={f.fiscalYearEnd} onChange={(e) => set({ fiscalYearEnd: e.target.value })} placeholder="12-31" style={{ maxWidth: 120 }} />
        </Row>
        <Row label="Status" hint={!canFull ? 'Marking an entity Dissolved or Sold takes the Full level on Accounting.' : ''}>
          <select className="form-input" value={f.status} disabled={statusLocked} onChange={(e) => set({ status: e.target.value })}>
            {STATUSES.filter(([k]) => canFull || !['dissolved', 'sold'].includes(k) || k === start.status).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        {ended && <Row label={f.status === 'sold' ? 'Date Sold' : 'Date Dissolved'}><DateField value={f.endedOn} onChange={(v) => set({ endedOn: v || '' })} /></Row>}
        <Row label="Also Registered In" hint="States where it is registered to do business besides where it was formed.">
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(f.foreignStates || []).map((s) => (
              <span key={s.state} className="ent-token">{s.state}
                <button type="button" aria-label={`Remove ${s.state}`} onClick={() => set({ foreignStates: f.foreignStates.filter((x) => x.state !== s.state) })}><X size={12} /></button>
              </span>
            ))}
            <select className="form-input" value="" style={{ width: 'auto' }} aria-label="Add a state"
              onChange={(e) => e.target.value && set({ foreignStates: [...(f.foreignStates || []), { state: e.target.value, registeredOn: '' }] })}>
              <option value="">Add a state</option>
              {STATES.filter((s) => s !== f.formedState && !(f.foreignStates || []).some((x) => x.state === s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </span>
        </Row>
        <Row label="Registered Agent"><input className="form-input" value={f.registeredAgent} onChange={(e) => set({ registeredAgent: e.target.value })} /></Row>
        <Row label="Agent Renews On"><DateField value={f.agentRenewsOn} onChange={(v) => set({ agentRenewsOn: v || '' })} /></Row>

        <h3 className="ent-form-head">Management and People</h3>
        <Row label="Managed By">
          <select className="form-input" value={f.management} onChange={(e) => set({ management: e.target.value })}>
            <option value="">Not set</option>
            {MANAGEMENT.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        <Row label="Manager" hint="One of our entities - it is drawn on the chart. A Management Fee agreement shows here by itself.">
          <select className="form-input" value={f.managerCode} onChange={(e) => set({ managerCode: e.target.value })}>
            <option value="">None of our entities</option>
            {others.map((x) => <option key={x.code} value={x.code}>{x.name} ({x.code})</option>)}
          </select>
        </Row>
        {!f.managerCode && <Row label="Manager Name" hint="A person or an outside firm."><input className="form-input" value={f.managerName} onChange={(e) => set({ managerName: e.target.value })} /></Row>}
        {!f.companyId && (
          <Row label="Signers">
            <span style={{ display: 'grid', gap: 6 }}>
              {(f.signers || []).map((s, i) => (
                <span key={i} style={{ display: 'flex', gap: 6 }}>
                  <input className="form-input" value={s.name} placeholder="Name" aria-label="Signer name" onChange={(e) => set({ signers: f.signers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <input className="form-input" value={s.title} placeholder="Title" aria-label="Signer title" onChange={(e) => set({ signers: f.signers.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                  <button type="button" className="ent-icon-btn" aria-label="Remove signer" onClick={() => set({ signers: f.signers.filter((_, j) => j !== i) })}><X size={14} /></button>
                </span>
              ))}
              <button type="button" className="ent-link" style={{ justifySelf: 'start' }} onClick={() => set({ signers: [...(f.signers || []), { name: '', title: '', email: '' }] })}>
                <Plus size={13} aria-hidden="true" /> Add Signer
              </button>
            </span>
          </Row>
        )}
        <Row label="Steward" hint="The person accountable for this entity's records and filings.">
          <select className="form-input" value={f.steward} onChange={(e) => set({ steward: e.target.value })}>
            <option value="">No one named</option>
            {people.map((p) => <option key={p.email} value={(p.email || '').toLowerCase()}>{p.name || p.email}</option>)}
          </select>
        </Row>

        <h3 className="ent-form-head">What It Owns and Where Its Papers Are</h3>
        <Row label="Properties" hint="Drawn under the entity on its structure chart.">
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(f.propertyIds || []).map((id) => (
              <span key={id} className="ent-token">{propName(id)}
                <button type="button" aria-label={`Remove ${propName(id)}`} onClick={() => set({ propertyIds: f.propertyIds.filter((x) => x !== id) })}><X size={12} /></button>
              </span>
            ))}
            <select className="form-input" value="" style={{ width: 'auto', maxWidth: 280 }} aria-label="Add a property"
              onChange={(e) => e.target.value && set({ propertyIds: [...(f.propertyIds || []), e.target.value] })}>
              <option value="">Add a property</option>
              {properties.filter((p) => !(f.propertyIds || []).includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}{p.city ? ` - ${p.city}` : ''}</option>)}
            </select>
          </span>
        </Row>
        <Row label="Egnyte Folder" hint="The entity's folder, usually under /Shared/#Entities.">
          <input className="form-input" value={f.egnyteFolder} onChange={(e) => set({ egnyteFolder: e.target.value })} placeholder="/Shared/#Entities/" />
        </Row>
        <Row label="Notes"><textarea className="form-input" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Row>
      </div>
    </Modal>
  );
}
