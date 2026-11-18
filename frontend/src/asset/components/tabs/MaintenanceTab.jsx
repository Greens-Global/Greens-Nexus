// Asset Management > Maintenance (Neil, 11/17/2026): the portfolio's view of the tickets, by
// property (GET /maintenance/portfolio - walled like the preventive roll-up). Tickets stay the
// work orders: a row opens that property's Maintenance, "Open These in Tickets" goes to the desk.

import { useMemo, useState } from 'react';
import { SkeletonBlocks, ErrorBanner } from '../../../components/AsyncState';
import { formatDate } from '../../lib/format.js';
import { useMaintenancePortfolio } from '../../lib/tabSignals.js';
import { plural } from '../../lib/datesModel.js';
import { C, Sentence, Toolbar, SearchBox, Segmented, Table, RowButton, LinkButton, Quiet, Faint, td, num } from './tabParts.jsx';

const HEAD = [
  { key: 'p', label: 'Property' },
  { key: 'o', label: 'Open', num: true },
  { key: 't', label: 'All Tickets', num: true },
  { key: 'l', label: 'Last Ticket', style: { paddingLeft: 24 } },
  { key: 'pm', label: 'Preventive' },
];

export const openTickets = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));

function preventiveWords(r) {
  if (!r.preventiveSchedules) return <Faint>None set up</Faint>;
  return (
    <span>
      {plural(r.preventiveSchedules, 'schedule')}
      {r.preventiveOverdue > 0 && <span style={{ color: C.red, fontWeight: 600 }}>{` - ${r.preventiveOverdue} overdue`}</span>}
    </span>
  );
}

/** The tab's sentence from the endpoint's totals. */
export function maintenanceSentence(totals, onSetUp) {
  const t = totals || {};
  const parts = [];
  if (t.open) parts.push(<span key="o">{plural(t.open, 'open ticket')} at {plural(t.openProperties || 0, 'property', 'properties')}</span>);
  if (t.total) parts.push(<span key="t">{plural(t.total, 'ticket')} so far at {plural(t.properties || 0, 'property', 'properties')}</span>);
  if (!t.preventiveSchedules) {
    parts.push(<span key="pm"><span style={{ color: C.orange }}>no preventive schedules yet</span>{onSetUp && <> - <LinkButton onClick={onSetUp}>Set Up the First</LinkButton></>}</span>);
  } else {
    parts.push(<span key="pm">{plural(t.preventiveSchedules, 'preventive schedule')}{t.preventiveOverdue > 0 && <span style={{ color: C.red }}>{` - ${t.preventiveOverdue} overdue`}</span>}</span>);
  }
  if (!t.open && t.total) parts.unshift(<span key="none">No open tickets</span>);
  return parts;
}

export function MaintenanceTab({ assets, openAsset }) {
  const { data, status, reload } = useMaintenancePortfolio();
  const [query, setQuery] = useState('');
  const [show, setShow] = useState('all');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ((data && data.properties) || [])
      .filter((r) => show === 'all' || r.open > 0)
      .filter((r) => !q || String(r.propertyName || '').toLowerCase().includes(q));
  }, [data, query, show]);

  if (status === 'loading') {
    return <div data-tab="maintenance" aria-busy="true"><SkeletonBlocks count={4} height={36} borderRadius={8} /></div>;
  }
  if (status === 'denied') {
    return <Quiet>Maintenance across the portfolio is for the service desk and the Asset Management team. Each property&apos;s own Maintenance tab still shows its tickets.</Quiet>;
  }
  if (status === 'error') {
    return <ErrorBanner message="Couldn't load the tickets right now - please try again." onRetry={reload} />;
  }

  const totals = (data && data.totals) || {};
  // "Set Up the First": the property with the most tickets, else the first property listed.
  const first = (data.properties || [])[0] || (assets || []).find((a) => a && !a.deleted && (a.kind || 'property') === 'property');
  const setUp = first ? () => openAsset?.(first.propertyId || first.id, 'maintenance') : null;

  return (
    <div data-tab="maintenance">
      {totals.total || totals.preventiveSchedules
        ? <Sentence parts={maintenanceSentence(totals, setUp)} />
        : <Sentence parts={[<span key="n">No tickets have been filed at any property yet</span>, ...maintenanceSentence(totals, setUp).slice(-1)]} />}
      <Toolbar right={<LinkButton onClick={openTickets}>Open These in Tickets</LinkButton>}>
        <SearchBox value={query} onChange={setQuery} placeholder="Search properties" />
        <Segmented label="Show" value={show} onChange={setShow}
          options={[{ key: 'all', label: 'All Properties' }, { key: 'open', label: 'With Open Tickets' }]} />
      </Toolbar>
      {rows.length ? (
        <Table label="Tickets by property" head={HEAD} minWidth={640}>
          <tbody>
            {rows.map((r) => (
              <RowButton key={r.propertyId} label={`${r.propertyName}: ${plural(r.open, 'open ticket')}`} onOpen={() => openAsset?.(r.propertyId, 'maintenance')}>
                <td style={{ ...td, fontWeight: 600 }}>{r.propertyName}</td>
                <td style={{ ...td, ...num }}>{r.open ? <b style={{ fontWeight: 600 }}>{r.open}</b> : <Faint>0</Faint>}</td>
                <td style={{ ...td, ...num }}>{r.total}</td>
                <td style={{ ...td, paddingLeft: 24, fontVariantNumeric: 'tabular-nums' }}>{r.lastCreatedAt ? formatDate(r.lastCreatedAt) : <Faint>-</Faint>}</td>
                <td style={td}>{preventiveWords(r)}</td>
              </RowButton>
            ))}
          </tbody>
        </Table>
      ) : (
        <Quiet>{query || show === 'open' ? 'No properties match.' : 'No property has a ticket or a preventive schedule yet.'}</Quiet>
      )}
      {rows.length > 0 && <Quiet style={{ paddingTop: 12 }}>Tickets stay the work orders - a row opens that property&apos;s Maintenance, where each ticket opens in its own drawer.</Quiet>}
    </div>
  );
}

export default MaintenanceTab;
