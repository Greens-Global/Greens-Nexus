// The field sheets' shared logic (Construction plan phase 5, 11/03/2026):
// opening a ticket from anywhere, the photo uploads (the private
// ticket-evidence bucket, Ctrl+V on a computer) and the form styles. Plain
// calls only, so the offline layer (feat/field-offline) can wrap them later.
import { useState } from 'react';
import { filesFromPaste } from '../tasks/lib';
import { uploadTicketEvidence } from '../tickets/evidenceUpload';
import { setPendingOpen } from '../lib/pendingOpen';

export const OVERDUE_COLOR = '#dc2626';

/** Open a ticket in the Tickets desk from anywhere (the bell's own path). */
export function openTicket(id) {
  setPendingOpen('ticket', id);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));
  window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } }));
}

/**
 * Photos for a report or a finished job: { photos, busy, error, pick, remove,
 * onPaste, input }. Each upload goes to the private ticket-evidence bucket
 * (the canonical URL comes back through the viewer, as everywhere).
 */
export function usePhotos(prefix = 'field') {
  const [photos, setPhotos] = useState([]);   // [{ url, name }]
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');
  const add = async (files) => {
    const list = Array.from(files || []).filter((f) => (f.type || '').startsWith('image/'));
    if (!list.length) return;
    setError('');
    setBusy((n) => n + list.length);
    for (const f of list) {
      try {
        const url = await uploadTicketEvidence(f, prefix);
        setPhotos((p) => [...p, { url, name: f.name || 'Photo' }]);
      } catch (e) {
        setError(`That photo did not upload: ${e?.message || 'try again'}`);
      }
      setBusy((n) => n - 1);
    }
  };
  const onPaste = (e) => { const f = filesFromPaste(e); if (f.length) { e.preventDefault(); add(f); } };
  return { photos, busy: busy > 0, error, add, onPaste, remove: (url) => setPhotos((p) => p.filter((x) => x.url !== url)) };
}

export const field = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--ink)' };
export const box = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 16, fontFamily: 'inherit' };
