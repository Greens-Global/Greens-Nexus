// Monospace font stack shared with StatusBadge's renewalCell date text.
const MONO_FONT = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

const LABEL_STYLE = {
  fontSize: '0.64rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-secondary)',
};

/** Label -> tooltip text shown on hover/title for StatCell's label line. */
export const STAT_TOOLTIPS = {
  Acres: 'Site size in acres',
  NRSF: 'Net Rentable Square Feet',
  RSF: 'Rentable Square Feet',
  'GLA SF': 'Gross Leasable Area (square feet)',
  GSF: 'Gross Square Feet',
  Storage: 'Storage units',
  Units: 'Total units',
  Vehicle: 'Vehicle / boat / RV spaces',
  'RV / Boat': 'RV / boat spaces',
  Total: 'Total units',
  Stories: 'Number of stories',
  Built: 'Year built',
  Flood: 'FEMA flood zone',
};

/** Small value/label stat pair (e.g. property snapshot stat tiles). `big` bumps up value emphasis. */
export function StatCell({ v, l, big }) {
  return (
    <div title={STAT_TOOLTIPS[l] || l}>
      <div style={{ fontFamily: MONO_FONT, fontWeight: big ? 700 : 600, fontSize: big ? '1rem' : '0.82rem', color: 'var(--text-primary)' }}>
        {v}
      </div>
      <div style={{ ...LABEL_STYLE, marginTop: 2, cursor: 'help' }}>
        {l}
      </div>
    </div>
  );
}
