// Asset Management > property page: the 3D site model block (Neil, Oct 11 2026).
// Renders nothing for a property that has no model yet; for one that does it
// loads the owner model, its markup pins and the property's tickets, and hands
// everything to SiteModelPanel. Pins round-trip through /site-models/{id}/markups.
// Mark an Issue on the Map (Oct 20 2026): the same button as Operations > Site
// Map - a marked spot files a ticket on this property (ticketMounts composer);
// open tickets' spots draw on the model and a ticket's own pin row is left out
// of Pins (the spot is that pin).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api.js';
import { openNotificationTarget } from '../../../lib/openTarget.js';
import { SiteModelPanel, siteModelImages } from '../../../sitemodel/SiteModelPanel.jsx';
import { usePropertyTickets } from '../../lib/propertyTickets.js';
import { PropertyTicketComposer } from '../maintenance/ticketMounts';

const digits = (s) => String(s || '').replace(/\D/g, '');

/** The model whose id, APN or name matches this property, if any. */
export function matchSiteModel(list, p) {
  if (!list?.length || !p) return null;
  const id = String(p.id || ''); const apn = digits(p.apn); const name = String(p.name || '').toLowerCase();
  // Name fallback is exact (ignoring case, spacing and punctuation): "Greens Storage Temecula" matches
  // "greens storage temecula", never a "Temecula Land Parcel" that only shares the city word.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byName = (m) => !!norm(m.name) && norm(m.name) === norm(name);
  return list.find((m) => m.id === id)
    || (apn && list.find((m) => digits(m.apn) === apn))
    || (name && list.find(byName))
    || null;
}

export function SiteModelSection({ p }) {
  const [list, setList] = useState(null); const [model, setModel] = useState(null); const [pins, setPins] = useState([]); const [error, setError] = useState('');
  const [pinError, setPinError] = useState('');
  const [marked, setMarked] = useState({ property: null, spots: [] }); const [mark, setMark] = useState(null);
  const [markReset, setMarkReset] = useState(0);
  useEffect(() => { let on = true; api.getSiteModels().then((l) => on && setList(l || [])).catch(() => on && setList([])); return () => { on = false; }; }, []);
  // Keyed on the fields the match reads, not the property object: AssetDetailForm
  // hands down a fresh `p` after every save and the 1 MB model must not refetch.
  const pid = p?.id, papn = p?.apn, pname = p?.name;
  const match = useMemo(() => matchSiteModel(list, { id: pid, apn: papn, name: pname }), [list, pid, papn, pname]);
  const load = useCallback(() => {
    if (!match) return;
    api.getSiteModel(match.id).then(setModel).catch((e) => setError(e?.message || 'Could not load the site model'));
    api.getSiteModelMarkups(match.id).then((rows) => setPins(rows || [])).catch(() => {});
  }, [match]);
  useEffect(() => { load(); }, [load]);
  const loadSpots = useCallback(() => {
    if (!match || !api.getTicketMapSpots) return;
    Promise.resolve(api.getTicketMapSpots(match.id)).then((r) => setMarked({ property: r?.property || null, spots: r?.spots || [] })).catch(() => {});
  }, [match]);
  useEffect(() => { loadSpots(); }, [loadSpots]);
  const spotIds = useMemo(() => new Set(marked.spots.map((x) => x.id)), [marked.spots]);
  const shownPins = useMemo(() => pins.filter((x) => !spotIds.has(x.id)), [pins, spotIds]);
  // Same fetch PropertyMaintenanceSection makes for this property - one extra
  // GET per property open, accepted over threading the tickets through the
  // asset App's files.
  const tickets = usePropertyTickets(match ? pid : null);
  const allTickets = useMemo(() => [...(tickets.data?.open || []), ...(tickets.data?.history || [])], [tickets.data]);
  if (!match) return null;
  const openTicket = (t) => { window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } })); openNotificationTarget({ ticketId: t.id }); };
  const pinFail = (what) => (e) => setPinError(`${what}: ${e?.message || 'request failed'}`);
  return (
    <section style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.98rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>Site Model</strong>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>To scale · every unit placed · pins mark what needs attention</span>
        <a href={`/map/${encodeURIComponent(match.id)}`} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: '0.78rem', fontWeight: 600, color: 'hsl(var(--color-green, 150 56% 28%))' }}>Customer Unit Finder ↗</a>
      </div>
      <div style={{ padding: 14 }}>
        {error ? <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error}</div>
          : !model ? <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '40px 0', textAlign: 'center' }}>Loading the site model…</div>
          : <>
              {pinError && <div role="alert" style={{ fontSize: 12, color: '#c43d2f', marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>{pinError}<button type="button" onClick={() => setPinError('')} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }} aria-label="Dismiss">×</button></div>}
              <SiteModelPanel model={model} mode="owner" images={siteModelImages(match.id)} pins={shownPins} tickets={allTickets}
                modelId={match.id} spots={marked.spots} onOpenSpot={(sp) => openTicket({ id: sp.ticketId })} markResetKey={markReset}
                onMarkIssue={marked.property || pid ? (spot, snapshot) => setMark({ spot, snapshot }) : null}
                onAddPin={(pin) => api.addSiteModelMarkup(match.id, pin).then((row) => { setPins((ps) => [row, ...ps]); setPinError(''); }).catch(pinFail('Could not save the pin'))}
                onRemovePin={(pin) => api.deleteSiteModelMarkup(match.id, pin.id).then(() => setPins((ps) => ps.filter((x) => x.id !== pin.id))).catch(pinFail('Could not remove the pin'))}
                onTogglePin={(pin) => api.updateSiteModelMarkup(match.id, pin.id, { status: pin.status === 'done' ? 'open' : 'done' }).then((row) => setPins((ps) => ps.map((x) => (x.id === row.id ? row : x)))).catch(pinFail('Could not update the pin'))}
                onOpenTicket={openTicket} />
              {mark && <PropertyTicketComposer property={{ id: marked.property?.id || pid, name: marked.property?.name || pname, unit: mark.spot.ticketUnit }} mapSpot={mark}
                onClose={() => { setMark(null); setMarkReset((n) => n + 1); loadSpots(); }} />}
            </>}
      </div>
    </section>
  );
}
