import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { FS } from '../lib/typeScale';

// Investor Relations <-> Accounting > Entities (Neil, 11/17/2026).
//
// DealLegal: a deal's Legal line, read from the entity the deal is (its legal
// name, type, where and when it was formed, status, the EIN's ending). Never
// a figure, so the Investor Relations read gate alone opens it; the record
// itself is kept and edited in Accounting > Entities.
//
// InvestorEntityLink: an investor profile that IS one of our entities
// (Greens Global Inv 1, LLC investing in a deal). Linking it lets the
// structure chart climb through it and work out look-through ownership.
// Needs Accounting access to the entity; without it nothing is shown.

const openEntity = (code) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'accounting', sub: `entity-${code}` } }));
const STATUS_WORDS = { inactive: 'Inactive', dissolved: 'Dissolved', sold: 'Sold' };
const box = { gridColumn: '1 / -1', marginTop: 4 };
const head = { fontSize: FS.title, fontWeight: 600, color: 'var(--ink, var(--text-primary))', margin: '0 0 4px' };
const line = { fontSize: FS.body, color: 'var(--ink, var(--text-primary))', lineHeight: 1.6 };
const muted = { fontSize: FS.body, color: 'var(--muted, var(--text-secondary))' };
const link = { background: 'none', border: 0, padding: 0, color: 'var(--wk-green, #00a25b)', fontWeight: 600, cursor: 'pointer', font: 'inherit' };

export function DealLegal({ fundId }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getIrFundLegal(fundId).then((x) => { if (alive) setD(x); }).catch(() => { if (alive) setD({ linked: false }); });
    return () => { alive = false; };
  }, [fundId]);
  if (!d?.linked) return null;
  if (!d.recorded) {
    return (
      <div style={box}>
        <h4 style={head}>Legal</h4>
        <div style={muted}>Entity {d.entity} has no legal record yet. <button type="button" style={link} onClick={() => openEntity(d.entity)}>Add It in Accounting</button></div>
      </div>
    );
  }
  const formed = [d.formedState, d.formedOn ? formatDate(d.formedOn) : ''].filter(Boolean).join(' ');
  return (
    <div style={box}>
      <h4 style={head}>Legal</h4>
      <div style={line}>
        {[d.legalName, d.typeLine, formed ? `formed ${formed}` : '', d.einMasked ? `EIN ${d.einMasked}` : '', STATUS_WORDS[d.status] || ''].filter(Boolean).join(' - ')}
      </div>
      <button type="button" style={{ ...link, fontSize: FS.label }} onClick={() => openEntity(d.entity)}>Open Entity {d.entity} and Its Structure Chart</button>
    </div>
  );
}

export function InvestorEntityLink({ investor, onSaved }) {
  const [entities, setEntities] = useState(null);
  const [value, setValue] = useState(investor?.legalEntityCode || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getLegalEntities().then((d) => { if (alive) setEntities((d?.entities || []).filter((e) => e.kind === 'entity')); }).catch(() => { if (alive) setEntities(false); });
    return () => { alive = false; };
  }, []);
  if (!investor?.id || entities === false || entities === null) return null;
  const save = async (code) => {
    setBusy(true);
    setError('');
    try {
      await api.linkIrInvestorEntity(investor.id, code);
      setValue(code);
      onSaved?.();
    } catch (e) {
      setError(e?.message || 'Could not link it.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={box}>
      <h4 style={head}>One of Our Entities</h4>
      <div style={{ ...muted, marginBottom: 6 }}>When this investor is one of our own entities, link it so Accounting &gt; Entities draws ownership through it.</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="form-input" value={value} disabled={busy} onChange={(e) => save(e.target.value)} style={{ maxWidth: 360 }} aria-label="Our entity">
          <option value="">Not one of our entities</option>
          {entities.map((e) => <option key={e.code} value={e.code}>{e.name} ({e.code})</option>)}
        </select>
        {value && <button type="button" style={link} onClick={() => openEntity(value)}>Open Entity</button>}
      </div>
      {error && <div role="alert" style={{ color: 'var(--danger, #dc2626)', fontSize: FS.body, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
