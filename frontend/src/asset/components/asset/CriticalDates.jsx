import { useState } from 'react';
import { collectCriticalDates, CRITICAL_ITEM_TAB } from '../../lib/criticalItems.js';
import { formatDate } from '../../lib/format.js';

// Overdue/Due-soon pill tone by signed day-count. Distinct from HealthStrip's ok/warn/bad/info
// tone vocabulary — this component uses color names directly (red/orange/gold/green) since it
// talks to CSS custom properties (--color-red etc.) rather than through a tone-name indirection.
function toneOf(days) {
  if (days < 0) return 'red';
  if (days <= 30) return 'orange';
  if (days <= 90) return 'gold';
  return 'green';
}

function dueText(days) {
  if (days < 0) return Math.abs(days) + 'd overdue';
  if (days === 0) return 'Due today';
  return 'Due in ' + days + 'd';
}

/** Small count pill, e.g. "3 Overdue". Greys out (mut) when the count is 0. */
function CountPill({ count, label, color }) {
  const active = count > 0;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: '0.72rem',
        fontWeight: 700,
        whiteSpace: 'nowrap',
        color: active ? `hsl(var(--color-${color}))` : 'var(--text-muted)',
        backgroundColor: active ? `hsla(var(--color-${color}), 0.12)` : 'var(--bg-secondary)',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: active ? `hsl(var(--color-${color}))` : 'var(--text-muted)',
        }}
      />
      {count} {label}
    </span>
  );
}

/** Window-selector chip (Overdue / Next 30 / Next 90 / All). Highlighted blue when active. */
function WindowChip({ value, label, active, onSelect }) {
  return (
    <button
      onClick={() => onSelect(value)}
      style={{
        padding: '5px 11px',
        borderRadius: 999,
        fontSize: '0.74rem',
        fontWeight: 600,
        cursor: 'pointer',
        border: active ? '1px solid transparent' : '1px solid var(--border-color)',
        color: active ? '#fff' : 'var(--text-secondary)',
        background: active ? 'hsl(var(--color-blue))' : 'var(--bg-card)',
      }}
    >
      {label}
    </button>
  );
}

/**
 * Critical Items alert: Overdue / Due<=30d / Due<=90d count pills, an expandable list of every
 * dated compliance item in the chosen window, a category filter, and a window selector
 * (Overdue / Next 30 / Next 90 / All upcoming).
 *
 * USED IN TWO PLACES with different prop wiring:
 *
 *   1. Per-asset (asset detail page): pass `only={asset.id}` and `onTab={fn}`. Scopes the list
 *      to one asset and defaults the window to "All" (there's no need to hide far-out dates when
 *      you're already looking at this one asset's full compliance picture). Clicking a row calls
 *      `onTab(tab)` to switch to the relevant in-page tab (e.g. the Warranties tab), via
 *      CRITICAL_ITEM_TAB's category->tab mapping. Always rendered, even when nothing is due —
 *      it's part of the page's fixed layout, and an all-green strip is itself useful context.
 *
 *   2. Portfolio-wide (asset list page): omit `only` (scans every asset in the store) and pass
 *      `hideIfEmpty`. Defaults the window to "Due <=90 days" (a portfolio banner should lead with
 *      what's actually urgent, not the entire multi-year backlog). Clicking a row calls
 *      `openProperty(id)` to navigate to that asset instead of switching a tab — there's no
 *      single page/tab context to switch within on the portfolio view. Positioned between the
 *      "Asset Management" header and the search/filter toolbar; `hideIfEmpty` makes the whole
 *      component render as `null` there so the banner only ever appears when something is
 *      genuinely due — an always-visible portfolio banner would just be permanent green noise
 *      (unlike the per-asset case, where showing "all clear" for one specific asset is
 *      reassuring, not noise).
 *
 * `hideIfEmpty` is deliberately NOT the default and must be opted into per call site — do not
 * flip its default, or the per-asset usage will start disappearing on clean assets.
 */
