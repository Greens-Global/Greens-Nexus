// Record link refs (Neil, 11/06-07/2026): `<kind>:<id>` as a [[ chip stores it
// in data-ref. Kept apart from notes/recordLink.jsx (the editor node) so
// plain renderers (tasks/lib.js sanitizeRichHtml) can check a ref without
// pulling the editor into their bundle.
// Mirrors routers/notes.py _RECORD_REF and record_links.RECORD_REF - change all three together.
const REF = /^(note|task|job|kb|ticket):[A-Za-z0-9_\-.]{1,100}$/;
export const safeRef = (v) => (typeof v === 'string' && REF.test(v) ? v : '');

// A chip outside an editor (a task comment, a ticket note - sanitized HTML) is
// a plain <a data-type="recordLink" data-ref> with no href; one listener on
// the document opens it. Installed the first time such HTML is rendered.
let clicksOn = false;
export function listenForRecordLinkClicks() {
  if (clicksOn || typeof document === 'undefined') return;
  clicksOn = true;
  const open = (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter') return;
    const a = e.target?.closest?.('a[data-type="recordLink"][data-ref]');
    if (!a || a.closest('.ProseMirror')) return;   // an editor's chip opens itself
    const ref = safeRef(a.getAttribute('data-ref'));
    if (!ref) return;
    e.preventDefault();
    import('../notes/recordLink').then((m) => m.openRecord(ref));
  };
  // Capture: a sheet's panel stops its clicks from bubbling (so they never
  // read as a click outside it), and a chip sits inside those panels.
  document.addEventListener('click', open, true);
  document.addEventListener('keydown', open, true);
}

/** `html` with every record chip turned back into its plain words. */
export const unlinkRecords = (html) => String(html || '').replace(/<a\b[^>]*data-type="recordLink"[^>]*>([\s\S]*?)<\/a>/g, '$1');

/** The address a record opens at, for a board card's link (the board opens
 *  it inside Nexus; the address serves an exported board and a new tab). */
export function recordHref(ref) {
  const r = safeRef(ref);
  if (!r) return '';
  const i = r.indexOf(':');
  const kind = r.slice(0, i);
  const id = encodeURIComponent(r.slice(i + 1));
  // The addresses openRecord (notes/recordLink.jsx) lands on.
  if (kind === 'task') return `/tasks?task=${id}`;
  if (kind === 'ticket') return `/tickets?ticket=${id}`;
  if (kind === 'note') return `/dashboard/notes:${id}`;
  if (kind === 'job') return `/construction/project:${id}`;
  return `/sop/page:${id}`;
}
