// Mark an Issue on the Map (Charmi, Oct 20 2026) - the on-map controls.
// SiteModelPanel shows MarkIssueButton in its button bar for staff screens
// that pass onMarkIssue, MarkIssueBanner while marking, and SpotTooltip over
// an open ticket's spot. The drawing itself is siteModelMarkup.js.
import { MapPin } from 'lucide-react';

const FONT = "'Inter', system-ui, sans-serif";
const AMBER = '#b45309';
const btn = { font: `600 13px ${FONT}`, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 };
const STATUS = { open: 'Open', in_progress: 'In Progress', waiting_user: 'Waiting on User', waiting_vendor: 'Waiting on Vendor', on_hold: 'On Hold', reopened: 'Reopened' };
const PRIORITY = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

export function MarkIssueButton({ on, onClick }) {
  return (
    <button type="button" className="sm-mark-btn" aria-pressed={on} onClick={onClick} title="Mark the exact spot on the map and file a ticket for it"
      style={{ ...btn, border: `1px solid ${AMBER}`, background: on ? AMBER : '#fff7ed', color: on ? '#fff' : AMBER }}>
      <MapPin size={15} aria-hidden="true" />Mark an Issue
    </button>
  );
}

// The three tools (Visesh, Oct 20: a dropdown, the pen first - "a chalkout should be just like a pen draw").
export const MARK_TOOLS = [
  ['pen', 'Pen', 'Draw on the map like a pen', 'Draw with one finger'],
  ['circle', 'Circle', 'Drag across the spot to circle it', 'Drag one finger across the spot'],
  ['pin', 'Pin', 'Click the spot to drop a pin', 'Tap the spot to drop a pin'],
];

export function MarkIssueBanner({ shape, onShape, onCancel, top = 10 }) {
  const t = MARK_TOOLS.find((x) => x[0] === shape) || MARK_TOOLS[0];
  return (
    <div role="status" className="sm-mark-banner" style={{ position: 'absolute', top, left: '50%', transform: 'translateX(-50%)', zIndex: 5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center',
      maxWidth: 'calc(100% - 20px)', boxSizing: 'border-box', padding: '6px 8px 6px 10px', borderRadius: 12, background: 'rgba(255,255,255,0.97)', border: '1px solid #d9d6cc', boxShadow: '0 6px 18px rgba(0,0,0,.14)', font: `400 13px ${FONT}`, color: '#1d1f1a' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        Tool
        <select aria-label="Marking Tool" value={t[0]} onChange={(e) => onShape(e.target.value)}
          style={{ font: `500 13px ${FONT}`, padding: '4px 8px', borderRadius: 8, border: '1px solid #d9d6cc', background: '#fff', color: '#1d1f1a', cursor: 'pointer' }}>
          {MARK_TOOLS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <span>
        <span className="sm-hint-mouse">{t[2]} · Esc to cancel</span>
        <span className="sm-hint-touch">{t[3]} · two fingers move the map</span>
      </span>
      <button type="button" onClick={onCancel} style={{ ...btn, padding: '4px 10px', border: '1px solid #d9d6cc', background: '#fff', color: '#1d1f1a' }}>Cancel</button>
    </div>
  );
}

/** Hovering an open ticket's spot: its title, status and photo. */
export function SpotTooltip({ spot, x, y }) {
  const img = spot.photo || spot.mapImage;
  return (
    <div role="tooltip" className="sm-spot-tip" style={{ position: 'absolute', left: x + 14, top: Math.max(6, y - 40), zIndex: 6, pointerEvents: 'none', width: 220, background: '#fff', color: '#1d1f1a',
      border: '1px solid #d9d6cc', borderRadius: 10, boxShadow: '0 8px 22px rgba(0,0,0,.16)', overflow: 'hidden', font: `400 12px/1.35 ${FONT}` }}>
      {img ? <img src={img} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} style={{ display: 'block', width: '100%', height: 110, objectFit: 'cover', background: '#eef0ec' }} /> : null}
      <div style={{ padding: '7px 9px' }}>
        <div style={{ fontWeight: 700, fontSize: 12.5 }}>{spot.code ? `#${Number(spot.code) || spot.code} · ` : ''}{spot.title || 'Ticket'}</div>
        <div style={{ color: '#5f6358', marginTop: 2 }}>{[STATUS[spot.status] || 'Open', PRIORITY[spot.priority], spot.place].filter(Boolean).join(' · ')}</div>
        <div style={{ color: AMBER, marginTop: 3, fontWeight: 600 }}>Click to open the ticket</div>
      </div>
    </div>
  );
}
