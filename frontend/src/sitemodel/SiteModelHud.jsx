// Floating dashboard cards over the Illustrated look (Neil, Oct 11 2026), after
// the "3D warehouse dashboard" Neil shared: a site chip with a live pill, KPI
// tiles across the top, a route tracker for the unit you are looking at (the
// storage version of a shipment tracker: Gate -> Building -> Level -> Unit)
// and, for owners, an Attention / Pins / Tickets card.
//
// Customers see the site chip and the route only - never occupancy.
// Everything here is read from props; the panel owns state and the viewer.
import { useState } from 'react';
import { formatTime } from '../lib/datetime.js';
import { routeSteps, reasonLabel } from './siteModelViewer.js';

const FONT = "'Inter', system-ui, sans-serif";
const GREEN = '#2f855a';
const card = { pointerEvents: 'auto', background: 'rgba(255,255,255,0.96)', border: '1px solid rgba(20,40,30,0.06)', borderRadius: 14, boxShadow: '0 8px 24px rgba(20,40,30,0.12)', color: '#1d1f1a', fontFamily: FONT };
const muted = { color: '#6b7068' };
const chipStyle = (bg, fg) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: bg, color: fg, whiteSpace: 'nowrap' });

function initials(name) {
  const words = (name || '').replace(/^Greens Storage\s*/i, '').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || 'GS').slice(0, 2)).toUpperCase();
}

