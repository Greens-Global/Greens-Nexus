/**
 * Read-only reference list of a vehicle/equipment asset's researched factory maintenance
 * schedule (asset.maintenanceSchedule = { items: [{ item, interval, note }], source, researchedOn }).
 * This is informational only - it does not create or link to actual service records.
 */
export function RecommendedMaintenance({ p: asset }) {
  const schedule = asset.maintenanceSchedule;
  if (!schedule || !schedule.items || !schedule.items.length) return null;

  return (
    <div style={{ marginBottom: 16, border: '1px solid var(--border-color)', borderRadius: 12, backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
        <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>Recommended Maintenance</strong>
        <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--text-muted)' }}>Factory schedule · reference only</span>
      </div>

      <div>
        {schedule.items.map((it, i) => (
          <div key={i} style={{ padding: '9px 16px', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
            {/*
              IMPORTANT: this row must WRAP, not clip. Interval text can be long
              (e.g. "Every 30,000 miles or 24 months, whichever comes first") and a
              fixed-width/no-wrap layout used to hard-clip it. flexWrap:'wrap' + rowGap:0
              lets the interval drop to its own line under the item name on narrow
              viewports instead of being cut off, while both stay on one line when there's room.
            */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 4, rowGap: 0 }}>
              <span style={{ flex: '1 1 160px', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{it.item}</span>
              <span style={{ flex: '0 1 auto', fontSize: '0.8rem', fontWeight: 700, color: 'hsl(var(--color-blue))', textAlign: 'right', marginLeft: 'auto' }}>
                {it.interval}
              </span>
            </div>
            {it.note && <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2 }}>{it.note}</div>}
          </div>
        ))}
      </div>

      {(schedule.source || schedule.researchedOn) && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          {schedule.source || '-'}
          {schedule.researchedOn ? ` · researched ${schedule.researchedOn}` : ''}
        </div>
      )}
    </div>
  );
}
