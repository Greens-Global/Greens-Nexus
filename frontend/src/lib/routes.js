// The address-bar aliases, in one place (Oct 14 2026): a module whose
// internal view id is not what the address should read. App.jsx parses and
// writes with these; the Daily Briefing's link map (dashboard/essentials/
// MyDay.jsx) resolves server links with the same table, so an alias added
// here reaches both. Old addresses keep resolving to the same view.
//   itemmanagement <-> inventory   (Neil, Jun 16)
//   construction   <-> ops         (the module was renamed, the id stayed)
//   workday        <-> myhr        (Workday since Sep 3; the address since Oct 14)
//   insights       <-> bi          (Business Intelligence renamed Insights, Neil Oct 14;
//                                   the id stays - it is the stored access grant)
//   team           <-> shifts      (Team since Neil, Oct 13 2026)
//   help-center    <-> support     (Help Center since Neil, Oct 13 2026)
//   credentials    <-> credvault   (Credential Vault renamed Credentials, Neil Oct 28
//                                   2026; the id stays - it is the stored access grant)
//   people          -> hr          (the module is called People; /people/... opens it,
//                                   the address it writes stays /hr - Oct 29 2026)
import { legacyItemsSub } from '../inventory/model/routes';

export const PATH_TO_VIEW = { itemmanagement: 'inventory', inventory: 'inventory', construction: 'ops', ops: 'ops', workday: 'myhr', myhr: 'myhr', insights: 'bi', bi: 'bi',
  team: 'shifts', shifts: 'shifts', 'help-center': 'support', support: 'support', credentials: 'credvault', credvault: 'credvault', people: 'hr' };
export const VIEW_TO_PATH = { inventory: 'itemmanagement', ops: 'construction', myhr: 'workday', bi: 'insights', shifts: 'team', support: 'help-center', credvault: 'credentials' };

// A module tab's obvious address (11/05/2026): /notes is Dashboard > Notes -
// it used to say Page Not Found because Notes lives under Dashboard. Each
// lands on its tab, typed into the address bar or sent through navigate();
// the address then reads the tab's full path. `item`: a second segment is
// one record on that tab (/notes/<id> -> notes:<id>, a note's own link).
export const TAB_ADDRESSES = {
  notes:           { view: 'dashboard', sub: 'notes', item: true },
  'time-sheet':    { view: 'myhr', sub: 'timesheet' },
  timesheet:       { view: 'myhr', sub: 'timesheet' },
  'time-off':      { view: 'myhr', sub: 'timeoff' },
  'shift-planner': { view: 'shifts', sub: 'schedule' },
  'org-chart':     { view: 'hr', sub: 'hr-org' },
  'nexus-sign':    { view: 'documents', sub: 'documents-esign' },
  'pdf-tools':     { view: 'documents', sub: 'documents-pdf' },
};

// { view, sub } for a tab address, or null when `view` is not one.
export function tabAddress(view, sub) {
  const hit = Object.hasOwn(TAB_ADDRESSES, view || '') ? TAB_ADDRESSES[view] : null;
  if (!hit) return null;
  return { view: hit.view, sub: hit.item && sub ? `${hit.sub}:${sub}` : hit.sub };
}

// Purchase Requisition moved to Workday > Purchase Requests (Neil, Oct 22
// 2026). Where an old address goes: the retired 'purchase' view (sub 'new' =
// the form, 'log' = the list) and Item Management's old 'purchasereqs' tab -
// bells, emails, bookmarks and saved dashboard tiles still carry them.
// null = not a moved address.
export function purchaseRedirect(view, sub) {
  if (view === 'purchase') return { view: 'myhr', sub: sub === 'new' ? 'purchase:new' : 'purchase' };
  if (view === 'inventory' && sub === 'purchasereqs') return { view: 'myhr', sub: 'purchase' };
  return null;
}

// Item Management's pre-redesign subs (Neil, 11/02/2026): /itemmanagement/
// checkouts, /catalog, /manage... land on the new tabs. Mapped HERE, where
// every address and every in-app navigation is resolved, so the old address
// is replaced - never pushed and then rewritten, which made Back loop
// between the two. null = not an old Items address.
export function itemsRedirect(view, sub) {
  if (view !== 'inventory' || !sub) return null;
  const next = legacyItemsSub(sub);
  return next ? { view, sub: next } : null;
}

// An item's own link (Items phase 4, QR tags, Neil 11/02/2026):
// /itemmanagement/item/<id> - also /inventory/item/<id> - is the Items sub
// "item/<id>", which the address writer turns back into the same path. The
// rest of the link rules live in inventory/scan/itemLink.js. null = not one.
export function itemLinkSub(view, segs) {
  return view === 'inventory' && segs?.[1] === 'item' && segs?.[2] ? `item/${segs[2]}` : null;
}

// A place's own link (Scan to Request, 11/03/2026): /tickets/place/<property>
// and /tickets/place/<property>/<asset> - a site or equipment QR tag - are the
// Tickets sub "place/<property>[/<asset>]", written back as the same path.
// The rest of the link rules live in maintenance/placeLink.js. null = not one.
export function ticketPlaceSub(view, segs) {
  if (view !== 'tickets' || segs?.[1] !== 'place' || !segs?.[2]) return null;
  return `place/${segs[2]}${segs[3] ? `/${segs[3]}` : ''}`;
}

// The address the app writes for its state. On the FIRST write - the app
// rewriting the address it was opened at (/support -> /help-center, a default
// tab added) - the query and hash ride along: an email's /support?ticket=<id>
// or a doc link's ?doc=&section= is read by the screen after it loads, and
// dropping it there left the person on the list with nothing open (Oct 28
// 2026). Every later move is a real navigation and starts clean.
export function addressFor(path, { first = false, search = '', hash = '' } = {}) {
  return first ? `${path}${search || ''}${hash || ''}` : path;
}
