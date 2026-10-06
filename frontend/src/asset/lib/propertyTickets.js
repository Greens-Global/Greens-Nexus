// A property's tickets in Asset Management (Property Tickets, Neil 10/05) -
// the data hook and the shapes the Maintenance section and the Export CSV
// build from GET /property-assets/{id}/tickets. Nothing here writes the
// workspace: ticket rows are derived, never saved into the maintenance
// collection (see backend property_links.py).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { formatDate } from '../../lib/datetime.js';
import { nexusCsvEsc } from './csvExport.js';
import { formatCost } from './currency.js';

export const TICKET_STATUS = {
  open: ['Open', 'red'], reopened: ['Reopened', 'red'], in_progress: ['In Progress', 'orange'],
  waiting_user: ['Waiting for User', 'blue'], waiting_vendor: ['Waiting for Vendor', 'blue'], on_hold: ['On Hold', 'blue'],
  resolved: ['Resolved', 'green'], closed: ['Closed', 'mut'],
};
export const TICKET_PRIORITY = { urgent: ['Urgent', 'red'], high: ['High', 'orange'], medium: ['Medium', 'blue'], low: ['Low', 'mut'] };
export const money = (v, currency = 'USD') => (v ? formatCost(v, currency) : '');
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

/** Tickets the asset manager added to THIS property's maintenance record, as
 * read-only Maintenance Log rows (id "ticket:<ticketId>"). A ticket a recurring
 * service opened carries `_parentRowId`, so the log shows it nested under the
 * original; each row keeps its own currency. */
export function ticketMaintenanceRows(data, property) {
  const units = new Set((property?.tenantUnits || []).map((u) => u.label));
  const byId = Object.fromEntries([...(data?.open || []), ...(data?.history || [])].map((t) => [t.id, t]));
  const nextDue = Object.fromEntries((data?.services || []).filter((s) => s.active).map((s) => [s.parentTicketId, s.nextDue]));
  const recorded = new Set((data?.records || []).map((r) => r.ticketId));
  // An original whose service has opened (and recorded) children of its own.
  const originals = new Set((data?.records || []).filter((r) => r.parentTicketId && r.parentTicketId !== r.ticketId)
    .map((r) => r.parentTicketId));
  return (data?.records || [])
    .filter((r) => r.propertyId === property?.id)
    .map((r) => ({
      id: `ticket:${r.ticketId}`, propertyId: r.propertyId, date: r.date, system: r.system,
      description: r.description || r.subject, vendor: r.vendor, ticketLabel: r.codeLabel, isOriginal: originals.has(r.ticketId),
      cost: formatCost(r.cost, r.currency), currency: r.currency || 'USD', amount: r.cost, status: 'Completed',
      nextDue: nextDue[r.ticketId] || '', notes: r.notes, docFileName: r.docName || '',
      unit: units.has(byId[r.ticketId]?.location) ? byId[r.ticketId].location : '', source: 'Ticket', _readOnly: true,
      _parentRowId: r.parentTicketId && r.parentTicketId !== r.ticketId && recorded.has(r.parentTicketId)
        ? `ticket:${r.parentTicketId}` : undefined,
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
