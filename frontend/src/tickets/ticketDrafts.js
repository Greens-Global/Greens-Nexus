// The reply being written on a ticket is a draft that is kept (11/13/2026).
// It used to be the drawer's own state: a reload, a move to another screen or
// closing the drawer threw a half-written reply away. It lives in the task
// module's draft store now (tasks/taskDrafts.js - one store, one week), with
// the ticket's own rules on top:
//   - ONE draft per ticket and person. The reply box is one box with a
//     Public Reply / Internal Note switch, so the draft is the words plus
//     which of the two it was.
//   - Per person: the key carries whose draft it is, so on a shared computer
//     the next person to sign in never sees it (an internal note above all).
//     Under Act As it is the administrator's own draft for that person, not
//     the person's.
//   - It comes back with the ticket - after a reload, another screen, the
//     drawer closed - until it is sent (the drawer's Done / Send clears it)
//     or it is a week old.
//   - Words only on disk: a pasted screenshot is held inline until the reply
//     is sent, megabytes that do not belong in localStorage. It stays in
//     memory for this visit and is left out of the stored copy.
// Nobody signed in (no owner) keeps nothing: the reply is plain state.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isEmptyDoc } from '../tasks/RichDescription';
import { TTL_MS, clearDraft, draftKey, getDraft, setDraft, useTaskDraft } from '../tasks/taskDrafts';

export const REPLY_KIND = 'ticketReply';
const EMPTY = Object.freeze({ body: '', internal: false });
const lower = (s) => String(s || '').trim().toLowerCase();

/** Whose drafts these are: the signed-in person, or "<administrator> as
 *  <person>" while Act As is on. '' = nobody known, nothing is kept. */
export function draftOwner({ myEmail, realEmail, actingAs } = {}) {
  const real = lower(realEmail);
  const target = lower(actingAs?.targetEmail);
  if (target) return real ? `${real} as ${target}` : '';
  return real || lower(myEmail);
}

export const replyDraftKey = (ticketId, owner) => draftKey(ticketId, REPLY_KIND, owner);

// The words without the pictures still held inline (see the header).
const wordsOnly = (html) => String(html || '').replace(/<img\b[^>]*\bsrc="data:[^"]*"[^>]*>/gi, '');

const expired = (d) => !!d?.at && Date.now() - d.at >= TTL_MS;

function toReply(d) {
  if (!d || d.kind !== REPLY_KIND || expired(d)) return EMPTY;
  return { body: d.mem?.body ?? d.text ?? '', internal: !!d.internal };
}

/** The reply kept for this ticket and person: { body, internal }. */
export function getReplyDraft(ticketId, owner) {
  return ticketId && owner ? toReply(getDraft(replyDraftKey(ticketId, owner))) : EMPTY;
}

export function clearReplyDraft(ticketId, owner) {
  if (ticketId && owner) clearDraft(replyDraftKey(ticketId, owner));
}

/** Set the kept reply: a { body, internal } value, or fn(current). */
export function setReplyDraft(ticketId, owner, update) {
  if (!ticketId || !owner) return;
  const key = replyDraftKey(ticketId, owner);
  const prev = toReply(getDraft(key));
  const next = typeof update === 'function' ? update(prev) : update;
  if (!next || next === prev) return;
  const body = next.body || '';
  const internal = !!next.internal;
  // Put back to nothing (what a sent reply leaves behind): no draft at all.
  if (!body && !internal) { clearDraft(key); return; }
  setDraft(key, { taskId: ticketId, kind: REPLY_KIND, owner }, { text: wordsOnly(body), internal, mem: { body } });
}

/**
 * The ticket drawer's reply, kept. Same shape as the state it replaces:
 * [reply, setReply] with reply = { body, internal } and setReply(value | fn).
 */
export function useTicketReplyDraft(ticketId, owner) {
  const kept = !!(ticketId && owner);
  const key = kept ? replyDraftKey(ticketId, owner) : '';
  const [stored] = useTaskDraft(key, { taskId: ticketId, kind: REPLY_KIND, owner });
  const [plain, setPlain] = useState(EMPTY);
  const reply = useMemo(() => (kept ? toReply(stored) : plain), [kept, stored, plain]);
  const setReply = useCallback((update) => {
    if (kept) setReplyDraft(ticketId, owner, update);
    else setPlain(update);
  }, [kept, ticketId, owner]);
  // Leaving the ticket with nothing written keeps nothing - an Internal Note
  // switch flipped over an empty box does not come back flipped - and a
  // draft past its week is dropped rather than left behind.
  useEffect(() => {
    if (!kept) return undefined;
    if (expired(getDraft(key))) clearDraft(key);
    return () => { if (isEmptyDoc(toReply(getDraft(key)).body)) clearDraft(key); };
  }, [kept, key]);
  return [reply, setReply];
}

// ── Leaving a ticket that holds unsaved work ─────────────────────────────────
// Field edits are discarded when the person leaves without Done; the reply
// is not - it is the draft above. The open drawer notes what it holds
// (the way it notes its ticket in recordingDraft.js) so the screens that
// host it can word their own question (drawerGuard.confirmSwitchTicket).
let held = null;   // { id, edits, reply } for the drawer that is open

export function noteHeld(id, edits, reply) { held = { id, edits: !!edits, reply: !!reply }; }
// Only if still this drawer's note - drawer B can mount before A's cleanup runs.
export function clearHeld(id) { if (held?.id === id) held = null; }
export function heldNow() { return held; }

/** The words for leaving a ticket that holds unsaved work, or null when it
 *  holds none. `leaving`: what the confirm button does ('Close' the drawer,
 *  or 'Continue' to wherever the person was going). */
export function leaveQuestion({ edits, reply } = {}, leaving = 'Continue') {
  if (edits) {
    return {
      message: `Discard your changes to this ticket? Nothing has been saved or sent yet.${reply ? ' Your reply is kept as a draft.' : ''}`,
      opts: { title: 'Discard Changes?', confirmText: 'Discard', cancelText: 'Keep Editing', danger: true },
    };
  }
  if (reply) {
    return {
      message: 'Your reply has not been sent. It is kept as a draft on this ticket until you send it.',
      opts: { title: 'Reply Not Sent', confirmText: leaving, cancelText: 'Keep Editing' },
    };
  }
  return null;
}
