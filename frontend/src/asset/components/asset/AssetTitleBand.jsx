import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Download, FileText, Lock, MoreHorizontal, Unlock, Wrench, Search } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { MenuRow } from '../shared/MenuRow.jsx';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { streetCityStateZip, typeLabel } from '../../lib/portfolioCards.js';
import { companyName, companyIdOf } from '../../lib/companies.js';
import { measuresOf, fmtInt, stageInk, managerLabel } from '../../lib/portfolioQuery.js';
import { toNumber, formatNumber } from '../../lib/format.js';

const MENU = { background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-menu, var(--shadow-lg))', padding: 6 };

/** One sentence of what the property is: "3.45-acre site, 151,620 sf building built in 2019,
 *  1,005 storage units - 87% leased (966 of 1,113 units, from the Site Model)." */
export function propertyFacts(asset, all, metric) {
  const m = measuresOf(asset, all);
  const bits = [];
  if (m.acres) bits.push(`${m.acres.toFixed(2).replace(/\.00$/, '')}-acre site`);
  if (m.sf) bits.push(`${fmtInt(m.sf)} sf building${asset.yearBuilt ? ` built in ${asset.yearBuilt}` : ''}`);
  else if (asset.yearBuilt) bits.push(`built in ${asset.yearBuilt}`);
  if (m.units) bits.push(`${fmtInt(m.units)} ${/storage/i.test(typeLabel(asset)) ? 'storage units' : 'units'}`);
  if (m.parcels > 1) bits.push(`${m.parcels} parcels`);
  const occ = metric && typeof metric.occupancy === 'number' ? metric.occupancy : null;
  if (!bits.length && occ == null) return null;
  const lead = bits.join(', ');
  if (occ == null) return <>{lead.charAt(0).toUpperCase() + lead.slice(1)}.</>;
  const units = metric.units || 0;
  const leased = Math.round(occ * units);
  return (
    <>
      {lead ? `${lead.charAt(0).toUpperCase() + lead.slice(1)} - ` : ''}<b>{Math.round(occ * 100)}% leased</b>
      {units ? <span className="pt-dim"> ({fmtInt(leased)} of {fmtInt(units)} units, from the Site Model)</span> : null}.
    </>
  );
}

function fleetFacts(asset) {
  const bits = [[asset.yearBuilt, asset.make, asset.model].filter(Boolean).join(' '), asset.color, asset.vin ? `VIN ${asset.vin}` : ''].filter(Boolean);
  const meter = inferAssetKind(asset) === 'equipment' ? (toNumber(asset.hours) ? `${formatNumber(asset.hours)} hours on the meter` : '') : (toNumber(asset.odometer) ? `${formatNumber(asset.odometer)} miles on the odometer` : '');
  if (meter) bits.push(meter);
  return bits.length ? `${bits.join(', ')}.` : null;
}

/**
 * The open asset's title band (Neil, 11/17/2026): the photo, the name (24/700), the address,
 * "Stage · type · owner · Asset manager <name>", one facts sentence; on the right "< 7 of 23 >"
 * over the list it was opened from (J / K walk it too), then Edit (or Cancel / Save Changes)
 * and "..." (Mark Private, Duplicate, Export as PDF, Export as CSV). Back is the module bar's
 * line above the name ("<- Properties") - never an arrow here. On a phone the photo leads,
 * full width, with Report a Problem and Find a Unit right under the name.
 */
