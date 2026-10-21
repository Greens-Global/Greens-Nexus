import { assetSignals, freshMeta, freshTs } from '../../lib/assetMetrics.js';
import { StatusLabel } from '../../../components/StatusLabel.jsx';

// Tone -> label color. assetSignals() speaks ok/warn/bad/info/mut; freshMeta()
// speaks green/gold/mut (the two vocabularies were never reconciled, and the
// old grid rendered Freshness in `hsl(var(--color-undefined))`). Both land here.
const TONE_COLOR = {
  ok: 'hsl(var(--color-green))', green: 'hsl(var(--color-green))',
  warn: 'hsl(var(--color-orange))', gold: 'hsl(var(--color-gold))',
  bad: 'hsl(var(--color-red))', info: 'hsl(var(--color-blue))',
};
export function colorOf(tone) {
  return TONE_COLOR[tone] || '#64748b';
}

/**
 * Health signals under the asset's name - Insurance / Inspections / Permits /
 * Debt / Freshness for a property, Insurance / Registration / Service /
 * Odometer / Freshness for a vehicle - each one Nexus's soft StatusLabel
 * (dot, deep shade, faint tint), wrapping on a phone like any label row.
 */
export function HealthStrip({ p, store, logs }) {
  const signals = assetSignals(p, store);
  const fresh = freshMeta(freshTs(logs, p.id));
  const items = [...signals, { l: 'Freshness', v: fresh.txt, t: fresh.tone }];
  return (
    <div className="health-wrap" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {items.map((item) => (
        <StatusLabel key={item.l} label={`${item.l}: ${item.v}`} color={colorOf(item.t)} size="sm" title={item.l} />
      ))}
    </div>
  );
}
