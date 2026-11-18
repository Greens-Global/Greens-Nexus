import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../../api';
import { DateField } from '../../../tasks/components';
import { formatDate } from '../../../lib/datetime';
import { FS } from '../../../lib/typeScale';
import { dialog } from '../../../ui/dialog';
import { pctText } from './structureModel';

// The owners of an entity that is NOT a deal (Neil, 11/17/2026): another of
// our entities, an Investor Relations profile, or a person or outside party
// by name. A deal's members are kept on the deal in Investor Relations - the
// server refuses an owner row for a deal's entity, and this panel says where
// to go instead. An owner who leaves is ended with a date and stays in the
// history; nothing here deletes.

const KINDS = [['entity', 'One of Our Entities'], ['investor', 'An Investor in Investor Relations'], ['person', 'A Person or Outside Party']];
const blank = { ownerKind: 'entity', ownerCode: '', investorId: '', ownerName: '', pct: '', ownerClass: '', since: '' };

export default function OwnersPanel({ entity, entities = [], onChanged, onOpenDeal }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(blank);
  const [investors, setInvestors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (p) => setF((x) => ({ ...x, ...p }));

  useEffect(() => {
    if (!adding || investors !== null || !entity.seesInvestors) return;
    api.getIrInvestors().then((d) => setInvestors(Array.isArray(d) ? d : d?.investors || [])).catch(() => setInvestors([]));
  }, [adding, investors, entity.seesInvestors]);

  if (entity.ownersHome === 'ir') {
    return (
      <p className="ent-muted" style={{ fontSize: FS.body }}>
        This entity is the deal {entity.deal?.name}, so its members and their percentages are kept on the deal in Investor Relations.{' '}
        {onOpenDeal && <button type="button" className="ent-link" onClick={onOpenDeal}>Open the Deal</button>}
      </p>
    );
  }

  const others = entities.filter((x) => x.kind === 'entity' && x.code !== entity.code);
  const current = (entity.owners || []).filter((o) => o.source === 'entity');
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await api.addLegalEntityOwner(entity.code, { ...f, pct: f.pct === '' ? null : Number(f.pct) });
      setF(blank);
      setAdding(false);
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Could not add the owner.');
    } finally {
      setBusy(false);
    }
  };
  const end = async (o) => {
    const now = new Date();
    const today = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
    const typed = await dialog.prompt(`When did ${o.label} stop being an owner? They stay in the history.`, { defaultValue: today, placeholder: 'MM/DD/YYYY', confirmText: 'Record' });
    if (!typed) return;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(typed).trim());
    if (!m) { dialog.alert('Type the date as MM/DD/YYYY.'); return; }
    try {
      await api.endLegalEntityOwner(entity.code, o.ownerId, `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`);
      onChanged?.();
    } catch (e) {
      dialog.alert(e?.message || 'Could not record that.');
    }
  };

  return (
    <div className="ent-owners">
      {current.length ? (
        <div className="ent-lines">
          {current.map((o) => (
            <div key={o.ownerId} className="ent-line ent-line--split">
              <span>{o.label}{o.role ? <span className="ent-muted"> - {o.role}</span> : null}</span>
              <span className="ent-line-end">
                <b>{pctText(o.pct) || 'Percentage not recorded'}</b>
                {entity.canEdit && <button type="button" className="ent-link" onClick={() => end(o)}>Owner Left</button>}
              </span>
            </div>
          ))}
          <div className="ent-line ent-muted">Owners add up to {pctText(entity.ownersTotal) || '0%'}{entity.ownersTotal < 99.99 ? ' - the rest is not recorded yet' : ''}</div>
        </div>
      ) : <p className="ent-muted" style={{ fontSize: FS.body }}>No owners recorded yet.</p>}

      {entity.canEdit && !adding && (
        <button type="button" className="ent-link" style={{ marginTop: 8 }} onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" /> Add Owner</button>
      )}
      {adding && (
        <div className="ent-owner-form">
          <label className="ent-form-row"><span className="ent-form-label">Owner Is</span>
            <span className="ent-form-field">
              <select className="form-input" value={f.ownerKind} onChange={(e) => set({ ownerKind: e.target.value })}>
                {KINDS.filter(([k]) => k !== 'investor' || entity.seesInvestors).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </span>
          </label>
          <label className="ent-form-row"><span className="ent-form-label">Owner</span>
            <span className="ent-form-field">
              {f.ownerKind === 'entity' && (
                <select className="form-input" value={f.ownerCode} onChange={(e) => set({ ownerCode: e.target.value })}>
                  <option value="">Pick an entity</option>
                  {others.map((x) => <option key={x.code} value={x.code}>{x.name} ({x.code})</option>)}
                </select>
              )}
              {f.ownerKind === 'investor' && (
                <select className="form-input" value={f.investorId} onChange={(e) => set({ investorId: e.target.value })}>
                  <option value="">{investors === null ? 'Loading...' : 'Pick an investor'}</option>
                  {(investors || []).map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
                </select>
              )}
              {f.ownerKind === 'person' && <input className="form-input" value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} placeholder="Name" />}
            </span>
          </label>
          <label className="ent-form-row"><span className="ent-form-label">Percentage</span>
            <span className="ent-form-field"><input className="form-input" type="number" min="0" max="100" step="0.01" value={f.pct} onChange={(e) => set({ pct: e.target.value })} style={{ maxWidth: 140 }} /></span>
          </label>
          <label className="ent-form-row"><span className="ent-form-label">Class or Role</span>
            <span className="ent-form-field"><input className="form-input" value={f.ownerClass} onChange={(e) => set({ ownerClass: e.target.value })} placeholder="Managing Member, Class A" /></span>
          </label>
          <label className="ent-form-row"><span className="ent-form-label">Owner Since</span>
            <span className="ent-form-field"><DateField value={f.since} onChange={(v) => set({ since: v || '' })} /></span>
          </label>
          {error && <p role="alert" style={{ color: 'var(--danger, #dc2626)', fontSize: FS.body }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="primary-btn" disabled={busy} onClick={add}>Add Owner</button>
            <button type="button" className="secondary-btn" onClick={() => { setAdding(false); setError(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {(entity.ownerHistory || []).length > 0 && (
        <>
          <h4 className="ent-sub-head">Former Owners</h4>
          <div className="ent-lines">
            {entity.ownerHistory.map((o) => (
              <div key={o.ownerId} className="ent-line ent-line--split ent-muted">
                <span>{o.label}{o.ownerClass ? ` - ${o.ownerClass}` : ''}</span>
                <span>{pctText(o.pct)}{o.since ? ` from ${formatDate(o.since)}` : ''} until {formatDate(o.until)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