export function CriticalDates({ store, openProperty, only, onTab, hideIfEmpty }) {
  const [open, setOpen] = useState(false);
  // Per-asset view starts on "All" (nothing to triage away); portfolio view starts on "Next 90
  // days" (lead with what's actually urgent across the whole portfolio).
  const [windowSel, setWindowSel] = useState(only ? 'all' : '90');
  const [cat, setCat] = useState('');

  let all = collectCriticalDates(store);
  if (only) all = all.filter((x) => x.id === only);

  const overdueCount = all.filter((x) => x.days < 0).length;
  const due30Count = all.filter((x) => x.days >= 0 && x.days <= 30).length;
  const due90Count = all.filter((x) => x.days >= 0 && x.days <= 90).length;

  // Portfolio banner usage: nothing due at all -> render nothing. Per-asset usage never sets
  // hideIfEmpty, so it always falls through and renders (even all-zero, for context).
  if (hideIfEmpty && !overdueCount && !due30Count && !due90Count) return null;

  const categories = [...new Set(all.map((x) => x.cat))].sort();

  const inWindow = (x) => {
    if (windowSel === 'all') return true;
    if (windowSel === 'overdue') return x.days < 0;
    if (windowSel === '30') return x.days <= 30;
    return x.days <= 90;
  };
  const rows = all.filter(inWindow).filter((x) => !cat || x.cat === cat);

  const handleRowClick = (item) => {
    const tab = CRITICAL_ITEM_TAB[item.cat];
    if (onTab && tab) onTab(tab);
    else if (openProperty) openProperty(item.id);
  };

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          Critical Items
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <CountPill count={overdueCount} label="Overdue" color="red" />
          <CountPill count={due30Count} label="Due ≤30d" color="orange" />
          <CountPill count={due90Count} label="Due ≤90d" color="gold" />
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            marginLeft: 'auto',
            padding: '5px 11px',
            borderRadius: 8,
            fontSize: '0.74rem',
            fontWeight: 600,
            cursor: 'pointer',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-secondary)',
          }}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <WindowChip value="overdue" label="Overdue" active={windowSel === 'overdue'} onSelect={setWindowSel} />
            <WindowChip value="30" label="Next 30 Days" active={windowSel === '30'} onSelect={setWindowSel} />
            <WindowChip value="90" label="Next 90 Days" active={windowSel === '90'} onSelect={setWindowSel} />
            <WindowChip value="all" label="All Upcoming" active={windowSel === 'all'} onSelect={setWindowSel} />
            <select
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              className="form-input"
              style={{ marginLeft: 'auto', padding: '5px 10px', fontSize: '0.76rem', maxWidth: 190 }}
            >
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {rows.length ? (
            <div
              style={{
                maxHeight: 340,
                overflowY: 'auto',
                marginTop: 10,
                border: '1px solid var(--border-color)',
                borderRadius: 8,
              }}
            >
              {rows.map((item, i) => (
                <div
                  key={item.id + '|' + item.cat + '|' + i}
                  onClick={() => handleRowClick(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderTop: i ? '1px solid var(--border-color)' : 'none',
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      minWidth: 98,
                      textAlign: 'center',
                      padding: '4px 8px',
                      borderRadius: 6,
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      color: `hsl(var(--color-${toneOf(item.days)}))`,
                      backgroundColor: `hsla(var(--color-${toneOf(item.days)}), 0.12)`,
                    }}
                  >
                    {dueText(item.days)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '0.84rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.name}
                    </div>
                    <div
                      style={{
                        fontSize: '0.74rem',
                        color: 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.cat} · {item.label}
                      {item.detail ? ' — ' + item.detail : ''}
                    </div>
                  </div>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatDate(item.date)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                marginTop: 10,
                padding: '16px',
                fontSize: '0.82rem',
                fontWeight: 600,
                color: 'hsl(var(--color-green))',
                textAlign: 'center',
              }}
            >
              All clear — nothing due in this window.
            </div>
          )}
        </>
      )}
    </div>
  );
}
