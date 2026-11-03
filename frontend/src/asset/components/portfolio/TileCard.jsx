import { useRef, useLayoutEffect, useId, memo } from 'react';
import { Link2 } from 'lucide-react';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { cityRegion, typeLabel, tileStats, typeIcon, stageTone, stageMetric } from '../../lib/portfolioCards.js';
import { parcelAcres } from '../../lib/parcelGrouping.js';
import { toNumber } from '../../lib/format.js';
import { fleetStatusColor, fleetIdLine, initialsOf, fleetMeter, fleetFactsFor } from '../../lib/fleetCards.js';
import { relativeTime } from '../../../components/audit/auditModel.js';
import { StatusLabel } from '../../../components/StatusLabel.jsx';
import ProgressTrack from '../../../ui/ProgressTrack';

// A stable empty list, so a card with no linked parcels keeps its memo between renders.
const NONE = [];

// Shared pill style for the two badges that float over the photo (parcel-count / Private, and
// the stage chip) - same shape, different content/positioning per-badge.
const photoPill = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: '0.7rem',
  fontWeight: 700,
  color: '#fff',
  padding: '4px 10px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
};

/**
 * Portfolio Tiles-view card. When `secondaries` is non-empty this is a GROUP card: it shows the
 * group's PRIMARY member (or the first member if none is flagged primary) as the "lead" face of
 * the card, with stats aggregated (summed) across every member, plus a stacked-card visual
 * effect (two faux card edges peeking out behind it) and a "N parcels" badge.
 *
 * Title sizing: the card title's font-size shrinks in steps as the name gets longer, and the
 * title may WRAP to a second line (Neil, Aug 11: the name must not get cut off - with the
 * sidebar open the cards narrow enough that a single nowrap line ellipsized real names).
 * The fit effect below then shrinks the font until the text fits within its two lines; the
 * line-clamp's own ellipsis stays as the last resort for pathological names at the 10px floor.
 */
