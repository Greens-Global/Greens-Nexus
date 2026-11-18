import { ChevronRight } from 'lucide-react';
import { cityRegion, typeIcon } from '../../lib/portfolioCards.js';
import { stageInk } from '../../lib/portfolioQuery.js';

/**
 * One property on a phone (Neil, 11/17/2026): the photo as a thumbnail, the name, then
 * "City, ST · Stage" with the stage in its color, a chevron - hairline between rows, no card.
 * The whole row is the button.
 */
export function ListRow({ asset, open, selected = false }) {
  const photo = (asset.images && asset.images[0]) || asset.image || '';
  const Icon = typeIcon(asset);
  const name = asset.siteName && !asset.parentId ? asset.siteName : (asset.name || 'Unnamed property');
  const stage = String(asset.devStage || '').replace(/^Stabili[sz]ed\s*[-–]+\s*/i, '');
  const place = cityRegion(asset);
  return (
    <button type="button" className={`pt-prow${selected ? ' is-last' : ''}`} onClick={() => open(asset.id)}>
      <span className={`pt-prow-thumb${photo ? '' : ' is-empty'}`} aria-hidden="true">
        {photo ? <img src={photo} alt="" loading="lazy" decoding="async" /> : <Icon size={22} strokeWidth={1.5} />}
      </span>
      <span className="pt-prow-words">
        <span className="pt-prow-name">{name}</span>
        <span className="pt-prow-meta">
          {place}
          {place && stage ? ' · ' : ''}
          {stage && <span style={{ color: stageInk(asset.devStage) }}>{stage}</span>}
        </span>
      </span>
      <ChevronRight size={18} className="pt-prow-chev" aria-hidden="true" />
    </button>
  );
}

/** The phone list: one row per property, in the order the register sorted them. */
export function PhoneList({ rows, open, lastOpenedId }) {
  return (
    <div className="pt-phone-list" role="list" aria-label="Properties">
      {rows.map((a) => <div role="listitem" key={a.id}><ListRow asset={a} open={open} selected={a.id === lastOpenedId} /></div>)}
    </div>
  );
}
