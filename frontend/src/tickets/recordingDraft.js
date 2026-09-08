// ── In-flight ticket draft, surviving navigation during a screen recording ──
// Recording an issue usually means LEAVING the Tickets view to reproduce it.
// That unmounts TicketsView and the create form with it - so when the person
// pressed Stop from another screen, their half-written ticket (and the fresh
// clip) evaporated. This module is the form's life raft: the draft is stashed
// here the moment recording starts, the clip is appended on completion, and if
// the create UI is gone by then we navigate back to Tickets (the app-wide
// nexus:navigate event) where the form reopens seeded from the stash.
// Plain module state on purpose: it must outlive React unmounts; it does not
// need to outlive a page reload (the recording itself wouldn't either).

let _draft = null;        // { form, tf, attachments: File[], resume: bool }
let _uiMounted = false;   // is a CreateTicketModal currently mounted?
let _openTicketId = null; // ticketId of the currently-mounted TicketDrawer, if any

export function stashDraft(d) { _draft = { ...d, resume: false }; }
export function appendDraftFile(f) { if (_draft) _draft.attachments = [...(_draft.attachments || []), f]; }
export function takeDraft() { const d = _draft; _draft = null; return d; }
export function peekDraft() { return _draft; }
export function setDraftUiMounted(v) { _uiMounted = v; }

// Same "is the UI still here" question as _uiMounted, but for an EXISTING
// ticket's drawer rather than the create form: a recording started from the
// Attachments tab needs to know, on Stop, whether that exact ticket is still
// on screen (nothing to do - the tab's own reload() picks up the upload) or
// whether the person navigated away (the app needs to bring them back to it).
export function setOpenTicketId(id) { _openTicketId = id; }
// Clears only if still pointing at `id` - drawer A's unmount cleanup must not
// clobber drawer B's id when switching directly from one ticket to another
// (B's mount effect can run before A's cleanup).
export function clearOpenTicketId(id) { if (_openTicketId === id) _openTicketId = null; }
export function isTicketDrawerOpen(id) { return !!id && _openTicketId === id; }

/** Recording ended (stop, cancel, or the browser's own Stop-sharing chip).
 *  If the create form is still mounted it simply reappears - live state is
 *  authoritative, drop the stash. If the person navigated away, flag the
 *  draft for resume and send the app back to the Tickets view; TicketsView
 *  reopens the form from the stash on mount. */
export function finishRecording() {
  if (!_draft) return;
  if (_uiMounted) { _draft = null; return; }
  _draft.resume = true;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));
}
