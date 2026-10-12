// Cross-view jump to one person's card in the Contact Directory (Support >
// Contact Directory, Oct 2026) - the header search's People results and any
// "contact this person" link land here.
//
// Same two-channel handoff as lib/personNav.js: the email is written down for
// a Directory that has yet to mount (it is lazy, so the first jump always
// arrives before the listener exists) AND announced for one that is already
// mounted (it never re-mounts, so the note alone would go unread).
import { setPendingOpen } from './pendingOpen';

export const CONTACT_OPEN_KIND = 'directory';
export const CONTACT_EVENT = 'nexus:contact';

export function openContact(email) {
  const em = (email || '').trim().toLowerCase();
  if (!em) return;
  setPendingOpen(CONTACT_OPEN_KIND, em);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'directory' } }));
  window.dispatchEvent(new CustomEvent(CONTACT_EVENT, { detail: { email: em } }));
}
