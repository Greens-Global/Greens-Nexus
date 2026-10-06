// A property's Open / Closed Tickets as the same table Support and the Ticket
// module use (Pranshu, 10/06): Ticket No, Title, a solid status cell, Assigned
// To, Created Date, Last Updated, Latest Comment - uppercase sortable headers,
// drag-to-resize, one border per row, zebra bands. Clicking a row opens the
// ticket (or its summary for someone the ticket rules keep out); the latest
// comment is the newest PUBLIC reply only.
import { Fragment, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { NX, FONT } from '../../../tasks/theme';
import { Avatar } from '../../../tasks/components';
import { useTableColumns, ColResizer } from '../../../tasks/tableCols';
import { TICKET_STATUS_META, TICKET_STATUS_ORDER } from '../../../tickets/ticketMeta';
import { LatestCommentPreview } from '../../../tickets/LatestComment';
import { formatDateTime } from '../../../lib/datetime.js';

const COLUMNS = [
  { key: 'ticket', label: 'Ticket No', width: 110, sort: (t) => Number(String(t.code || '').replace(/\D/g, '')) || 0 },
  { key: 'title', label: 'Title', width: 340, sort: (t) => (t.subject || '').toLowerCase() },
  { key: 'status', label: 'Status', width: 140, sort: (t) => TICKET_STATUS_ORDER.indexOf(t.status) },
  { key: 'assignedTo', label: 'Assigned To', width: 170, sort: (t) => (t.assigneeName || '').toLowerCase() },
  { key: 'created', label: 'Created Date', width: 160, sort: (t) => t.createdAt || '' },
  { key: 'updated', label: 'Last Updated', width: 160, sort: (t) => t.modifiedAt || t.createdAt || '' },
  { key: 'latestComment', label: 'Latest Comment', width: 280, sort: (t) => t.latestComment?.createdAt || '' },
];

function StatusCell({ status }) {
  const m = TICKET_STATUS_META[status] || { label: status, color: NX.dim };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
      padding: '0 10px', background: m.color, color: '#fff', fontSize: 12, fontWeight: 700,
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: FONT,
    }}>{m.label}</div>
  );
}

const tag = (color) => ({ marginLeft: 8, flexShrink: 0, fontSize: 11, fontWeight: 700, color, whiteSpace: 'nowrap' });

export function PropertyTicketsTable({ rows, onOpen, tableKey }) {
  const { cols, widths, template, startResize, resetWidth, autofitWidth, wrapRef } =
    useTableColumns({ table: tableKey, cols: COLUMNS });
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' });
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key);
    if (!col) return rows;
    const m = sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const x = col.sort(a); const y = col.sort(b);
      return (x < y ? -1 : x > y ? 1 : 0) * m;
    });
  }, [rows, sort]);
  const nameOf = (email) => sorted.find((t) => t.latestComment?.authorId === email)?.latestComment?.authorName || email;
  const cell = { display: 'flex', alignItems: 'center', minHeight: 40, padding: '0 10px', borderRight: `1px solid ${NX.border2}`, overflow: 'hidden' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content', fontFamily: FONT, minWidth: 'fit-content' }}>
        <div ref={wrapRef} style={{ '--nx-grid': template, display: 'grid', gridTemplateColumns: 'var(--nx-grid)', background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: '10px 10px 0 0' }}>
          {cols.map((col) => {
            const active = sort.key === col.key;
            const SortIcon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
            return (
              <div key={col.key} onClick={() => onSort(col.key)} title={`Sort by ${col.label}`}
                style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, minHeight: 34, padding: '0 10px', cursor: 'pointer', userSelect: 'none', borderRight: `1px solid ${NX.border2}`, boxSizing: 'border-box' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: NX.ink, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
                <SortIcon size={11} style={{ flexShrink: 0, opacity: active ? 1 : 0.4 }} />
                <ColResizer onMouseDown={startResize(col.key, widths[col.key] ?? col.width)} onReset={() => resetWidth(col.key)} onAutofit={() => autofitWidth(col.key)} />
              </div>
            );
          })}
        </div>
        {sorted.map((t, idx) => {
          const last = idx === sorted.length - 1;
          const open = () => onOpen(t);
          const cells = {
            ticket: <div key="ticket" style={{ ...cell, fontWeight: 700, fontSize: 13, color: NX.ink }}>{(t.codeLabel || '').replace(/^Ticket /, '') || '-'}</div>,
            title: (
              <div key="title" style={{ ...cell, fontSize: 13, color: NX.ink, whiteSpace: 'nowrap' }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject}</span>
                {t.onParcel && <span style={tag(NX.dim)}>Parcel: {t.propertyName}</span>}
                {t.parentTicketId && <span style={tag(NX.blue)}>Service From {t.parentCodeLabel}</span>}
                {t.isServiceParent && <span style={tag(NX.blue)}>Recurring</span>}
                {t.approvalStatus === 'pending' && <span style={tag(NX.blue)}>Awaiting Approval</span>}
                {t.logged && <span style={tag(NX.green)}>Recorded</span>}
                {t.needsAction && <span style={tag(NX.red)}>Needs Action</span>}
                {['resolved', 'closed'].includes(t.status) && !t.maintenanceRecord && <span style={tag(NX.dim)}>Closed Without Work</span>}
              </div>
            ),
            status: <div key="status" style={{ minHeight: 40, borderRight: `1px solid ${NX.border2}` }}><StatusCell status={t.status} /></div>,
            assignedTo: (
              <div key="assignedTo" style={{ ...cell, gap: 6, fontSize: 13, color: NX.dim }}>
                {t.assigneeEmail
                  ? <><Avatar email={t.assigneeEmail} name={t.assigneeName} size={20} card={false} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.assigneeName || t.assigneeEmail}</span></>
                  : <span style={{ color: NX.faint }}>Unassigned</span>}
              </div>
            ),
            created: <div key="created" style={{ ...cell, fontSize: 12, color: NX.dim }}>{formatDateTime(t.createdAt)}</div>,
            updated: <div key="updated" style={{ ...cell, fontSize: 12, color: NX.dim }}>{formatDateTime(t.modifiedAt || t.createdAt)}</div>,
            latestComment: (
              <div key="latestComment" style={{ ...cell, minWidth: 0, borderRight: 'none' }}>
                <LatestCommentPreview comment={t.latestComment} nameOf={nameOf} onOpen={open} />
              </div>
            ),
          };
          return (
            <Fragment key={t.id}>
              <div role="button" tabIndex={0} className="nx-row-hover" onClick={open}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
                style={{
                  display: 'grid', gridTemplateColumns: 'var(--nx-grid)', '--nx-grid': template,
                  background: idx % 2 ? NX.zebra : NX.surface, cursor: 'pointer',
                  borderLeft: `1px solid ${NX.border}`, borderRight: `1px solid ${NX.border}`,
                  borderBottom: `1px solid ${last ? NX.border : NX.border2}`,
                  borderRadius: last ? '0 0 10px 10px' : 0,
                }}>
                {cols.map((c) => cells[c.key])}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
