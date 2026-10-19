// Tickets <-> properties (Neil, Ops review Oct 20 2026): the data hooks and
// helpers behind TicketPropertyFields.jsx - backend/ticket_property_link.py
// and routers/ticket_property.py are the server half.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { topicArea } from './ticketMeta';

export const COMMON_AREA = 'Common Area';
const DEFAULT_RULES = Object.freeze({ requiredServiceAreas: ['facilities'], requiredTopics: [] });

export function useTicketPropertyRules() {
  const [rules, setRules] = useState(DEFAULT_RULES);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getTicketPropertyRules())
      .then((r) => { if (live && r) setRules({ ...DEFAULT_RULES, ...r }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return rules;
}

/** Must a ticket about this help topic name its property? Mirrors
 * ticket_property_link.property_required (the topic's service area, else a
 * listed topic). */
export function propertyRequiredFor(rules, application) {
  const name = String(application || '').trim();
  if (!name) return false;
  const area = topicArea(name) || 'general';
  return (rules?.requiredServiceAreas || []).includes(area)
    || (rules?.requiredTopics || []).some((t) => String(t).toLowerCase() === name.toLowerCase());
}

export const NO_UNITS = Object.freeze({ loading: false, units: [], strict: false, required: false, source: '' });
/** The units a ticket at this property may name: a Cubby store's synced
 * units (strict), else the property's own Manage Units list. */
export function usePropertyUnits(propertyId) {
  const [state, setState] = useState({ id: null, ...NO_UNITS });
  useEffect(() => {
    if (!propertyId) return undefined;
    let live = true;
    Promise.resolve().then(() => api.getTicketPropertyUnits(propertyId))
      .then((r) => { if (live) setState({ id: propertyId, loading: false, units: r?.units || [], strict: !!r?.strict, required: !!r?.required, source: r?.source || '' }); })
      .catch(() => { if (live) setState({ id: propertyId, ...NO_UNITS }); });
    return () => { live = false; };
  }, [propertyId]);
  if (!propertyId) return NO_UNITS;
  return state.id === propertyId ? state : { ...NO_UNITS, loading: true };
}

/** Properties the ticket's own words point at ("26382", "palisades"),
 * debounced. Only while nothing is picked. */
export function usePropertySuggestion(text, enabled) {
  const [found, setFound] = useState(null);
  const q = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  useEffect(() => {
    if (!enabled || q.length < 4) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api.suggestTicketProperty(q)
        .then((r) => { if (live) setFound({ q, top: r?.suggestions?.[0] || null }); })
        .catch(() => { if (live) setFound({ q, top: null }); });
    }, 450);
    return () => { live = false; clearTimeout(timer); };
  }, [q, enabled]);
  return enabled && found?.q === q ? found.top : null;
}

/** Open the ticket's property in Asset Management (its plans, map and site
 * model are on the property page) - its Maintenance, on Open Tickets. */
export function openProperty(propertyId) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'property-asset', sub: `tickets:${propertyId}` } }));
}
