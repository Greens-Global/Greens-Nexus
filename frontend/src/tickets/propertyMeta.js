// Property Tickets (Neil, 10/05) - shared helpers for linking a ticket to an
// Asset Management property. The picker component is PropertySelect.jsx.
import { useEffect, useState } from 'react';
import { api } from '../api';

// Teams whose tickets may sit on a property: a help-topic group with a
// building, site-operations or site-security topic. Mirrors
// property_links.PROPERTY_AREAS - the server enforces the same rule, so an HR
// or Payroll ticket can never land on a property's page in Asset Management.
export const PROPERTY_AREAS = ['facilities', 'storageops', 'security'];
export const groupTakesProperty = (group) => (group?.topics || []).some((tp) => PROPERTY_AREAS.includes(tp.area));
// The team that handles buildings - preselected when a ticket is raised from a property.
export const isBuildingGroup = (group) => (group?.topics || []).some((tp) => tp.area === 'facilities');

// /ticket-properties - names only, open to anyone who can raise a ticket.
// cachedGet in api.js shares one fetch across every form on the page.
export function useTicketProperties() {
  const [state, setState] = useState({ loading: true, error: null, properties: [], canWalkthrough: false });
  useEffect(() => {
    let live = true;
    api.getTicketProperties()
      .then((r) => { if (live) setState({ loading: false, error: null, properties: r?.properties || [], canWalkthrough: !!r?.canWalkthrough }); })
      .catch((error) => { if (live) setState({ loading: false, error, properties: [], canWalkthrough: false }); });
    return () => { live = false; };
  }, []);
  return state;
}

// "Temecula Parcel 2 (Parcel of Greens Storage Temecula) - Temecula, CA"
export const propertyLabel = (p) => (!p ? '' : `${p.parentName ? `${p.name} (Parcel of ${p.parentName})` : p.name}`
  + (p.city ? ` - ${p.city}${p.state ? `, ${p.state}` : ''}` : ''));