export function AssetTitleBand({
  asset, all = [], companies = [], metric = null, phone = false, position = null,
  canEdit = false, editing = false, dirty = false, serverOk = true,
  onEdit, onCancel, onSave, onTogglePrivate, onDuplicate, onExportPdf, onExportCsv, onReportProblem, onFindUnit,
}) {
  const [more, setMore] = useState(false);
  const moreRef = useRef(null);
  const kind = inferAssetKind(asset);
  const isProperty = kind === 'property';
  const photo = (asset.images && asset.images[0]) || asset.image || '';
  const address = isProperty ? streetCityStateZip(asset) : String(asset.address || '');
  const company = companyName(companies, companyIdOf(asset));
  const manager = String(asset.manager || '').trim();
  const facts = isProperty ? propertyFacts(asset, all, metric) : fleetFacts(asset);
  const stage = String(asset.devStage || '').trim();

  // J / K (and the arrow buttons) walk the list it was opened from - never while typing.
  useEffect(() => {
    if (!position || editing) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.modal-overlay, [role="dialog"][aria-modal="true"]')) return;
      if (e.key === 'j' || e.key === 'J') { if (position.onNext) { e.preventDefault(); position.onNext(); } }
      else if (e.key === 'k' || e.key === 'K') { if (position.onPrev) { e.preventDefault(); position.onPrev(); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [position, editing]);

  const meta = [];
  if (stage) meta.push(<span key="s" style={{ color: stageInk(stage), fontWeight: 600 }}>{stage}</span>);
  if (isProperty && typeLabel(asset)) meta.push(<span key="t">{typeLabel(asset)}</span>);
  if (!isProperty && asset.plate) meta.push(<span key="p">{asset.plate}</span>);
  if (asset.entity) meta.push(<span key="o">{asset.entity}</span>);
  if (company && company !== asset.entity) meta.push(<span key="c">{company}</span>);
  meta.push(manager
    ? <span key="m">{isProperty ? 'Asset manager' : 'Assigned to'} <b>{managerLabel(manager)}</b></span>
    : <span key="m" className="pt-faint">{isProperty ? 'No asset manager' : 'Not assigned'}</span>);
  if (asset.private) meta.push(<span key="x" style={{ color: 'hsl(var(--color-red))', fontWeight: 600 }} title="Hidden from everyone but officers">Private</span>);

  const actions = (
    <div className="at-actions">
      {position && position.total > 1 && !editing && (
        <span className="at-walk" aria-label={`${position.index + 1} of ${position.total}`}>
          <button type="button" className="pt-icon-btn is-boxed" onClick={position.onPrev} disabled={!position.onPrev} aria-label="Previous (K)" title="Previous (K)"><ChevronLeft size={15} /></button>
          <span className="at-walk-n">{position.index + 1} of {position.total}</span>
          <button type="button" className="pt-icon-btn is-boxed" onClick={position.onNext} disabled={!position.onNext} aria-label="Next (J)" title="Next (J)"><ChevronRight size={15} /></button>
        </span>
      )}
      {onEdit && !editing && canEdit && (
        <button type="button" className="secondary-btn" onClick={onEdit} disabled={!serverOk}
          title={serverOk ? undefined : 'Connecting to the server - editing opens once the latest copy is in.'}>Edit</button>
      )}
      {editing && (
        <>
          <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-btn" onClick={onSave} disabled={!dirty} title={dirty ? undefined : 'No changes yet'}>Save Changes</button>
        </>
      )}
      <button ref={moreRef} type="button" className="secondary-btn at-more" aria-label="More actions" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((o) => !o)}>
        <MoreHorizontal size={16} />
      </button>
      <AnchoredMenu anchorRef={moreRef} open={more} onClose={() => setMore(false)} align="end" minWidth={220} style={MENU}>
        <MenuRow icon={asset.private ? Unlock : Lock} onClick={() => { setMore(false); onTogglePrivate(); }}>{asset.private ? 'Make Public' : 'Mark Private'}</MenuRow>
        <MenuRow icon={Copy} onClick={() => { setMore(false); onDuplicate(); }}>Duplicate</MenuRow>
        <MenuRow icon={FileText} onClick={() => { setMore(false); onExportPdf(); }}>Export as PDF</MenuRow>
        <MenuRow icon={Download} onClick={() => { setMore(false); onExportCsv(); }}>Export as CSV</MenuRow>
      </AnchoredMenu>
    </div>
  );

  return (
    <header className={`at-band${phone ? ' is-phone' : ''}${editing ? ' is-editing' : ''}`}>
      {photo && (
        <div className="at-photo"><img src={photo} alt="" onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }} /></div>
      )}
      <div className="at-words">
        <div className="at-title-row">
          <h1 className="at-name">{asset.name || asset.siteName || 'Unnamed asset'}</h1>
          {!phone && actions}
        </div>
        {address && <div className="at-address">{address}</div>}
        <div className="at-meta">
          {meta.map((node, i) => <span key={node.key}>{i > 0 && <span className="pt-sep" aria-hidden="true">·</span>}{node}</span>)}
        </div>
        {facts && !phone && <p className="at-facts">{facts}</p>}
        {phone && (
          <>
            {isProperty && (onReportProblem || onFindUnit) && (
              <div className="at-phone-acts">
                {onReportProblem && <button type="button" className="secondary-btn" onClick={onReportProblem}><Wrench size={15} /> Report a Problem</button>}
                {onFindUnit && <button type="button" className="secondary-btn" onClick={onFindUnit}><Search size={15} /> Find a Unit</button>}
              </div>
            )}
            {actions}
          </>
        )}
      </div>
    </header>
  );
}
