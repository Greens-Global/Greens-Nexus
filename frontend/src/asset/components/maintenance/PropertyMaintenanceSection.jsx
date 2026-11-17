import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Plus, SlidersHorizontal, ClipboardCheck, LayoutGrid, Wrench } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { MenuRow } from '../shared/MenuRow.jsx';
import { CollectionTable } from '../shared/CollectionTable.jsx';
import { EmptyState } from '../shared/EmptyState.jsx';
import { ManageUnitsModal } from './ManageUnitsModal.jsx';
import { PropertyTicketsPanel, TicketSummaryModal } from './PropertyTicketsPanel.jsx';
import { PropertyTicketComposer, PropertyTicketDrawer, PropertyWalkthroughMount } from './ticketMounts.jsx';
import { AddToMaintenanceModal, NeedsActionPanel, RecurringServicesPanel } from './MaintenanceReview.jsx';
import { MaintenanceLogFilters } from './MaintenanceLogFilters.jsx';
import { EMPTY_LOG_FILTER, applyLogFilter, logSummary } from '../../lib/maintenanceLog.js';
import { usePropertyTickets, ticketMaintenanceRows, openTicketLogRows } from '../../lib/propertyTickets.js';
import { api } from '../../../api.js';

/**
 * A property's Maintenance: the manual log (CollectionTable) with a per-unit filter, plus its
 * tickets (Neil, 10/05) - Needs Action (resolved tickets the asset manager adds to the record,
 * Pranshu 10/06), Open Tickets, Closed Tickets and Recurring Services; recorded tickets show as
 * read-only rows in the log (id "ticket:<id>"; clicking one opens the ticket, never the editor).
 * Properties without units get a low-key opt-in link to set up multi-tenant suites/units; once
 * units exist, a pill row scopes the log to "All Units", "Common Areas" (no `unit`) or one unit.
 * Create New Ticket and Start Walkthrough raise tickets for THIS property only - it is fixed in
 * both (Pranshu, 10/06). `ticketFocus` ({ propertyId, ticketId, tab, at }) comes from a bell deep link.
 * The look (Neil, 11/17/2026): one row of text tabs - Log, Open Tickets, Closed Tickets, Needs
 * Action, Preventive - each with its count only when there is one, as a plain number; on the
 * right Filters (the log), Report a Problem, the one primary Log Work and a more menu (Batch
 * Create, units). The log opens with a one-line quick add and, when nothing is logged yet, an
 * empty state that offers Log Work and Set Up Preventive Maintenance.
 */
// The Maintenance Log's first column: which ticket a record came from - the
// original of a recurring service in bold with "(Original)", the tickets its
// service opened nested under it (CollectionTable indents them); "-" for a
// hand-logged record.
const TICKET_COLUMN = {
  label: 'Ticket',
  render: (row) => (row.ticketLabel
    ? <span><b style={{ color: 'var(--text-primary)' }}>{row.ticketLabel}</b>{row.isOriginal && <span style={{ color: 'var(--text-secondary)', marginLeft: 4 }}>(Original)</span>}</span>
    : <span style={{ color: 'var(--text-secondary)' }}>-</span>),
};

