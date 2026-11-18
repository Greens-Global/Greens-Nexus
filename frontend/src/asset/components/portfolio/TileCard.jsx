import { useId, memo } from 'react';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { cityRegion, typeLabel, typeIcon } from '../../lib/portfolioCards.js';
import { fleetStatusColor, fleetIdLine, initialsOf, fleetMeter, fleetFactsFor } from '../../lib/fleetCards.js';
import { measuresOf, factsLine, stageInk } from '../../lib/portfolioQuery.js';
import { relativeTime } from '../../../components/audit/auditModel.js';
import { StatusLabel } from '../../../components/StatusLabel.jsx';
import ProgressTrack from '../../../ui/ProgressTrack';

// A stable empty list, so a card with no linked parcels keeps its memo between renders.
const NONE = [];

/** The stage line under a gallery tile: nothing for a plain Stabilized property (the usual
 *  case says nothing), "Renovation under way" for a Stabilized - X stage, else the stage. */
export function stageLine(stage) {
  const s = String(stage || '').trim();
  if (!s || /^stabili[sz]ed$/i.test(s) || /^in service$/i.test(s)) return '';
  const sub = /^stabili[sz]ed\s*[-–]+\s*(.+)$/i.exec(s);
  return sub ? `${sub[1]} under way` : s;
}

/**
 * The Gallery tile (Neil, 11/17/2026): the photo, 16:9, with nothing written on it; under it
 * the name (wraps, never shrinks), "City, ST · Type · N parcels", ONE facts line with the same
 * measures in the same order for every property (a parcel group SUMS its parcels), and the stage
 * only when it is not plain Stabilized, in its color. No card box: hover dims the photo and
 * underlines the name. The property last opened keeps the live accent ring on its photo.
 */
function PropertyTile({ pr: property, openProperty, secondaries = NONE, selected = false, measures = null }) {
  const isGroup = secondaries.length > 0;
  const members = [property, ...secondaries]
    .map((m, i) => [m, m.parcelOrder == null ? i : m.parcelOrder])
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
  const lead = members.find((m) => m.primary) || members[0] || property;
  const m = measures || measuresOf(property, [property, ...secondaries]);
  const title = isGroup && lead.siteName ? lead.siteName : (lead.name || lead.siteName || 'Unnamed property');
  const Icon = typeIcon(lead);
  const photo = (lead.images && lead.images[0]) || lead.image || '';
  const meta = [cityRegion(lead), typeLabel(lead), m.parcels > 1 ? `${m.parcels} parcels` : '', lead.private ? 'Private' : ''].filter(Boolean).join(' · ');
  const facts = factsLine(m);
  const stage = stageLine(lead.devStage);
  const open = () => openProperty(property.id);
  return (
    <div className={`pt-tile${selected ? ' is-selected' : ''}`} role="button" tabIndex={0} data-asset-id={property.id}
      aria-label={`Open ${title}`} onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>
      <div className={`pt-tile-photo${photo ? '' : ' is-empty'}`}>
        {photo ? <img src={photo} alt="" loading="lazy" decoding="async" /> : <Icon size={40} strokeWidth={1.4} aria-hidden="true" />}
      </div>
      <div className="pt-tile-name">{title}</div>
      {meta && <div className="pt-tile-meta">{meta}</div>}
      <div className={`pt-tile-facts${facts ? '' : ' is-faint'}`}>{facts || 'No size on file'}</div>
      {stage && <div className="pt-tile-stage" style={{ color: stageInk(lead.devStage) }}>{stage}</div>}
    </div>
  );
}

/**
 * Portfolio Tiles-view card - the ONE card for every asset. A property (and any linked group)
 * keeps its photo-header tile above; a vehicle or a piece of equipment gets the fleet face
 * below (Neil, 11/02/2026, mock https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 2).
 *
 * `fleet` is this asset's facts from fleetFactsFor (Portfolio builds them once per store);
 * without it (a lone card) they are worked out from `store`. `selected` marks the asset last
 * opened, so coming Back lands on an outlined card. Memoized: typing in the portfolio search
 * re-renders the grid, not every card.
 */
export const TileCard = memo(function TileCard({ pr, openProperty, secondaries = NONE, store = null, fleet = null, selected = false, measures = null }) {
  if (inferAssetKind(pr) !== 'property' && !secondaries.length) {
    const facts = fleet || fleetFactsFor([pr], store || {})[pr.id];
    return <FleetTile asset={pr} openProperty={openProperty} facts={facts} selected={selected} />;
  }
  return <PropertyTile pr={pr} openProperty={openProperty} secondaries={secondaries} selected={selected} measures={measures} />;
});

/**
 * The fleet face: name and plate / serial with the Status soft label, the photo (or a clean
 * silhouette), the assigned driver / operator and when it last changed, the progress to the
 * next service (lib/nextService.js - live orange while under, red once past; no service data
 * = no track), then the meter and the home base. Styles: .fleet-* in asset-styles.scoped.css.
 *
 * Accessibility: the name is the card's one button (its ::after stretches over the card, so a
 * click anywhere opens it); its accessible name is the asset name and its description the
 * card's facts. The service progressbar sits outside the button, so it keeps its own name.
 */
