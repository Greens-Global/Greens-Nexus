// The site model panel's KPI block (Visesh, Oct 20 2026: "do the KPIs
// differently and the tenant data differently so that both of it is looked
// upon properly"). One stacked bar that is also the legend - a click on a
// segment (or its row) shows only those units on the map - then a calm row of
// money figures and the live line. While a unit is open the block folds into
// one line so the unit's card sits at the top; a click opens it again.
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { pct } from './panelModel.js';


const usd = (c) => `$${Math.round((c || 0) / 100).toLocaleString('en-US')}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const CSS = `
.smk{display:flex;flex-direction:column;gap:10px}
.smk-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.smk-title{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#5f6358);font-weight:700;margin:0}
.smk-bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--bg-secondary,#eef0ec);gap:2px}
.smk-seg{border:0;padding:0;cursor:pointer;min-width:4px;transition:opacity .15s,filter .15s}
.smk-seg:hover{filter:brightness(.92)}
.smk-seg:focus-visible,.smk-row:focus-visible,.smk-fold:focus-visible{outline:2px solid #2a78d6;outline-offset:1px}
.smk-bar[data-focus="true"] .smk-seg:not([aria-pressed="true"]){opacity:.3}
.smk-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.smk-row{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;border-radius:6px;padding:4px 6px;margin:0 -6px;box-sizing:content-box;font:inherit;font-size:13px;color:inherit;cursor:pointer;text-align:left}
.smk-row:hover{background:var(--bg-secondary,#eef0ec)}
.smk-row[aria-pressed="true"]{background:var(--bg-secondary,#eef0ec);font-weight:600}
.smk-dot{width:10px;height:10px;border-radius:3px;flex:none}
.smk-n{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
.smk-p{width:46px;text-align:right;color:var(--text-muted,#5f6358);font-variant-numeric:tabular-nums;font-size:12px}
.smk-money{display:grid;grid-template-columns:1fr 1fr;gap:1px;border:1px solid var(--border-color,#d9d6cc);border-radius:10px;overflow:hidden;background:var(--border-color,#d9d6cc)}
.smk-m{background:var(--bg-primary,#fff);padding:8px 10px;min-width:0}
.smk-m b{display:block;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.smk-m span{display:block;font-size:11px;color:var(--text-muted,#5f6358);margin-top:1px}
.smk-fold{display:flex;align-items:center;gap:8px;width:100%;border:1px solid var(--border-color,#d9d6cc);border-radius:10px;background:var(--bg-primary,#fff);padding:7px 10px;font:inherit;font-size:12.5px;color:inherit;cursor:pointer;text-align:left}
.smk-fold:hover{background:var(--bg-secondary,#eef0ec)}
.smk-fold-t{flex:1;min-width:0;font-variant-numeric:tabular-nums;line-height:1.4}
.smk-i{display:inline-grid;place-items:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--text-muted,#5f6358);cursor:pointer;padding:0}
.smk-i:hover{background:var(--bg-secondary,#eef0ec)}
`;

/**
 * buckets   [{ key, label, color, count, units }] - the bar and its legend
 * total     what the percentages are of (the bar's own sum when omitted)
 * title     "Inventory · 807 Units" etc.
 * kpis      the money line (unit_map.facility_kpis) or null (Asset Management)
 */
export function SiteModelKpis({ buckets, title, total, info = '', kpis = null, focusKey = null, onFocus, liveLine, liveOk, collapsed = false, summary = '', onToggle, note = '' }) {
  const [showInfo, setShowInfo] = useState(false);
  const sum = total || buckets.reduce((a, b) => a + b.count, 0);
  const pick = (k) => onFocus?.(focusKey === k ? null : k);
  const focused = buckets.find((b) => b.key === focusKey);
  if (collapsed) {
    return (
      <section className="smk">
        <style>{CSS}</style>
        <button type="button" className="smk-fold" onClick={onToggle} aria-expanded="false" title="Show the property's figures">
          <span className="smk-fold-t">{summary}</span><ChevronDown size={15} aria-hidden="true" />
        </button>
      </section>
    );
  }
  const month = kpis?.month ? MONTHS[Number(kpis.month.slice(5, 7)) - 1] : '';
  return (
    <section className="smk" aria-label="Property Figures">
      <style>{CSS}</style>
      <div className="smk-head">
        <h2 className="smk-title">{title}</h2>
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {info ? <button type="button" className="smk-i" aria-label="What the colors mean" aria-expanded={showInfo} title={info} onClick={() => setShowInfo(!showInfo)}><Info size={15} aria-hidden="true" /></button> : null}
          {onToggle ? <button type="button" className="smk-i" aria-label="Fold the figures" title="Fold" onClick={onToggle}><ChevronUp size={15} aria-hidden="true" /></button> : null}
        </span>
      </div>
      {showInfo && info ? <p style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', margin: '-4px 0 0', lineHeight: 1.45 }}>{info}</p> : null}
      {sum ? (
        <div className="smk-bar" role="group" aria-label="Show these units on the map" data-focus={!!focused}>
          {buckets.filter((b) => b.count).map((b) => (
            <button key={b.key} type="button" className="smk-seg" aria-pressed={focusKey === b.key} onClick={() => pick(b.key)}
              title={`${b.label}: ${b.count} (${pct(b.count, sum)}) - click to show only these on the map`}
              style={{ flex: `${b.count} 1 0`, background: b.color }} aria-label={`${b.label}, ${b.count}`} />
          ))}
        </div>
      ) : null}
      <ul className="smk-rows">
        {buckets.map((b) => (
          <li key={b.key}>
            <button type="button" className="smk-row" aria-pressed={focusKey === b.key} onClick={() => pick(b.key)} disabled={!b.count && !b.always}
              style={!b.count ? { cursor: 'default', opacity: 0.6 } : undefined}>
              <i className="smk-dot" style={{ background: b.color }} />{b.label}
              <span className="smk-n">{b.count}</span><span className="smk-p">{pct(b.count, sum)}</span>
            </button>
          </li>
        ))}
      </ul>
      {note ? <div style={{ fontSize: 12, color: 'var(--text-muted, #5f6358)', marginTop: -4 }}>{note}</div> : null}
      {focused ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: -4 }}>
          <span style={{ color: 'var(--text-muted, #5f6358)' }}>Showing {focused.label} only on the map.</span>
          <button type="button" onClick={() => onFocus?.(null)} style={{ border: 0, background: 'transparent', color: '#1f6f4a', font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: 0 }}>Show All</button>
        </div>
      ) : null}
      {kpis ? (
        <div className="smk-money">
          <div className="smk-m"><b>{usd(kpis.rentRoll)}</b><span>Monthly Rent Roll</span></div>
          <div className="smk-m"><b style={{ color: kpis.pastDue ? '#b42318' : undefined }}>{usd(kpis.pastDue)}</b><span>Past Due{kpis.pastDueTenants ? ` · ${kpis.pastDueTenants} Tenant${kpis.pastDueTenants === 1 ? '' : 's'}` : ''}</span></div>
          <div className="smk-m" title="Rent of the leased units over the street rate of every rentable unit"><b>{kpis.economicPct == null ? '-' : `${kpis.economicPct}%`}</b><span>Economic Occupancy</span></div>
          <div className="smk-m"><b>{kpis.moveIns} / {kpis.moveOuts}</b><span>Move-Ins / Move-Outs{month ? `, ${month}` : ''}</span></div>
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: liveOk ? '#3f8f5f' : 'var(--text-muted, #5f6358)' }}>
        <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, marginRight: 6, verticalAlign: 0, background: liveOk ? '#3f8f5f' : '#b8b4a8' }} />{liveLine}
      </div>
    </section>
  );
}

const ATT_CSS = `
.sma{border:1px solid #f1c9c3;border-radius:10px;background:#fff7f5;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.sma-head{display:flex;align-items:center;gap:10px}
.sma-n{font-size:26px;font-weight:700;line-height:1;color:#b42318;font-variant-numeric:tabular-nums}
.sma-t{font-size:13px;font-weight:600;color:#7a271a;line-height:1.25}
.sma-sub{font-size:11.5px;color:#8a5a52}
.sma-groups{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.sma-g{display:flex;align-items:baseline;gap:8px;width:100%;border:0;background:transparent;border-radius:6px;padding:4px 6px;margin:0 -6px;box-sizing:content-box;font:inherit;font-size:12.5px;color:#3d2a26;cursor:pointer;text-align:left}
.sma-g:hover{background:#fbe4df}
.sma-g[aria-pressed="true"]{background:#f9d7d0;font-weight:600}
.sma-g:focus-visible,.sma-u:focus-visible,.sma-fold:focus-visible{outline:2px solid #2a78d6;outline-offset:1px}
.sma-g-l{flex:1;min-width:0;overflow-wrap:anywhere}
.sma-g-n{font-variant-numeric:tabular-nums;font-weight:700;color:#b42318}
.sma-units{list-style:none;margin:2px 0 4px 14px;padding:0;display:flex;flex-direction:column;gap:1px}
.sma-units li{display:flex;gap:6px;align-items:baseline;font-size:12px}
.sma-u{border:0;background:transparent;font:500 12px ui-monospace,Menlo,monospace;color:#1f6f4a;cursor:pointer;padding:2px 4px;flex:none}
.sma-note{color:#6b5a55;min-width:0;overflow-wrap:anywhere;line-height:1.35}
.sma-map{display:flex;align-items:center;gap:6px;font-size:12px;color:#5f4a45;cursor:pointer;user-select:none}
.sma-fold{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;border:1px solid #f1c9c3;border-radius:999px;background:#fff1ee;color:#b42318;font:600 12px 'Inter',system-ui,sans-serif;padding:4px 11px;cursor:pointer}
.sma-fold:hover{background:#fde3dd}
`;

/**
 * Needs Attention as its own KPI (Visesh, Oct 20 2026: "it should be a totally
 * different KPI rather than being at the bottom as a list"). The total, then
 * the reasons with counts; a reason shows its units on the map (the rest dim)
 * and lists them; a unit flies there. `showOnMap` drives the map's badges.
 * collapsed: one red chip that opens the figures again.
 */
export function AttentionCard({ groups, total, focusKey, onFocus, onPickUnit, showOnMap, onShowOnMap, collapsed = false, onExpand }) {
  if (collapsed) {
    return total ? (
      <section><style>{ATT_CSS}</style>
        <button type="button" className="sma-fold" onClick={onExpand} title="Show the units that need attention">
          <AlertTriangle size={13} aria-hidden="true" />{total} Need{total === 1 ? 's' : ''} Attention
        </button>
      </section>
    ) : null;
  }
  return (
    <section className="sma" aria-label="Needs Attention">
      <style>{ATT_CSS}</style>
      <div className="sma-head">
        <span className="sma-n">{total}</span>
        <span><div className="sma-t">{total === 1 ? 'Unit Needs' : 'Units Need'} Attention</div><div className="sma-sub">{total ? 'Out of service, by reason. Click a reason to see its units.' : 'Every unit is rentable.'}</div></span>
      </div>
      {total ? (
        <ul className="sma-groups">
          {groups.map((g) => {
            const key = `attn:${g.label}`; const on = focusKey === key;
            return (
              <li key={g.label}>
                <button type="button" className="sma-g" aria-pressed={on} aria-expanded={on} onClick={() => onFocus(on ? null : key)}>
                  <span className="sma-g-l">{g.label}</span><span className="sma-g-n">{g.units.length}</span>
                </button>
                {on ? <ul className="sma-units">{g.units.map((x) => (
                  <li key={x.n}><button type="button" className="sma-u" onClick={() => onPickUnit(x.n)} title={`Show ${x.n} on the map`}>{x.n}</button>{x.note ? <span className="sma-note">{x.note.trim()}</span> : null}</li>
                ))}</ul> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {total ? <label className="sma-map"><input type="checkbox" checked={showOnMap} onChange={(e) => onShowOnMap(e.target.checked)} />Show Issues on Map</label> : null}
    </section>
  );
}
