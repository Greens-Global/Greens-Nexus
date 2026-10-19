// Occupancy, one rule for every Operations figure (Neil, Oct 20 2026 Ops review).
//
// The server (backend/ops_unit_classes.py) splits Cubby's units into storage,
// mailboxes and switched-off records. `units` is storage only; `mailboxes` is
// counted apart; switched-off records count nowhere.
//
//  - Storage occupancy = rented / RENTABLE storage units (rented + vacant).
//    Off-market storage (repairs, used by the facility) is shown next to it,
//    not counted against it.
//  - Mailbox occupancy = rented / ALL mailboxes. Cubby marks every unrented
//    mailbox unrentable, so "of rentable" would always read 100%.
//
// A payload from before the split (no `mailboxes`) still renders: it simply
// has no mailbox figure.

export function storageOccupancy(units) {
  const u = units || {};
  const rented = u.rented || 0;
  const rentable = rented + (u.vacant || 0);
  return { rented, rentable, total: u.total || 0, offMarket: u.unavailable || 0, share: rentable ? rented / rentable : null };
}

// null when the facilities in view have no mailboxes - the screen then shows no mailbox figure.
export function mailboxOccupancy(mailboxes) {
  const m = mailboxes || {};
  if (!m.total) return null;
  return { rented: m.rented || 0, total: m.total, share: (m.rented || 0) / m.total };
}

// Every rented unit, storage and mailboxes: the denominator for autopay and
// "average rent per rented unit", which cover every tenant.
export const rentedAll = (data) => (data.units?.rented || 0) + (data.mailboxes?.rented || 0);

// Rent from storage units only, for rent per rented square foot (a mailbox has no floor area).
export const storageRent = (data) => (data.rent?.rentRoll || 0) - (data.rent?.mailboxRentRoll || 0);
