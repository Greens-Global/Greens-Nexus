import { assetSignals, freshMeta, freshTs } from '../../lib/assetMetrics.js';

// Tone -> CSS color. 'mut' (no data) uses the flat muted text color; everything else is one of
// the --color-* HSL triples defined in styles.css, read through hsl(var(--color-NAME)).
//
// PRESERVED-AS-IS BUG: assetSignals() only ever produces t values from this map's key set
// (ok/warn/bad/info) or 'mut'. But freshMeta() (the trailing "Freshness" item) returns tone
// values 'green' | 'gold' | 'mut' instead — a different vocabulary that was never reconciled
// with this map. Since 'green'/'gold' aren't keys here, TONE_COLOR[tone] is undefined for a
// fresh/aging asset, and the Freshness value renders as `hsl(var(--color-undefined))` (an
// invalid CSS custom property reference, which the browser silently ignores and falls back to
// the inherited text color). This reproduces the original app's behavior exactly; flagging it
// here rather than "fixing" it since this is a faithful port, not a redesign. The likely
// intended fix is either mapping green/gold through directly, or changing freshMeta's tone
// vocabulary to ok/warn/mut to match — worth raising with the team before touching it, since
// downstream code may already be depending on freshMeta's current tone strings.
const TONE_COLOR = {
  ok: 'green',
  warn: 'orange',
  bad: 'red',
  info: 'blue',
};

function colorOf(tone) {
  if (tone === 'mut') return 'var(--text-muted)';
  return `hsl(var(--color-${TONE_COLOR[tone]}))`;
}

/**
 * Health Status strip — the KPI-card row at the top of every asset detail page:
 * Insurance / Inspections / Permits / Debt / Freshness for properties,
 * Insurance / Registration / Service / Odometer / Freshness for vehicles/equipment.
 *
 * REDESIGN HISTORY: this used to render as two separate flex rows — one row of all labels,
 * one row of all values below it — laid out with an exact-column-count CSS grid shared by both
 * rows. That broke on mobile: narrow columns truncated labels to "INSUR…" and wrapped values
 * mid-word, and the two rows could drift out of alignment independently. It was rebuilt as a
 * SINGLE grid where each item is a self-contained card (label + value together in one cell) —
 * so a column is never narrower than one whole card, and label/value always stay paired. The
 * `health-wrap` / `health-grid` classNames exist specifically so styles.css's mobile media query
 * can override `gridTemplateColumns` to `repeat(auto-fit, minmax(104px,1fr))` and turn each cell
 * into its own bordered card — do not remove them or the mobile layout silently reverts to the
 * cramped desktop column count.
 */
export function HealthStrip({ p, store, logs }) {
  const signals = assetSignals(p, store);
  const fresh = freshMeta(freshTs(logs, p.id));
  const items = [...signals, { l: 'Freshness', v: fresh.txt, t: fresh.tone }];

  return (
    <div
      className="health-wrap"
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: 10,
        background: 'var(--bg-card)',
        boxShadow: 'var(--shadow-sm)',
        marginTop: 8,
        overflow: 'hidden',
      }}
    >
      {/* Desktop: one row, N equal columns. Mobile override (styles.css) switches this to
          repeat(auto-fit, minmax(104px,1fr)) so cards wrap onto multiple rows instead of
          squeezing N columns into a phone-width screen. */}
      <div
        className="health-grid"
        style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)` }}
      >
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              padding: '6px 10px 7px',
              // Vertical divider between cards on desktop; the mobile override replaces this
              // with a full border around each card (see .health-grid > div in styles.css).
              borderLeft: i ? '1px solid var(--border-color)' : 'none',
            }}
          >
            <div
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {item.l}
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                fontWeight: 700,
                color: colorOf(item.t),
                lineHeight: 1.25,
                marginTop: 1,
                wordBreak: 'break-word',
              }}
            >
              {item.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
