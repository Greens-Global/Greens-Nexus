// PDF Tools handoffs (Neil, 11/02/2026). The module is an iframe inside
// views/PdfEditorModule.jsx, so "open this file there" from another screen is a
// note it picks up on mount (lib/pendingOpen.js), and its Send For Signature is a
// note Documents picks up on the Nexus Sign tab. No React here, so the side panel,
// the Egnyte browser and the shell all read the same answers.
import { api } from '../api';
import { setPendingOpen } from './pendingOpen';

export const PDF_TOOLS_PENDING = 'pdf-tools';
export const ESIGN_PREFILL_PENDING = 'esign-prefill';

export const isPdfName = (name) => /\.pdf$/i.test(String(name || ''));

/** A name Egnyte will take: no path characters, ending in .pdf. */
export function pdfFileName(title) {
  const base = String(title || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'document';
  return isPdfName(base) ? base : `${base}.pdf`;
}

/** "Lease.pdf" taken in this folder: the first of "Lease (1).pdf", "Lease (2).pdf"... that is not. */
export function freeFileName(name, taken) {
  const lower = new Set((taken || []).map((n) => String(n).toLowerCase()));
  const stem = pdfFileName(name).replace(/\.pdf$/i, '');
  for (let i = 1; i < 1000; i += 1) {
    const next = `${stem} (${i}).pdf`;
    if (!lower.has(next.toLowerCase())) return next;
  }
  return `${stem} (copy).pdf`;
}

/**
 * How a library row's PDF is fetched, or null if it has none this person can
 * fetch here. Same rule as the side panel's preview: a sealed copy reached by
 * a link, a pay document they may not open and an envelope with no document
 * behind it yet stay out.
 */
export function pdfLoadFor(row) {
  if (!row) return null;
  const isDoc = row.kind === 'document';
  const completed = row.signStatus === 'completed';
  if (row.kind === 'hr') {
    if (row.locked || row.signed) return null;
    return () => api.packetDocumentPdf(row.eventId, row.documentId);
  }
  if (completed && row.partyId) return () => api.mySignFinal(row.partyId);
  if (completed && row.canManageEnvelope) return null;
  return isDoc ? () => api.exportDocumentPdf(row.id) : null;
}

/** The note PDF Tools opens for a library row. */
export function documentTarget(row) {
  const load = pdfLoadFor(row);
  return load ? { kind: 'documents', id: row.id, title: row.title, name: pdfFileName(row.title), load } : null;
}

/** Open In PDF Tools from a Documents row. Documents' own tab, so Back returns to the list. */
export function openRowInPdfTools(row) {
  const target = documentTarget(row);
  if (!target) return;
  setPendingOpen(PDF_TOOLS_PENDING, target);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-pdf' } }));
}

/**
 * Open In PDF Tools from an Egnyte file. PDF Tools' own address: someone in the
 * Egnyte module may have no Documents access.
 */
export function openEgnyteInPdfTools(file) {
  if (!file?.path) return;
  setPendingOpen(PDF_TOOLS_PENDING, { kind: 'egnyte', path: file.path, name: file.name });
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'pdf-editor' } }));
}