const STEP_ICONS = ['M4 12h16M14 6l6 6-6 6', 'M4 20V9l8-5 8 5v11M9 20v-6h6v6', 'M6 4h12v16H6zM10 8h4M10 12h4', 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'];
function StepIcon({ i, end }) {
  const d = end ? STEP_ICONS[3] : STEP_ICONS[Math.min(i, 2)];
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

export function SiteModelHud({ model, owner, live, stats, unit, attention = [], pins = [], ticketsByUnit = {}, onPickUnit, onPickPin }) {
  const [tab, setTab] = useState('attention');
  const name = model.property?.name || 'Site';
  const isLive = live.source === 'cubby' && !live.error;
  const tickets = Object.entries(ticketsByUnit).flatMap(([n, list]) => list.map((t) => ({ ...t, unit: n })));
  const openPins = pins.filter((p) => p.status !== 'done');
  const steps = unit ? routeSteps(model, unit) : null;
  const rows = tab === 'attention' ? attention.slice(0, 4).map((x) => ({ key: x.n, a: x.n, b: reasonLabel(x.why) || 'Out of service', chip: ['Out of Service', '#fdecea', '#b42318'], go: () => onPickUnit?.(x.n) }))
    : tab === 'pins' ? openPins.slice(0, 4).map((p) => ({ key: p.id, a: p.unit || p.building || 'Site', b: p.title, chip: [p.category === 'inspection' ? 'Inspection' : p.category === 'note' ? 'Note' : 'Maintenance', '#eef4ff', '#2f5bd3'], go: () => onPickPin?.(p) }))
      : tickets.slice(0, 4).map((t) => ({ key: t.id, a: t.unit, b: t.title || t.subject || `Ticket #${t.id}`, chip: ['Open Ticket', '#fff4e5', '#b54708'], go: () => onPickUnit?.(t.unit) }));

  return (
    <div className="sm-hud" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2, fontFamily: FONT }}>
      <style>{`.sm-hud .sm-wide{display:flex} @media (max-width: 760px){ .sm-hud .sm-wide{display:none !important} }`}</style>
      {/* site chip + live pill */}
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', maxWidth: 'calc(100% - 24px)' }}>
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px 7px 7px' }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, background: GREEN, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '.02em' }}>{initials(name)}</span>
          <span style={{ lineHeight: 1.2 }}>
            <b style={{ display: 'block', fontSize: 13 }}>{name}</b>
            <span style={{ fontSize: 11, ...muted }}>{owner ? `${stats.active} units · ${stats.leasedPct}% leased` : (model.property?.address || '')}</span>
          </span>
        </div>
        {owner && <span style={{ ...card, ...chipStyle(isLive ? '#e7f6ec' : '#f1f2f4', isLive ? '#1f6f4a' : '#5f6358'), padding: '6px 11px', fontSize: 12, borderRadius: 999 }}>
          <i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: isLive ? '#22a35a' : '#9aa0a6', marginRight: 6, verticalAlign: 1 }} />
          {isLive ? `Live${live.asOf ? ` ${formatTime(live.asOf)}` : ''}` : 'Snapshot'}
        </span>}
      </div>

      {/* KPI tiles (owners) */}
      {owner && <div className="sm-wide" style={{ position: 'absolute', top: 66, left: 12, gap: 8 }}>
        {[[stats.active, 'Units', null], [`${stats.leasedPct}%`, 'Leased', `${stats.leased} leased`], [stats.vacant, 'Vacant', 'Rentable now'], [stats.bad, 'Out of Service', stats.bad ? 'Needs attention' : 'All clear']].map(([v, l, s]) => (
          <div key={l} style={{ ...card, padding: '8px 12px', minWidth: 96 }}>
            <div style={{ fontSize: 11, ...muted }}>{l}</div>
            <div style={{ fontSize: 19, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
            {s && <div style={{ fontSize: 10.5, color: l === 'Out of Service' && stats.bad ? '#b42318' : '#6b7068' }}>{s}</div>}
          </div>
        ))}
      </div>}

      {/* route tracker: gate -> building -> level -> unit */}
      {steps && <div style={{ ...card, position: 'absolute', left: 12, bottom: 58, padding: '10px 14px 12px', maxWidth: 'min(520px, calc(100% - 24px))' }} aria-label={`Route to ${unit.n}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, marginBottom: 8 }}><b>Route to {unit.n}</b><span style={muted}>{model.property?.name?.replace(/^Greens Storage\s*/i, '')}</span></div>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', alignItems: 'flex-start' }}>
          {steps.map((s, i) => (
            <li key={i} style={{ display: 'flex', alignItems: 'flex-start', flex: s.end ? '0 0 auto' : '1 1 0', minWidth: 0 }}>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 64 }}>
                <span style={{ width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center', color: '#fff', background: s.end ? '#ff7a00' : GREEN, boxShadow: s.end ? '0 0 0 4px rgba(255,122,0,0.18)' : 'none' }}><StepIcon i={i} end={s.end} /></span>
                <b style={{ textAlign: 'center', maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(s.end ? { font: '600 12px ui-monospace, Menlo, monospace' } : { fontSize: 11.5, fontWeight: 600 }) }}>{s.label}</b>
                <span style={{ fontSize: 10.5, ...muted, whiteSpace: 'nowrap' }}>{s.sub}</span>
              </span>
              {!s.end && <span aria-hidden="true" style={{ flex: 1, height: 3, borderRadius: 3, background: GREEN, opacity: 0.85, margin: '13px 2px 0', minWidth: 12 }} />}
            </li>
          ))}
        </ol>
      </div>}

      {/* attention / pins / tickets (owners) */}
      {owner && <div className="sm-wide" style={{ ...card, position: 'absolute', right: 12, bottom: 58, width: 300, flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div role="tablist" aria-label="Site activity" style={{ display: 'flex', borderBottom: '1px solid #eef0f2' }}>
          {[['attention', `Attention ${attention.length}`], ['pins', `Pins ${openPins.length}`], ['tickets', `Tickets ${tickets.length}`]].map(([k, l]) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} style={{ flex: 1, border: 0, background: 'transparent', padding: '9px 6px', font: `600 12px ${FONT}`, color: tab === k ? '#1d1f1a' : '#8a8f87', borderBottom: tab === k ? `2px solid ${GREEN}` : '2px solid transparent', cursor: 'pointer' }}>{l}</button>
          ))}
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: '4px 0' }}>
          {rows.length ? rows.map((r) => (
            <li key={r.key}><button type="button" onClick={r.go} style={{ width: '100%', display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) auto', gap: 8, alignItems: 'center', border: 0, background: 'transparent', padding: '6px 12px', cursor: 'pointer', textAlign: 'left', font: `12px ${FONT}`, color: 'inherit' }}>
              <b style={{ font: `600 12px ui-monospace, Menlo, monospace` }}>{r.a}</b>
              <span style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.b}</span>
              <span style={chipStyle(r.chip[1], r.chip[2])}>{r.chip[0]}</span>
            </button></li>
          )) : <li style={{ padding: '10px 12px', fontSize: 12, ...muted }}>{tab === 'attention' ? 'Every unit is rentable.' : tab === 'pins' ? 'No open pins.' : 'No tickets at a unit.'}</li>}
        </ul>
      </div>}
    </div>
  );
}
