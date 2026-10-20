// Mark an Issue on the Map (Charmi, Oct 20 2026): "when a maintenance guy gets
// the ticket, he knows exactly what they're talking about with picture and a
// location."
//
//   MapSpotIntake      - the top of Create a Ticket when it was opened from a
//                        mark on the site map: the map's picture, the property,
//                        the spot, and the nudge to add a photo.
//   TicketMapSpotCard  - Location on Map in the ticket drawer: property, spot,
//                        photo, Open on Map (the site map, flown to the spot).
// The spot itself is stored server-side (ticket_map_spot.py).
import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, btn } from '../tasks/theme';
import { requestMapFocus, shapeWord } from '../sitemodel/mapFocus.js';
import { openProperty } from './ticketPropertyLink';

const OPS_FACILITY_KEY = 'nexus.ops.facility';   // FacilityOperations.jsx remembers the facility here
const card = { border: `1px solid ${NX.border}`, borderRadius: 10, background: NX.surface2, padding: 12, display: 'flex', gap: 12, flexWrap: 'wrap' };
const head = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: NX.dim };
const coords = (s) => (s?.lat != null && s?.lng != null ? `${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}` : '');

/** A data: URL as a File (the map picture goes up like any other photo). */
export function dataUrlToFile(dataUrl, name) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  const bin = atob(m[2]); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: m[1] });
}

export function MapSpotIntake({ spot, propertyName, snapshot, hasPhoto }) {
  return (
    <div className="ticket-map-spot-intake" style={{ ...card, marginBottom: 14 }}>
      {snapshot ? <img src={snapshot} alt={`Map of ${spot.place || 'the spot'}`} style={{ width: 'min(220px, 100%)', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 8, border: `1px solid ${NX.border}`, background: '#dfe6e9' }} /> : null}
      <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 13, color: NX.ink, lineHeight: 1.45 }}>
        <div style={head}><MapPin size={14} aria-hidden="true" />Location on Map</div>
        <div style={{ fontWeight: 700, marginTop: 4 }}>{propertyName || 'The property'}</div>
        <div>{spot.place || 'On the site'}</div>
        <div style={{ color: NX.faint, fontSize: 12 }}>{[shapeWord(spot), coords(spot)].filter(Boolean).join(' · ')}</div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: hasPhoto ? NX.green : '#9a5b00', fontWeight: 600 }}>
          {hasPhoto ? 'Photo added - the team sees it with this map.'
            : 'Add a photo of the spot below (Upload, or press Ctrl+V to paste one) - it shows the team exactly what to fix.'}
        </div>
      </div>
    </div>
  );
}

/** Open on Map: Operations > Site Map at the facility when the person has
 *  Operations, else the property in Asset Management (its Site Model). */
export function openSpotOnMap(spot, canOps) {
  requestMapFocus(spot);
  if (spot.facilityId && canOps) {
    try { localStorage.setItem(OPS_FACILITY_KEY, spot.facilityId); } catch { /* the page keeps its own facility */ }
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'operations', sub: 'site-map' } }));
  } else if (spot.propertyId) openProperty(spot.propertyId);
}

export function TicketMapSpotCard({ ticketId, propertyId, onOpenMap = null }) {
  const [spot, setSpot] = useState(null);
  const role = useRole();
  useEffect(() => {
    if (!ticketId || !propertyId || !api.getTicketMapSpot) return undefined;
    let on = true;
    Promise.resolve(api.getTicketMapSpot(ticketId)).then((r) => on && setSpot(r?.spot || null)).catch(() => on && setSpot(null));
    return () => { on = false; };
  }, [ticketId, propertyId]);
  if (!spot) return null;
  const canOps = role?.canAccessModule ? role.canAccessModule('operations', 'supervisor') : false;
  const img = spot.photo || spot.mapImage;
  const ll = coords(spot);
  return (
    <div className="ticket-map-spot" style={{ ...card, margin: '0 0 14px' }}>
      {img ? <a href={img} target="_blank" rel="noopener noreferrer" style={{ flex: 'none' }}>
        <img src={img} alt={spot.photo ? 'Photo of the spot' : 'Map of the spot'} onError={(e) => { e.currentTarget.style.display = 'none'; }} style={{ width: 132, height: 96, objectFit: 'cover', borderRadius: 8, border: `1px solid ${NX.border}`, display: 'block' }} />
      </a> : null}
      <div style={{ flex: '1 1 180px', minWidth: 0, fontSize: 13, color: NX.ink, lineHeight: 1.45 }}>
        <div style={head}><MapPin size={14} aria-hidden="true" />Location on Map</div>
        <div style={{ fontWeight: 700, marginTop: 4 }}>{spot.propertyName || spot.modelName || 'Property'}</div>
        <div>{spot.place || 'On the site'}</div>
        <div style={{ color: NX.faint, fontSize: 12 }}>{shapeWord(spot)}{ll ? <> · <a href={`https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`} target="_blank" rel="noopener noreferrer" style={{ color: NX.blue }}>{ll}</a></> : null}</div>
        {spot.photo && spot.mapImage ? <a href={spot.mapImage} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: NX.blue }}>View the Marked Map</a> : null}
        <div style={{ marginTop: 8 }}>
          <button type="button" style={{ ...btn('outline'), padding: '5px 12px', fontSize: 12.5 }} onClick={() => { openSpotOnMap(spot, canOps); onOpenMap?.(); }}>Open on Map</button>
        </div>
      </div>
    </div>
  );
}
