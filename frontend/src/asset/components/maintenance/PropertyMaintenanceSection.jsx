import { useEffect, useState } from 'react';
import { CollectionTable } from '../shared/CollectionTable.jsx';
import { ManageUnitsModal } from './ManageUnitsModal.jsx';
import { PropertyTicketsPanel, TicketSummaryModal } from './PropertyTicketsPanel.jsx';
import { PropertyTicketComposer, PropertyTicketDrawer, PropertyWalkthroughMount } from './ticketMounts.jsx';
import { AddToMaintenanceModal, NeedsActionPanel, RecurringServicesPanel } from './MaintenanceReview.jsx';
import { usePropertyTickets, ticketMaintenanceRows } from '../../lib/propertyTickets.js';
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
 */
export function PropertyMaintenanceSection({ p: property, rows, filters, setFilters, highlightItem, onAdd, onEdit, onSaveUnits, onQuickAdd, ticketFocus = null }) {
  const units = property.tenantUnits || [];
  const [unitFilter, setUnitFilter] = useState('all');
  const [managing, setManaging] = useState(false);
  const [tab, setTab] = useState(ticketFocus?.propertyId === property.id ? 'open' : 'log');
  const [composing, setComposing] = useState(false);
  const [walking, setWalking] = useState(false);
  const [opened, setOpened] = useState(null);          // a ticket summary row
  const [recording, setRecording] = useState(null);    // a Needs Action row being added to the record
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

  const allRows = [...rows, ...ticketMaintenanceRows(data, property)];
  const filteredRows =
    unitFilter === 'all' ? allRows : unitFilter === 'common' ? allRows.filter((r) => !r.unit) : allRows.filter((r) => r.unit === unitFilter);
  const editRow = (id) => {
    if (String(id).startsWith('ticket:')) {
      const tid = String(id).slice(7);
      setOpened((data?.history || []).find((t) => t.id === tid) || null);
    } else onEdit(id);
  };
  const followAll = async (list) => {
    await Promise.allSettled(list.map((t) => api.followPropertyTicket(property.id, t.id)));
    tickets.reload();
  };

  const pill = (value, label) => (
    <button
      key={value}
      onClick={() => setUnitFilter(value)}
      style={{
        padding: '6px 13px',
        borderRadius: 8,
        fontSize: '0.8rem',
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        whiteSpace: 'nowrap',
        background: unitFilter === value ? 'var(--bg-card)' : 'transparent',
        color: unitFilter === value ? 'var(--text-primary)' : 'var(--text-secondary)',
        boxShadow: unitFilter === value ? 'var(--shadow-sm)' : 'none',
      }}
    >
      {label}
    </button>
  );
  const tabBtn = (value, label) => (
    <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
      style={{
        padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.85rem', fontWeight: 600,
        color: tab === value ? 'var(--text-primary)' : 'var(--text-secondary)',
        borderBottom: tab === value ? '2px solid hsl(var(--color-blue))' : '2px solid transparent',
      }}>
      {label}
    </button>
  );
  const count = (n) => (data ? ` (${n})` : '');
  const needs = data?.needsAction?.length || 0;
  const fixed = { id: property.id, name: property.name };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div className="scroll-tabs" role="tablist" style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', flex: '1 1 320px' }}>
          {tabBtn('log', 'Maintenance Log')}
          {tabBtn('needs', <>Needs Action{needs > 0
            ? <span style={{ marginLeft: 6, padding: '1px 7px', borderRadius: 999, background: 'hsl(var(--color-red))', color: '#fff', fontSize: '0.72rem' }}>{needs}</span>
            : count(0)}</>)}
          {tabBtn('open', `Open Tickets${count(data?.open?.length || 0)}`)}
          {tabBtn('closed', `Closed Tickets${count(data?.history?.length || 0)}`)}
          {tabBtn('services', `Recurring Services${count(data?.services?.length || 0)}`)}
        </div>
        <button className="secondary-btn" onClick={() => setComposing(true)}>Create New Ticket</button>
        {data?.canWalkthrough && <button className="primary-btn" onClick={() => setWalking(true)}>Start Walkthrough</button>}
      </div>

      {tab === 'log' && (<>
        {units.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 4,
              padding: 4,
              borderRadius: 10,
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              marginBottom: 14,
            }}
          >
            {pill('all', 'All Units')}
            {pill('common', 'Common Areas')}
            {units.map((u) => pill(u.label, u.label))}
            <button
              onClick={() => setManaging(true)}
              style={{
                marginLeft: 'auto',
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: '0.76rem',
                fontWeight: 600,
                cursor: 'pointer',
                border: 'none',
                background: 'transparent',
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {'⚙ Manage Units'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setManaging(true)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: '0.8rem', fontWeight: 600, padding: 0, marginBottom: 14 }}
          >
            + Multi-tenant property? Set up suites/units
          </button>
        )}

        <CollectionTable
          coll="maintenance"
          rows={filteredRows}
          active={property}
          filters={filters}
          setFilters={setFilters}
          highlightItem={highlightItem}
          onAdd={onAdd}
          onEdit={editRow}
          onQuickAdd={onQuickAdd}
        />
      </>)}
      {tab === 'needs' && (tickets.data
        ? <NeedsActionPanel data={data} onOpen={setOpened} onAdd={setRecording} />
        : <PropertyTicketsPanel mode="open" tickets={tickets} onOpen={setOpened} onFollowAll={followAll} propertyName={property.name} />)}
      {tab === 'services' && (tickets.data
        ? <RecurringServicesPanel propertyId={property.id} data={data} onOpen={setOpened} onChanged={tickets.reload} />
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
