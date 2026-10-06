// A property's tickets in Asset Management (Property Tickets, Neil 10/05) -
// the data hook and the shapes the Maintenance section and the Export CSV
// build from GET /property-assets/{id}/tickets. Nothing here writes the
// workspace: ticket rows are derived, never saved into the maintenance
// collection (see backend property_links.py).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { formatDate } from '../../lib/datetime.js';
import { nexusCsvEsc } from './csvExport.js';

export const TICKET_STATUS = {
  open: ['Open', 'red'], reopened: ['Reopened', 'red'], in_progress: ['In Progress', 'orange'],
  waiting_user: ['Waiting for User', 'blue'], waiting_vendor: ['Waiting for Vendor', 'blue'], on_hold: ['On Hold', 'blue'],
  resolved: ['Resolved', 'green'], closed: ['Closed', 'mut'],
};
export const TICKET_PRIORITY = { urgent: ['Urgent', 'red'], high: ['High', 'orange'], medium: ['Medium', 'blue'], low: ['Low', 'mut'] };
export const money = (v) => (v ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
// The resolve date in the VIEWER's day - slicing the UTC ISO string would put
// an evening resolve on the next day.
const localYmd = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function usePropertyTickets(propertyId) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const load = useCallback(() => {
    if (!propertyId) return;
    api.getPropertyTickets(propertyId)
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((error) => setState((s) => ({ loading: false, error, data: s.data })));
  }, [propertyId]);
  useEffect(() => { load(); }, [load]);
  // A ticket raised anywhere (Support, Tickets, a walkthrough) refreshes it,
  // and so does coming back to the tab.
  useEffect(() => {
    const onChange = (e) => { if (!e?.detail?.propertyId || e.detail.propertyId === propertyId) load(); };
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('nexus:tickets-changed', onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('nexus:tickets-changed', onChange); document.removeEventListener('visibilitychange', onVisible); };
  }, [load, propertyId]);
  return { ...state, reload: load };
}

/** Closed tickets of THIS property as maintenance-log rows (read-only; id "ticket:<id>"). */
export function ticketMaintenanceRows(data, property) {
  const units = new Set((property?.tenantUnits || []).map((u) => u.label));
  return (data?.history || [])
    .filter((t) => t.maintenanceRecord && t.propertyId === property?.id)
    .map((t) => ({
      id: `ticket:${t.id}`, propertyId: t.propertyId, date: localYmd(t.resolvedAt), system: t.system,
      description: t.resolutionNote ? `${t.subject} - ${t.resolutionNote}` : t.subject,
      vendor: t.vendor, cost: money(t.cost), status: 'Completed',
      unit: units.has(t.location) ? t.location : '', docFileName: t.codeLabel, source: 'Ticket',
    }));
}

/** Closed Tickets as a CSV - the maintenance history leaves the screen too. */
export function historyCsv(data, propertyName) {
  const head = ['Ticket', 'Property', 'Title', 'Category', 'System', 'Location', 'Status', 'Outcome',
    'Opened', 'Closed', 'Resolution', 'Vendor', 'Cost', 'Maintenance Record'];
  const rows = (data?.history || []).map((t) => [t.codeLabel, t.propertyName || propertyName, t.subject, t.category,
    t.system, t.location, (TICKET_STATUS[t.status] || [t.status])[0], t.resolution, formatDate(t.createdAt), formatDate(t.resolvedAt),
    t.resolutionNote, t.vendor, t.cost, t.maintenanceRecord ? 'Yes' : 'No - Closed Without Work']);
  return [head, ...rows].map((r) => r.map(nexusCsvEsc).join(',')).join('\n');
}

export function downloadCsv(text, name) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* Blob/URL unsupported - nothing to do */ }
}
