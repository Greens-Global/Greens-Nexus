import { useState } from 'react';
import { ChevronDown, ArrowRight, Link2, Building2 } from 'lucide-react';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { cityRegion, typeLabel, tileStats, typeIcon, stageTone } from '../../lib/portfolioCards.js';
import { STAT_TOOLTIPS } from '../shared/StatCell.jsx';

const tagPill = (text, bg) => (
  <span style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 5, color: '#fff', backgroundColor: bg }}>
    {text}
  </span>
);

/**
 * Card-style Portfolio List-view row for a single (non-grouped, or already-expanded-child)
 * property. Also reused internally by ListGroupRow (below) to render each member of an expanded
 * group.
 *
 * NOT CURRENTLY WIRED UP: Portfolio.jsx's List view always renders ListTable.jsx instead - in
 * the original app this component (and ListGroupRow) were only reachable from a branch that's
 * unconditionally shadowed by the ListTable check, i.e. dead code already in the shipped app.
 * Ported faithfully anyway (exact original signature, including the `expanded`/`onToggle`/
 * `dropdownTrigger` props that only make sense if something re-wires this in as an alternate
 * card-style List view someday) since the task called out porting it - see Portfolio.jsx's note
 * on the same finding.
 *
 * `secondaries` (only meaningful when this row is NOT itself inside an already-expanded group,
 * i.e. rendered directly by Portfolio.jsx for a lead asset) drives the "Primary" tag + linked
 * count + expand/collapse chevron; `secondary` (only set when rendered as a child row inside
 * ListGroupRow) drives the "Secondary" tag instead. A row is never both at once.
 */
export function ListRow({ pr: asset, openProperty, secondaries = [], expanded, onToggle, secondary, dropdownTrigger }) {
  const stage = asset.devStage || 'Active';
  const tone = stageTone(stage);
  const photo = (asset.images && asset.images[0]) || asset.image || '';
  const stats = tileStats(asset);
  const Icon = typeIcon(asset);
  const isGroupLead = secondaries.length > 0;
  const borderLeft = isGroupLead ? '3px solid var(--pine)' : secondary ? '3px solid hsla(var(--color-purple), 0.5)' : '1px solid var(--border-color)';
  const isNonProperty = inferAssetKind(asset) !== 'property';
  const type = typeLabel(asset);

  // dropdownTrigger mode: clicking the row toggles the group's expand/collapse instead of
  // navigating (used when this row is the group LEAD and secondaries exist - see
  // ListGroupRow). Otherwise a click always opens the asset's detail page.
  const activate = () => (dropdownTrigger ? onToggle && onToggle() : openProperty(asset.id));

  return (
    <div
      tabIndex={0}
      role="button"
      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); } }}
      onClick={activate}
      title={dropdownTrigger ? 'Show linked properties' : 'Open property'}
      style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '11px 14px', borderRadius: 12,
        cursor: 'pointer', border: '1px solid var(--border-color)', borderLeft,
        backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
    >
      {photo ? (
        <img
          src={photo}
          alt={asset.name}
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
          style={{ flexShrink: 0, width: 52, height: 52, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border-color)' }}
        />
      ) : (
        <div style={{ flexShrink: 0, width: 52, height: 52, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pine)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
          <Icon size={22} />
        </div>
      )}

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {isGroupLead && tagPill('Primary', 'var(--pine)')}
          {secondary && tagPill('Secondary', 'hsl(var(--color-purple))')}
          <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{asset.name}</strong>
          <span style={{ fontSize: '0.62rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: `hsl(var(--color-${tone}))`, backgroundColor: `hsla(var(--color-${tone}), 0.12)` }}>
            {stage}
          </span>
          {isGroupLead && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.64rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)' }}>
              <Link2 size={10} />
              {secondaries.length} linked
            </span>
          )}
        </div>

        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isNonProperty ? (asset.color || asset.devStage || 'Vehicle') : `${type ? `${type} · ` : ''}${cityRegion(asset) || '-'}`}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 16px', marginTop: 7 }}>
          {stats.map((s, i) => (
            <span key={i} title={STAT_TOOLTIPS[s.l] || s.l} style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
              <strong style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{s.v}</strong> {s.l}
            </span>
          ))}
        </div>
      </div>

      {isGroupLead && onToggle ? (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          title={expanded ? 'Hide linked' : 'Show linked'}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, display: 'inline-flex', flexShrink: 0 }}
        >
          <ChevronDown size={18} style={{ color: 'var(--pine)', transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'none' }} />
        </button>
      ) : (
        <ArrowRight size={16} style={{ color: secondary ? 'hsl(var(--color-purple))' : 'var(--pine)', flexShrink: 0 }} />
      )}
    </div>
  );
}

/**
 * Portfolio List-view row for a LINKED GROUP (a lead asset with one or more secondaries): a
 * summary header ("N linked properties") that expands in place to show every member as its own
 * ListRow (lead flagged `secondary={false}`... first member unflagged, every member after it
 * flagged `secondary`). Always uses a generic building icon for the header photo fallback
 * (Building2) rather than a type-specific one, since the header represents the whole group, not
 * any single typed asset.
 */
export function ListGroupRow({ pr: lead, secondaries, openProperty }) {
  const [expanded, setExpanded] = useState(false);
  const members = [lead, ...secondaries];
  const photo = (lead.images && lead.images[0]) || lead.image || '';

  return (
    <div>
      <div
        onClick={() => setExpanded((e) => !e)}
        title={expanded ? 'Hide linked properties' : 'Show linked properties'}
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '11px 14px', borderRadius: 12,
          cursor: 'pointer', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--pine)',
          backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', transition: 'box-shadow 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
      >
        {photo ? (
          <img
            src={photo}
            alt=""
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
            style={{ flexShrink: 0, width: 52, height: 52, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border-color)' }}
          />
        ) : (
          <div style={{ flexShrink: 0, width: 52, height: 52, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pine)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
            <Building2 size={22} />
          </div>
        )}

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{lead.siteName || lead.name}</strong>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.64rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)' }}>
              <Link2 size={10} /> Linked group
            </span>
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2 }}>
            {members.length} linked properties
          </div>
        </div>

        <ChevronDown size={18} style={{ flexShrink: 0, color: 'var(--pine)', transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'none' }} />
      </div>

      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {members.map((m, i) => (
            <ListRow key={m.id} pr={m} openProperty={openProperty} secondary={i > 0} />
          ))}
        </div>
      )}
    </div>
  );
}