function PropertyTile({ pr: property, openProperty, secondaries = [], metric = null }) {
  const isGroup = secondaries.length > 0;

  // Group members in parcelOrder (falling back to array position for members that have never
  // been explicitly reordered) - see the group-first parcel-linking model in ParcelManager.jsx.
  const members = [property, ...secondaries]
    .map((m, i) => [m, m.parcelOrder == null ? i : m.parcelOrder])
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
  const lead = members.find((m) => m.primary) || members[0] || property;

  const totalAcres = members.reduce((sum, m) => sum + parcelAcres(m), 0);
  const totalUnits = members.reduce((sum, m) => {
    const explicit = toNumber(m.unitsTotal);
    return sum + (explicit || toNumber(m.unitsClimate) + toNumber(m.unitsNonClimate) + toNumber(m.unitsRV));
  }, 0);

  // For a group, stats are computed off an aggregate pseudo-asset (lead's identity fields, but
  // acreage/nrsf/unit counts summed across every member) rather than the lead alone.
  const statSource = isGroup
    ? {
        ...lead,
        acreage: totalAcres,
        nrsf: members.reduce((sum, m) => sum + toNumber(m.nrsf), 0),
        gsf: members.reduce((sum, m) => sum + toNumber(m.gsf), 0),
        unitsClimate: members.reduce((sum, m) => sum + toNumber(m.unitsClimate), 0),
        unitsNonClimate: members.reduce((sum, m) => sum + toNumber(m.unitsNonClimate), 0),
        unitsRV: members.reduce((sum, m) => sum + toNumber(m.unitsRV), 0),
        unitsTotal: totalUnits,
      }
    : lead;

  const stage = lead.devStage || 'Active';
  const tone = stageTone(stage);
  const type = typeLabel(lead);
  const Icon = typeIcon(lead);
  // The number that matters for the stage leads (Lease-Up / Stabilized: occupancy;
  // Construction: % complete) when the server has it; the size figures follow.
  const leadStat = stageMetric(stage, metric);
  const stats = leadStat ? [leadStat, ...tileStats(statSource)] : tileStats(statSource);
  const title = isGroup && lead.siteName ? lead.siteName : lead.name;
  const isNonProperty = inferAssetKind(lead) !== 'property';
  const subtitle = isNonProperty ? (String(lead.yearBuilt || '') || lead.devStage || '') : (cityRegion(lead) || '-');
  const photo = (lead.images && lead.images[0]) || lead.image || '';
  const openLead = () => openProperty(lead.id);

  // Stat tiles: prefer up to 4 stats that actually have a value; if NONE do, fall back to
  // showing the first 3 regardless (so the grid isn't empty for a barely-filled-in asset).
  let visibleStats = stats.filter((s) => s.v && s.v !== '-').slice(0, 4);
  if (!visibleStats.length) visibleStats = stats.slice(0, 3);

  const titleFontSize =
    (title || '').length > 34 ? '0.74rem'
    : (title || '').length > 30 ? '0.82rem'
    : (title || '').length > 26 ? '0.9rem'
    : (title || '').length > 22 ? '0.98rem'
    : (title || '').length > 18 ? '1.06rem'
    : '1.18rem';

  // The char-count size above is a good first guess, but the title shares its row with the
  // status badge, so the real space available depends on card width AND badge width (a long
  // "Stabilized - Renovation" pill leaves much less room than "Stabilized"). The title wraps
  // to at most two lines; if it STILL overflows (scrollHeight beyond the clamped box), shrink
  // the font until the two lines hold it - Neil's "resize down a bit if needed". Re-fits
  // whenever the card resizes (responsive column count, sidebar opening/closing).
  const titleRef = useRef(null);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const box = el.parentElement; // the flex:1 container whose width changes with the card
    const fit = () => {
      el.style.fontSize = titleFontSize; // reset to the char-count base, then shrink to fit
      let px = parseFloat(getComputedStyle(el).fontSize);
      let guard = 0;
      while (el.scrollHeight > el.clientHeight + 1 && px > 10 && guard++ < 40) {
        px -= 0.5;
        el.style.fontSize = px + 'px';
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (box) ro.observe(box);
    return () => ro.disconnect();
  }, [title, titleFontSize]);

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {/* Stacked-card effect: two faux card edges peeking out from behind the lead card, to
          suggest "there's more underneath" for a linked group. Purely decorative (z-index 0). */}
      {isGroup && (
        <>
          <div style={{ position: 'absolute', left: 16, right: 16, bottom: -9, height: 18, borderRadius: 13, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', zIndex: 0 }} />
          <div style={{ position: 'absolute', left: 9, right: 9, bottom: -4, height: 18, borderRadius: 14, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', zIndex: 0 }} />
        </>
      )}

      <div
        className="asset-card"
        role="button"
        tabIndex={0}
        aria-label={`Open ${title}`}
        onClick={openLead}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLead(); } }}
        style={{
          position: 'relative', zIndex: 1,
          backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14,
          boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%',
        }}
      >
        {/* Photo header: real photo (cover-fit for real estate, contain-fit + white background
            for vehicles/equipment, since those photos are usually product shots, not scenery)
            or, with no photo, a large faint icon watermark on a dark gradient. */}
        <div
          style={{
            position: 'relative', minHeight: 152, padding: '12px 14px 13px 16px',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8,
            background: photo
              ? `linear-gradient(180deg, rgba(15,23,42,.10) 0%, rgba(13,20,34,.48) 54%, rgba(8,12,22,.92) 100%), url("${photo}") ${isNonProperty ? 'center/contain' : 'center 30%/cover'} no-repeat${isNonProperty ? ' #ffffff' : ''}`
              : 'linear-gradient(150deg, #202c47 0%, #0d1422 100%)',
            overflow: 'hidden',
          }}
        >
          {!photo && <Icon size={120} style={{ position: 'absolute', right: -14, top: 4, color: '#fff', opacity: 0.07 }} />}

          <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ flexShrink: 0, display: 'inline-flex', color: 'rgba(255,255,255,0.96)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' }}>
              <Icon size={26} strokeWidth={1.7} />
            </span>
            {isGroup ? (
              <span style={{ ...photoPill, backgroundColor: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.22)' }}>
                <Link2 size={11} />
                {members.length + ' parcels'}
              </span>
            ) : lead.private ? (
              <span style={{ ...photoPill, fontSize: '0.68rem', padding: '3px 8px', backgroundColor: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.18)' }}>
                Private
              </span>
            ) : null}
          </div>

          <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3
                ref={titleRef}
                title={title}
                style={{
                  fontSize: titleFontSize, fontWeight: 800, color: '#fff', margin: 0, lineHeight: 1.16, textShadow: '0 1px 3px rgba(0,0,0,.5)',
                  // Wrap up to two lines rather than ellipsize one - the clamp's own "…" only
                  // appears if a name overflows two lines even at the fit-loop's 10px floor.
                  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere',
                }}
              >
                {title}
              </h3>
              <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.85)', marginTop: 2, textShadow: '0 1px 2px rgba(0,0,0,.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {subtitle}
              </div>
            </div>
            <span style={{ ...photoPill, flexShrink: 0, backgroundColor: 'rgba(0,0,0,0.46)', border: '1px solid rgba(255,255,255,0.14)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: `hsl(var(--color-${tone}))` }} />
              {stage}
            </span>
          </div>
        </div>

        <div style={{ padding: '14px 18px 14px', display: 'flex', flexDirection: 'column', gap: 13, flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {type && (
              <div style={{ minWidth: 0, fontSize: '0.8rem', fontWeight: 600, letterSpacing: '-0.005em', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {type}
              </div>
            )}
            {(lead.entity || lead.manager) && (
              <div style={{ display: 'grid', gridTemplateColumns: lead.entity && lead.manager ? '1fr 1fr' : '1fr', gap: '2px 16px' }}>
                {lead.entity && (
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-secondary)', marginBottom: 2 }}>Owner</div>
                    <div style={{ fontSize: '0.83rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', lineHeight: 1.3 }}>
                      {lead.entity}
                    </div>
                  </div>
                )}
                {lead.manager && (
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-secondary)', marginBottom: 2 }}>Asset Manager</div>
                    <div style={{ fontSize: '0.83rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word', lineHeight: 1.3 }}>
                      {lead.manager}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* minmax(0, 1fr), not 1fr: style.css's phone guard stacks any inline
              "repeat(3, 1fr)", which turned three stats into three tall rows (Oct 17). */}
          <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: `repeat(${visibleStats.length}, minmax(0, 1fr))`, gap: '12px', borderTop: '1px solid var(--border-color)', paddingTop: 13 }}>
            {visibleStats.map((s, i) => {
              const valStr = String(s.v == null ? '' : s.v);
              const valFontSize = valStr.length > 12 ? '0.72rem' : valStr.length > 9 ? '0.85rem' : '1.06rem';
              return (
                <div key={i} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: valFontSize, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.18, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                    {s.v}
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.l}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
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
export const TileCard = memo(function TileCard({ pr, openProperty, secondaries = NONE, metric = null, store = null, fleet = null, selected = false }) {
  if (inferAssetKind(pr) !== 'property' && !secondaries.length) {
    const facts = fleet || fleetFactsFor([pr], store || {})[pr.id];
    return <FleetTile asset={pr} openProperty={openProperty} facts={facts} selected={selected} />;
  }
  return <PropertyTile pr={pr} openProperty={openProperty} secondaries={secondaries} metric={metric} />;
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