function FleetTile({ asset, openProperty, facts, selected }) {
  const descId = useId();
  const kind = inferAssetKind(asset);
  const name = asset.name || asset.siteName || 'Unnamed asset';
  // The plate / serial; else the make and model, unless that is just the name again.
  const makeModel = [asset.make, asset.model].filter(Boolean).join(' ');
  const idLine = fleetIdLine(asset) || (makeModel && makeModel.toLowerCase() !== name.toLowerCase() ? makeModel : typeLabel(asset));
  const status = String(asset.devStage || '').trim();
  const photo = (asset.images && asset.images[0]) || asset.image || '';
  const who = String(asset.manager || '').trim();
  const updated = facts && facts.changed ? relativeTime(facts.changed) : '';
  const service = facts ? facts.service : null;
  const meter = fleetMeter(asset, kind === 'vehicle' ? (facts ? facts.odometer : 0) : null);
  const where = cityRegion(asset) || String(asset.address || '').split(',')[0].trim();
  const description = [
    status, idLine, who && `Assigned to ${who}`, service && service.note,
    meter, where, updated && `Updated ${updated}`, asset.private && 'Private',
  ].filter(Boolean).join('. ');

  return (
    <div className={`asset-card fleet-card${selected ? ' is-selected' : ''}`} data-asset-id={asset.id} data-selected={selected ? 'true' : undefined}>
      <div className="fleet-top">
        <div className="fleet-title">
          <h3 className="fleet-name">
            <button type="button" className="fleet-open" title={name} aria-describedby={descId} onClick={() => openProperty(asset.id)}>
              <span className="fleet-name-text">{name}</span>
            </button>
          </h3>
          {idLine && <div className="fleet-id">{idLine}</div>}
        </div>
        {status && <StatusLabel label={status} color={fleetStatusColor(status)} size="sm" />}
      </div>
      <span id={descId} hidden>{description}</span>

      <div className={`fleet-photo${photo ? ' has-photo' : ''}`}>
        {photo ? <img src={photo} alt="" loading="lazy" decoding="async" /> : <FleetSilhouette kind={kind} />}
        {asset.private && <span className="fleet-private">Private</span>}
      </div>

      {(who || updated) && (
        <div className="fleet-who">
          {who && <span className="fleet-av" aria-hidden="true">{initialsOf(who)}</span>}
          {who && <span className="fleet-person" title={who}>{who}</span>}
          {updated && <span className="fleet-updated">Updated {updated}</span>}
        </div>
      )}

      {service && (service.track ? (
        <ProgressTrack
          value={service.value}
          state={service.state}
          size="sm"
          label={`${name} next service`}
          note={<b>{service.note}</b>}
        />
      ) : (
        <div className={`fleet-due${service.state === 'overdue' ? ' is-overdue' : ''}`}>{service.note}</div>
      ))}

      {(meter || where) && (
        <div className="fleet-facts">
          {meter && <span>{meter}</span>}
          {where && <span className="fleet-where" title={where}>{where}</span>}
        </div>
      )}
    </div>
  );
}

/** A quiet line drawing for a vehicle or a piece of equipment with no photo on file. Theme-safe:
 *  it draws in currentColor (the muted text color) over the photo well's own surface. */
function FleetSilhouette({ kind }) {
  if (kind === 'equipment') {
    return (
      <svg className="fleet-sil" data-kind="equipment" viewBox="0 0 220 96" aria-hidden="true">
        {/* A compact loader: the bucket, the arm, the cab on its tracks. */}
        <path d="M14 70h30l8-22H26z" fill="currentColor" fillOpacity=".1" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M48 52l44-26h20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M100 26h50l16 20v24H100z" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M112 32h30l10 14h-40z" fill="currentColor" fillOpacity=".14" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <rect x="92" y="70" width="86" height="16" rx="8" fill="currentColor" fillOpacity=".1" stroke="currentColor" strokeWidth="2" />
        <circle cx="104" cy="78" r="4" fill="currentColor" fillOpacity=".5" />
        <circle cx="135" cy="78" r="4" fill="currentColor" fillOpacity=".5" />
        <circle cx="166" cy="78" r="4" fill="currentColor" fillOpacity=".5" />
      </svg>
    );
  }
  return (
    <svg className="fleet-sil" data-kind="vehicle" viewBox="0 0 220 96" aria-hidden="true">
      {/* A work van: the box, the cab and its window, the wheels. */}
      <rect x="10" y="18" width="128" height="52" rx="5" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="2" />
      <path d="M140 34h34l24 22v14h-58z" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M148 40h22l15 14h-37z" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 72h192" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {[40, 70, 172].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="76" r="11" fill="var(--bg-card)" stroke="currentColor" strokeWidth="2.5" />
          <circle cx={cx} cy="76" r="4" fill="currentColor" fillOpacity=".5" />
        </g>
      ))}
    </svg>
  );
}
