// ticketExport - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { PRIORITY_META } from '../tasks/theme';
import {
  fmtDate, TICKET_TYPE_META,
  TICKET_STATUS_META,
  fmtDueAt,
  ticketNoShort,
  serviceAreaLabel,
  richToPlain,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { helpWithLabel } from './ticketMeta';
import { latestCommentText } from './LatestComment';

// Export - same client-side CSV pattern as the task module's own report export
// (tasks/ManageView.jsx downloadCSV): a BOM'd CSV blob opens cleanly in Excel,
// no server round-trip or xlsx binary needed.
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadTicketsCsv(rows, nameOf, companyName, hrDeptName) {
  const headers = ['Code', 'Title', 'Type', 'Help With', 'Service Area', 'Company', 'Department', 'Status', 'Priority', 'Due Date', 'Requester', 'Assignee', 'Created', 'Resolved At', 'Resolution', 'Description', 'Latest Comment'];
  const body = rows.map((t) => [
    ticketNoShort(t.code) || '', t.subject || '', TICKET_TYPE_META[t.type]?.label || t.type || '',
    helpWithLabel(t), serviceAreaLabel(t.serviceArea) || '',
    companyName(t.companyId) || '', hrDeptName(t.hrDepartmentId) || '',
    TICKET_STATUS_META[t.status]?.label || t.status || '', PRIORITY_META[t.priority]?.label || t.priority || '',
    (t.slaDueAt || t.slaDueOn) ? fmtDueAt(t) : '', t.requesterId ? (nameOf(t.requesterId) || t.requesterId) : '',
    t.assigneeId ? (nameOf(t.assigneeId) || t.assigneeId) : '', t.createdAt ? fmtDate(t.createdAt) : '',
    t.resolvedAt ? fmtDate(t.resolvedAt) : '', t.resolutionNote || '', richToPlain(t.description),
    latestCommentText(t.latestComment, nameOf),
  ]);
  const lines = [headers, ...body].map((r) => r.map(csvEscape).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { downloadTicketsCsv };
