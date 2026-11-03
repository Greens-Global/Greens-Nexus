// The health row on a project card and the project page (Neil, 11/03/2026,
// plan item 15): Late / At Risk / On Track as a soft label, then the facts a
// manager acts on - days past target, the next milestone and how far off it
// is, overdue RFIs, and when the crew last filed ("No log in 3 days").
// The rule is the server's (construction_health.py); this only shows it.
import { StatusLabel } from '../components/StatusLabel';
import { HEALTH, healthFacts } from './lib/health';

const INK = { bad: 'hsl(var(--color-red))', warn: 'var(--text-primary)' };

export default function HealthRow({ health, compact = false, overBudget = false }) {
  if (!health) return null;
  const meta = HEALTH[health.state] || HEALTH.on_track;
  const facts = healthFacts(health, { overBudget });
  return (
    <div data-health-row="" style={{ display: 'flex', alignItems: 'center', gap: '6px 12px', flexWrap: 'wrap', fontSize: compact ? '0.78rem' : '0.82rem', color: 'var(--text-secondary)' }}>
      <StatusLabel label={meta.label} color={meta.color} size={compact ? 'sm' : 'md'}
        title={(health.reasons || []).join('; ') || undefined} />
      {facts.map((f, i) => (
        <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: INK[f.tone] || undefined, fontWeight: f.tone ? 600 : 400 }}>
          {i > 0 && <span aria-hidden="true" style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>·</span>}
          {f.text}
        </span>
      ))}
    </div>
  );
}
