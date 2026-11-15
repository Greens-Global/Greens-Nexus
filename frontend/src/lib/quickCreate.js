// What the header's Quick Actions menu offers - the list, the one visibility
// rule and how the rows are laid out; components/QuickCreate.jsx draws it.
//
// Quick Actions (Neil, 11/12/2026) took over from the "+" Create menu (Neil,
// Oct 29 2026): a green bolt in the same place, and a menu in two steps.
//   First tap  - the top row: four everyday starts as icons, one tap each
//                (TOP - Neil's order: New Task, New Ticket, New Note, New
//                Board), then one row per group.
//   Second tap - a group row opens its own list: New, Request, Send.
// The rule that keeps it short: every row STARTS something that is yours - a
// thing you make, ask for or send. A place to go is the left menu's job and
// the search bar's, never a row here. The punch is not here either: the
// clock is in the left menu on every page.
//
// Nothing here is a form of its own. Each row opens the create flow the
// module already has:
//   compose - the Dashboard's Quick Action composers (dashboard/
//             QuickActionModals.jsx: the Tasks module's CreateTaskModal, the
//             Ticket module's CreateTicketModal, the Outlook mail and event
//             composers), opened in place over the current screen.
//   run     - an event the feature listens for (Quick Note, New Board).
//   go      - a { view, sub } the module answers by opening its own create
//             dialog - "<thing>:new" style subs, the convention "purchase:new"
//             started (Workday > Purchase Requests):
//               documents / documents-new            Documents > New Document
//               documents / documents-new-sheet      Documents > New Sheet
//               ops / construction-activity:log      Site Activity, starting today's log
//               tickets / report-problem             the place sheet: pick a property, Report a Problem
//               inventory / catalog                  the item catalog's Request
//               timeclock / timeoff                  Workday > Time Off, on Request Time Off
//               timeclock / reimbursements:new       Reimbursements on its New form
//               timeclock / purchase:new             Purchase Requests on its New form
//               timeclock / timesheet                the Time Sheet, where a day is corrected
//               timeclock / performance:kudos:new    Performance with Give Kudos open
//               timeclock / form:pick                Workday's form picker
//
// Who sees a row is the left menu's own rule (Sidebar's isNavItemVisible)
// for the module it lands in, plus the grant level that module's own New
// button asks for when a row sets `level` (canAccessModule). `timeTracked`
// rows are not for a time-tracking-exempt person; `internal` rows are not
// for an external guest; a `tier` row only for that tier and up (useRole's
// can - the same check the module's own button makes); a `jobsite` row only
// for someone on an open Construction job (useOnJobsite) - Construction is on
// everyone's left menu (its walls are per job), but a Daily Log is not.
//
// New Note opens the Quick Note panel through the `nexus:quick-note` event.
// It is the way in (with Ctrl+Alt+N) - the top bar has no scratchpad button
// (Neil, Oct 30 2026).
//
// Time Off, Reimbursements and Purchase Requests were kept off the "+" on
// purpose (Neil, Oct 29 2026) and came back with the second step (Neil,
// 11/12/2026). Still off: 1:1s, Ask HR, Credentials, Send for Signature and
// Workflows - those start from their own modules.
import {
  CheckSquare, NotebookPen, FilePlus2, Package, Mail, CalendarPlus, ClipboardList,
  CalendarClock, Receipt, ShoppingCart, Timer, Award, Plus, Hand, Send,
  Sheet as SheetIcon, HardHat, Wrench, Megaphone,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import TicketToken from '../components/icons/TicketToken';
import { api } from '../api';
import BoardIcon from '../components/icons/BoardIcon';
import { NAV, isNavItemVisible } from '../components/Sidebar';

export const goTo = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

// The second step's lists, in display order.
export const GROUPS = [
  { key: 'new', label: 'New', Icon: Plus },
  { key: 'request', label: 'Request', Icon: Hand },
  { key: 'send', label: 'Send', Icon: Send },
];

// Every action, in the order its group lists it. `label` is the whole name
// (the top row, a row standing alone); `short` is what it reads as under its
// group's title. `module` = the left-menu item the flow lives in; `level` =
// the grant level that module's own New button needs. `keys` = a shortcut
// that already exists, shown beside the row.
export const ACTIONS = [
  { key: 'task', group: 'new', label: 'New Task', short: 'Task', Icon: CheckSquare, module: 'tasks', compose: 'task', keys: 'C T' },
  { key: 'ticket', group: 'new', label: 'New Ticket', short: 'Ticket', Icon: TicketToken, module: 'support', compose: 'ticket' },
  { key: 'note', group: 'new', label: 'New Note', short: 'Note', Icon: NotebookPen, module: 'dashboard',
    run: (seed) => window.dispatchEvent(new CustomEvent('nexus:quick-note', { detail: { seed: seed?.html || '' } })) },
  // New Board (Neil, 11/02/2026): a whiteboard note, made and opened on
  // Dashboard > Notes. Loaded on click so the header stays light.
  { key: 'board', group: 'new', label: 'New Board', short: 'Board', Icon: BoardIcon, module: 'dashboard',
    run: () => import('../notes/newBoard').then((m) => m.newBoardFromAnywhere()) },
  { key: 'document', group: 'new', label: 'New Document', short: 'Document', Icon: FilePlus2, module: 'documents', go: ['documents', 'documents-new'] },
  // Sheet and Daily Log (Neil, 11/14/2026). A Daily Log starts today's log
  // when the person is on one jobsite; with several, Site Activity asks which.
  { key: 'sheet', group: 'new', label: 'New Sheet', short: 'Sheet', Icon: SheetIcon, module: 'documents', go: ['documents', 'documents-new-sheet'] },
  { key: 'daily-log', group: 'new', label: 'New Daily Log', short: 'Daily Log', Icon: HardHat, module: 'ops', jobsite: true, go: ['ops', 'construction-activity:log'] },

  { key: 'time-off', group: 'request', label: 'Request Time Off', short: 'Time Off', Icon: CalendarClock, module: 'myhr', go: ['timeclock', 'timeoff'] },
  { key: 'reimbursement', group: 'request', label: 'New Reimbursement', short: 'Reimbursement', Icon: Receipt, module: 'myhr', go: ['timeclock', 'reimbursements:new'] },
  { key: 'purchase', group: 'request', label: 'New Purchase Request', short: 'Purchase Request', Icon: ShoppingCart, module: 'myhr', go: ['timeclock', 'purchase:new'] },
  { key: 'item', group: 'request', label: 'Request an Item', short: 'Item', Icon: Package, module: 'inventory', go: ['inventory', 'catalog'] },
  // Fill a Form (Forms & Checklists, Neil 11/02/2026): Workday's form picker
  // (TimeClock.jsx's "form:pick" deep link; "form:<templateId>" opens one).
  { key: 'form', group: 'request', label: 'Fill a Form', short: 'Fill a Form', Icon: ClipboardList, module: 'myhr', go: ['timeclock', 'form:pick'] },
  { key: 'time-fix', group: 'request', label: 'Time Sheet Fix', short: 'Time Sheet Fix', Icon: Timer, module: 'myhr', timeTracked: true, go: ['timeclock', 'timesheet'] },
  // Report a Problem (Neil, 11/14/2026): a scanned tag's sheet, asking which
  // property first - ONE ticket through the desk's own intake.
  { key: 'report-problem', group: 'request', label: 'Report a Problem', short: 'Report a Problem', Icon: Wrench, module: 'tickets', go: ['tickets', 'report-problem'] },

  // The Dashboard's Quick Actions offer these to everyone who has a Dashboard.
  { key: 'email', group: 'send', label: 'New Email', short: 'Email', Icon: Mail, module: 'dashboard', compose: 'email' },
  { key: 'event', group: 'send', label: 'New Event', short: 'Event', Icon: CalendarPlus, module: 'dashboard', compose: 'event' },
  { key: 'kudos', group: 'send', label: 'Give Kudos', short: 'Kudos', Icon: Award, module: 'myhr', internal: true, go: ['timeclock', 'performance:kudos:new'] },
  // Announcement (Neil, 11/14/2026): the Dashboard's own composer, for the
  // administrators who may post one.
  { key: 'announcement', group: 'send', label: 'New Announcement', short: 'Announcement', Icon: Megaphone, module: 'dashboard', tier: 'administrator', compose: 'announcement' },
];

// The top row (Neil, 11/12/2026). A person who cannot use one of the four
// gets the next thing they can, so the row stays full: TOP_FILL, in order.
export const TOP = ['task', 'ticket', 'note', 'board'];
export const TOP_FILL = ['form', 'item', 'email', 'event', 'document'];
const TOP_SIZE = 4;

/** The actions this person may use. `role` is useRole(). */
export function visibleActions(role) {
  return ACTIONS.filter((it) => {
    const nav = NAV.find((n) => n.view === it.module);
    if (!nav || !isNavItemVisible(nav, role || {})) return false;
    if (it.level && !role?.canAccessModule?.(it.module, 'administrator', it.level)) return false;
    if (it.timeTracked && role?.timeTrackingExempt === true) return false;
    if (it.internal && role?.isExternal) return false;
    if (it.tier && !role?.can?.(it.tier)) return false;
    if (it.jobsite && !role?.onJobsite) return false;
    return true;
  });
}

// Whether this person is on an open Construction job - the jobs Construction
// itself lists for them (GET /construction/projects, the same per-job wall).
// Asked once per page load and only after the menu first opens, so the
// header costs nothing more for the people who never use it; until it
// answers, and if it fails, the Daily Log row is simply not there.
// The answer is kept per person (the account and Act As), never shown to
// anyone else.
let jobsiteAsk = null;   // { who, answer: Promise<boolean> }
const isOpenJob = (p) => p && !p.archived && ['active', 'on_hold', ''].includes(p.status || '');
export function useOnJobsite(role, open) {
  const wanted = ACTIONS.some((it) => it.jobsite && visibleActions({ ...role, onJobsite: true }).includes(it));
  const who = role?.myEmail || '';   // the Act As person while acting
  const [answer, setAnswer] = useState({ who: '', yes: false });
  useEffect(() => {
    const asked = jobsiteAsk?.who === who;
    if (!wanted || !(open || asked)) return undefined;
    let live = true;
    if (!asked) {
      const mine = { who, answer: null };
      mine.answer = Promise.resolve()
        .then(() => api.getConstructionProjects())
        .then((rows) => (Array.isArray(rows) ? rows : []).some(isOpenJob))
        .catch(() => { if (jobsiteAsk === mine) jobsiteAsk = null; return false; });
      jobsiteAsk = mine;
    }
    jobsiteAsk.answer.then((yes) => { if (live) setAnswer({ who, yes }); });
    return () => { live = false; };
  }, [wanted, open, who]);
  return wanted && answer.who === who && answer.yes;
}

/**
 * The first tap: `tiles` (the top row) and `rows` under it - a group row
 * ({ kind: 'group', key, label, Icon, hint, items }) or, for a group with one
 * action in it, that action itself ({ kind: 'item', item }): two taps only
 * where there is a choice to make. A group that holds nothing the top row
 * does not already offer is left out.
 */
export function layoutActions(items) {
  const by = (key) => items.find((it) => it.key === key);
  const tiles = [...TOP, ...TOP_FILL].map(by).filter(Boolean).slice(0, TOP_SIZE);
  const onTop = new Set(tiles.map((t) => t.key));
  const rows = [];
  GROUPS.forEach((g) => {
    const mine = items.filter((it) => it.group === g.key);
    if (!mine.some((it) => !onTop.has(it.key))) return;
    if (mine.length === 1) rows.push({ kind: 'item', item: mine[0] });
    else rows.push({ kind: 'group', ...g, items: mine, hint: mine.map((it) => it.short).join(', ') });
  });
  return { tiles, rows };
}

// A start asked for from OUTSIDE the menu (the installed app's shortcuts and
// Share to Nexus - lib/appLaunch.js, components/InstalledApp.jsx). It runs the
// same action the bolt runs, through the bolt (components/QuickCreate.jsx
// takes it), so there is still one menu and one way each form opens; an
// action this person cannot use is dropped without a word. `seed` is what
// that action's own form starts with (lib/shareTarget.js shareSeed): New
// Task - CreateTaskModal's `defaults`; New Ticket - CreateTicketModal's
// `initial`; New Note - { html } written into the Quick Note.
export const QUICK_ACTION_EVENT = 'nexus:quick-action';
const ASK_MAX_AGE_MS = 30000;   // asked before the bolt was on screen: it takes it when it mounts
let asked = null;

export function runQuickAction(key, seed = null) {
  asked = { key, seed, at: Date.now() };
  window.dispatchEvent(new CustomEvent(QUICK_ACTION_EVENT));
}

/** The start waiting for the bolt - handed over once: { key, seed } or null. */
export function takeQuickAction() {
  const ask = asked;
  asked = null;
  return ask && Date.now() - ask.at <= ASK_MAX_AGE_MS ? { key: ask.key, seed: ask.seed } : null;
}

// The header search answers with these same actions (11/13/2026): typing
// "time off" offers Request Time Off, "new ticket" New Ticket - from the list
// a person already has (visibleActions), never a second one, and a pick runs
// through the bolt (runQuickAction). The match is by name and deliberately
// plain: every typed word must start a word of the action's name or of its
// short name; "a", "an" and "the" never count. `starts` says the typed text
// begins the name itself and has gone past its first word ("new ti",
// "request t") - the search puts those above everything else; the rest keep
// the menu's own order.
const SMALL_WORDS = new Set(['a', 'an', 'the']);
const wordsOf = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SMALL_WORDS.has(w));

export function findActions(items, query, max = 3) {
  const typed = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const words = wordsOf(typed);
  if (typed.length < 2 || !words.length) return [];
  const hits = [];
  (items || []).forEach((it) => {
    const parts = wordsOf(`${it.label} ${it.short}`);
    if (!words.every((w) => parts.some((p) => p.startsWith(w)))) return;
    hits.push({ item: it, starts: typed.includes(' ') && it.label.toLowerCase().startsWith(typed) });
  });
  return hits.sort((a, b) => Number(b.starts) - Number(a.starts)).slice(0, max);
}