export function PropertyMaintenanceSection({ p: property, rows, filters, setFilters, highlightItem, onAdd, onEdit, onSaveUnits, onQuickAdd, ticketFocus = null }) {
  const units = property.tenantUnits || [];
  const [unitFilter, setUnitFilter] = useState('all');
  const [managing, setManaging] = useState(false);
  const [tab, setTab] = useState(ticketFocus?.propertyId === property.id ? 'open' : 'log');
  const [composing, setComposing] = useState(false);
  const [walking, setWalking] = useState(false);
  const [opened, setOpened] = useState(null);          // a ticket summary row
  const [recording, setRecording] = useState(null);    // a Needs Action row being added to the record
  const [logFilter, setLogFilter] = useState(EMPTY_LOG_FILTER);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [startSchedule, setStartSchedule] = useState(0);   // the empty state's Set Up Preventive Maintenance
  const moreRef = useRef(null);
  const activeFilters = Object.values(logFilter).filter(Boolean).length;
  const tickets = usePropertyTickets(property.id);
  const data = tickets.data;

  // A bell deep link: open the tickets tab, and the ticket once the list is in.
  const [focusSeen, setFocusSeen] = useState(null);
  if (ticketFocus?.propertyId === property.id && ticketFocus.at !== focusSeen) {
    setFocusSeen(ticketFocus.at);
    setTab(({ 'needs-action': 'needs', services: 'services' })[ticketFocus.tab] || 'open');
    if (ticketFocus.ticketId) setOpened({ id: ticketFocus.ticketId, pending: true });
  }
  useEffect(() => {
    if (!opened?.pending || !data) return;
    const row = [...(data.open || []), ...(data.history || [])].find((t) => t.id === opened.id);
    setOpened(row || null);    // eslint-disable-line react-hooks/set-state-in-effect
  }, [data, opened?.pending, opened?.id]);

  // Open tickets sit in the log too (Ops review, Oct 20): one place for every item.
  const allRows = [...rows, ...ticketMaintenanceRows(data, property), ...openTicketLogRows(data, property)];
  const unitRows =
    unitFilter === 'all' ? allRows : unitFilter === 'common' ? allRows.filter((r) => !r.unit) : allRows.filter((r) => r.unit === unitFilter);
  const filteredRows = applyLogFilter(unitRows, logFilter);
  const editRow = (id) => {
    if (String(id).startsWith('ticket:')) {
      const tid = String(id).slice(7);
      setOpened([...(data?.history || []), ...(data?.open || [])].find((t) => t.id === tid) || null);
    } else onEdit(id);
  };
  const followAll = async (list) => {
    await Promise.allSettled(list.map((t) => api.followPropertyTicket(property.id, t.id)));
    tickets.reload();
  };

  const pill = (value, label) => {
    const on = unitFilter === value;
    return (
      <button key={value} type="button" onClick={() => setUnitFilter(value)} aria-pressed={on}
        style={{ padding: '4px 0', border: 'none', background: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit', fontSize: 13,
          fontWeight: on ? 600 : 400, color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
        {label}
      </button>
    );
  };
  // A tab's count shows only when there is one, as a plain number (no pill); `alert` = red words.
  const tabBtn = (value, label, n = 0, alert = false) => (
    <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '8px 0', marginBottom: -1, border: 'none', background: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit', fontSize: 13, fontWeight: tab === value ? 600 : 500,
        color: tab === value ? 'var(--text-primary)' : 'var(--text-secondary)',
        borderBottom: tab === value ? '2px solid var(--text-primary)' : '2px solid transparent',
      }}>
      {label}
      {n > 0 && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: alert ? 600 : 500, color: alert ? 'hsl(var(--color-red))' : 'var(--text-secondary)' }}>{n}</span>}
    </button>
  );
  const needs = data?.needsAction?.length || 0;
  const fixed = { id: property.id, name: property.name };
  const logEmpty = allRows.length === 0;
  const setUpPreventive = () => { setTab('services'); setStartSchedule(Date.now()); };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, borderBottom: '1px solid var(--border-color)', marginBottom: 4 }}>
        <div className="scroll-tabs" role="tablist" aria-label="Maintenance" style={{ display: 'flex', gap: 22, flex: '1 1 320px', minWidth: 0 }}>
          {tabBtn('log', 'Log')}
          {tabBtn('open', 'Open Tickets', data?.open?.length || 0)}
          {tabBtn('closed', 'Closed Tickets', data?.history?.length || 0)}
          {tabBtn('needs', 'Needs Action', needs, true)}
          {tabBtn('services', 'Preventive', data?.preventive?.overdue || 0, true)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, flexWrap: 'wrap' }}>
          {tab === 'log' && !logEmpty && (
            <button type="button" className="secondary-btn" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px' }}>
              <SlidersHorizontal size={14} aria-hidden="true" /> Filters{activeFilters > 0 && (
                <span style={{ fontWeight: 600, color: 'hsl(var(--color-green))', fontVariantNumeric: 'tabular-nums' }}>{activeFilters}</span>
              )}
            </button>
          )}
          <button type="button" className="secondary-btn" onClick={() => setComposing(true)} style={{ height: 32, padding: '0 12px' }}>Report a Problem</button>
          <button type="button" className="primary-btn" onClick={onAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px' }}>
            <Plus size={14} aria-hidden="true" /> Log Work
          </button>
          <button ref={moreRef} type="button" className="secondary-btn" onClick={() => setMoreOpen((o) => !o)} aria-label="More maintenance actions"
            aria-haspopup="menu" aria-expanded={moreOpen} style={{ height: 32, padding: '0 9px' }}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          <AnchoredMenu anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} align="end" minWidth={220}
            style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
            {data?.canWalkthrough && <MenuRow icon={ClipboardCheck} onClick={() => { setMoreOpen(false); setWalking(true); }}>Batch Create</MenuRow>}
            <MenuRow icon={LayoutGrid} onClick={() => { setMoreOpen(false); setManaging(true); }}>{units.length ? 'Manage Units' : 'Set Up Units'}</MenuRow>
          </AnchoredMenu>
        </div>
      </div>

      {tab === 'log' && (<>
        {units.length > 0 ? (
          <div role="group" aria-label="Unit" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, padding: '8px 0' }}>
            {pill('all', 'All Units')}
            {pill('common', 'Common Areas')}
            {units.map((u) => pill(u.label, u.label))}
          </div>
        ) : null}

        {filtersOpen && <MaintenanceLogFilters rows={unitRows} value={logFilter}
          onChange={(v) => { setLogFilter(v); if (v === EMPTY_LOG_FILTER) setFiltersOpen(false); }} />}
        <CollectionTable
          coll="maintenance"
          summaryOverride={logSummary(filteredRows.filter((r) => !r._openTicket))}
          leadColumn={TICKET_COLUMN}
          rows={filteredRows}
          active={property}
          filters={filters}
          setFilters={setFilters}
          highlightItem={highlightItem}
          onAdd={null}
          onEdit={editRow}
          onQuickAdd={onQuickAdd}
          emptyNode={(
            <EmptyState icon={Wrench} title="No maintenance logged yet"
              action={<><Plus size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 4 }} />Log Work</>} onAction={onAdd}
              secondary={data?.canManage ? <button type="button" className="secondary-btn" onClick={setUpPreventive}>Set Up Preventive Maintenance</button> : null}>
              Repairs, inspections and preventive work for this property land here, with the tickets that raised them.
            </EmptyState>
          )}
        />
      </>)}
      {tab === 'needs' && (tickets.data
        ? <NeedsActionPanel data={data} onOpen={setOpened} onAdd={setRecording} />
        : <PropertyTicketsPanel mode="open" tickets={tickets} onOpen={setOpened} onFollowAll={followAll} propertyName={property.name} />)}
      {tab === 'services' && (tickets.data
        ? <RecurringServicesPanel propertyId={property.id} data={data} onOpen={setOpened} onChanged={tickets.reload} startNew={startSchedule} />
        : <PropertyTicketsPanel mode="open" tickets={tickets} onOpen={setOpened} onFollowAll={followAll} propertyName={property.name} />)}
      {tab === 'open' && <PropertyTicketsPanel mode="open" tickets={tickets} onOpen={setOpened} onFollowAll={followAll} propertyName={property.name} />}
      {tab === 'closed' && <PropertyTicketsPanel mode="closed" tickets={tickets} onOpen={setOpened} onFollowAll={followAll} propertyName={property.name} />}

      {managing && (
        <ManageUnitsModal
          units={units}
          onSave={(updatedUnits) => {
            onSaveUnits(updatedUnits);
            setManaging(false);
          }}
          onClose={() => setManaging(false)}
        />
      )}
      {recording && <AddToMaintenanceModal propertyId={property.id} t={recording} onClose={() => setRecording(null)}
        onSaved={() => { setRecording(null); tickets.reload(); }} />}
      {composing && <PropertyTicketComposer property={fixed} onClose={() => { setComposing(false); tickets.reload(); }} />}
      {walking && <PropertyWalkthroughMount property={fixed} onClose={() => { setWalking(false); tickets.reload(); }} />}
      {opened && !opened.pending && (opened.canOpen
        ? <PropertyTicketDrawer ticketId={opened.id} onClose={() => { setOpened(null); tickets.reload(); }} />
        : <TicketSummaryModal t={opened} propertyId={property.id} canFollow={!!data?.canFollow} onClose={() => setOpened(null)}
            onFollowed={(t) => { tickets.reload(); setOpened({ ...t, canOpen: true }); }} />)}
    </>
  );
}
