import { describe, it, expect } from 'vitest';
import { parseItemsSub, itemsSub, tabsFor, resolveTab } from './routes';
import { myStuffRows, myHistory, checkoutGroup } from './urgency';
import { checkoutDueInfo, dueDayOf, dueWords, addDaysISO, daysBetween, loanProgress, todayISO } from './due';
import { checkoutWord, assignmentWord, itemWord } from './words';
import { borrowableItems, borrowTypeOptions, filterBorrow } from './borrow';
import { isTypeBorrowable, loanCapFor } from './useTypeSettings';
import { itemTimeline } from './timeline';

// Items redesign (Neil, 11/02/2026) - the pure rules behind the new screens.
const NOW = new Date('2026-11-02T12:00:00');
const ME = 'erin@greensglobal.com';

describe('tab routing and deep links', () => {
  it('parses tab, view and the open item', () => {
    expect(parseItemsSub('requests:handover@abc')).toMatchObject({ tab: 'requests', view: 'handover', itemId: 'abc' });
    expect(parseItemsSub('inventory')).toMatchObject({ tab: 'inventory', view: '', itemId: '' });
    expect(parseItemsSub(null)).toMatchObject({ tab: '', itemId: '' });
    expect(parseItemsSub('requests:handover@co:ICHK-1').itemId).toBe('co:ICHK-1');
  });
  it('every old sub still lands', () => {
    const land = (s) => { const p = parseItemsSub(s); return itemsSub({ tab: p.tab, view: p.view }); };
    expect(land('myitems')).toBe('mystuff');
    expect(land('permanent')).toBe('mystuff');
    expect(land('active-checkouts')).toBe('mystuff');
    expect(land('catalog')).toBe('borrow');
    expect(land('manage')).toBe('inventory');
    expect(land('checkouts')).toBe('requests');
    expect(land('handover')).toBe('requests:handover');
    expect(land('assignment-returns')).toBe('requests:returns');
    expect(land('checkouts-completed')).toBe('requests:done');
    expect(land('whohasit')).toBe('inventory:whohas');
    expect(land('audit')).toBe('inventory:activity');
    expect(parseItemsSub('catalog').legacy).toBe(true);
  });
  it('access decides the tabs, and a tab you cannot open falls back', () => {
    expect(tabsFor({}).map(t => t.key)).toEqual(['mystuff', 'borrow']);
    expect(tabsFor({ isAllocator: true }).map(t => t.key)).toEqual(['mystuff', 'borrow', 'requests']);
    expect(tabsFor({ isManager: true }).map(t => t.key)).toEqual(['mystuff', 'borrow', 'requests', 'inventory']);
    expect(resolveTab(parseItemsSub('inventory'), {})).toBe('borrow');
    expect(resolveTab(parseItemsSub('requests'), {})).toBe('mystuff');
    expect(resolveTab(parseItemsSub('requests'), { isAllocator: true })).toBe('requests');
    expect(resolveTab(parseItemsSub(''), { isManager: true })).toBe('mystuff');
  });
});

describe('the server is the one clock', () => {
  it('reads dueDate, else the picked return date before a handover', () => {
    expect(dueDayOf({ status: 'allocated', handedOverAt: '2026-10-01T10:00:00Z', dueDate: '2026-10-04', days: 99 })).toBe('2026-10-04');
    expect(dueDayOf({ status: 'pending', requestedDueDate: '2026-11-09' })).toBe('2026-11-09');
    expect(dueDayOf({ status: 'pending' })).toBe('');
  });
  it('overdue, due today and days left, on calendar days', () => {
    const late = { status: 'allocated', dueDate: '2026-10-30', handedOverAt: '2026-10-25T10:00:00Z' };
    expect(checkoutDueInfo(late, NOW)).toMatchObject({ overdue: true, daysLeft: -3 });
    expect(dueWords(late, NOW)).toBe('3 days overdue');
    expect(dueWords({ status: 'allocated', dueDate: '2026-11-02', handedOverAt: '2026-11-01T10:00:00Z' }, NOW)).toBe('Due today');
    expect(dueWords({ status: 'allocated', dueDate: '2026-11-05', handedOverAt: '2026-11-01T10:00:00Z' }, NOW)).toBe('3 days left');
    // A request is never overdue - it is not out yet.
    expect(checkoutDueInfo({ status: 'approved', requestedDueDate: '2026-10-01' }, NOW).overdue).toBe(false);
  });
  it('date helpers and the loan track', () => {
    expect(addDaysISO('2026-02-27', 3)).toBe('2026-03-02');
    expect(daysBetween('2026-11-02', '2026-11-09')).toBe(7);
    expect(todayISO(NOW)).toBe('2026-11-02');
    const half = loanProgress({ handedOverAt: '2026-11-01T12:00:00', dueAt: '2026-11-03T12:00:00' }, NOW);
    expect(half).toBeCloseTo(0.5, 2);
    expect(loanProgress({ status: 'pending' }, NOW)).toBeNull();
  });
});

describe('one set of words', () => {
  it('checkouts and assignments', () => {
    expect(['pending', 'approved', 'pending_receipt', 'allocated', 'returned', 'cancelled'].map(s => checkoutWord({ status: s, dueDate: '2026-12-01', handedOverAt: '2026-11-01T00:00:00Z' }, NOW).label))
      .toEqual(['Requested', 'Approved', 'Handed Over', 'In Use', 'Returned', 'Canceled']);
    expect(checkoutWord({ status: 'allocated', dueDate: '2026-10-01', handedOverAt: '2026-09-25T00:00:00Z' }, NOW)).toMatchObject({ label: 'Overdue', tone: 'overdue' });
    expect(checkoutWord({ status: 'allocated', dueDate: '2026-12-01', handedOverAt: '2026-11-01T00:00:00Z' }, NOW).tone).toBe('live');
    expect(checkoutWord({ status: 'returned' }).tone).toBe('done');
    expect(['pending_acceptance', 'active', 'return_initiated', 'closed', 'cancelled'].map(s => assignmentWord({ status: s }).label))
      .toEqual(['Awaiting Acceptance', 'Active', 'Return Started', 'Closed', 'Canceled']);
  });
  it('items', () => {
    expect(itemWord({ status: 'available', ownershipType: 'transient' }).label).toBe('Available');
    expect(itemWord({ status: 'checked_out' }, { overdue: true }).label).toBe('Overdue');
    expect(itemWord({ status: 'available', opStatus: 'lost' }).label).toBe('Lost');
    expect(itemWord({ status: 'available', ownershipType: 'permanent' }).label).toBe('Unassigned');
  });
});

describe('My Stuff - most urgent first, mine by email only', () => {
  const cos = [
    { id: 'w', itemId: 'a', status: 'pending', requestedByEmail: ME, createdAt: '2026-11-01' },
    { id: 'u', itemId: 'b', status: 'allocated', requestedByEmail: ME, dueDate: '2026-11-20', handedOverAt: '2026-11-01T00:00:00Z' },
    { id: 'o', itemId: 'c', status: 'allocated', requestedByEmail: ME, dueDate: '2026-10-28', handedOverAt: '2026-10-20T00:00:00Z' },
    { id: 't', itemId: 'd', status: 'allocated', requestedByEmail: ME, dueDate: '2026-11-02', handedOverAt: '2026-10-30T00:00:00Z' },
    { id: 'r', itemId: 'e', status: 'pending_receipt', requestedByEmail: ME },
    { id: 'n', itemId: 'f', status: 'allocated', requestedBy: 'Erin Test', requestedByEmail: 'someone.else@x.com', dueDate: '2026-10-01' },
    { id: 'x', itemId: 'g', status: 'returned', requestedByEmail: ME, returnedAt: '2026-10-10' },
  ];
  const asg = [
    { id: 'p', itemId: 'h', status: 'pending_acceptance', assigneeEmail: ME, createdAt: '2026-11-01' },
    { id: 'q', itemId: 'i', status: 'active', assigneeEmail: 'ERIN@greensglobal.com' },
  ];
  it('orders Overdue, Due Today, Your Action Needed, Waiting on Others, In Use', () => {
    const rows = myStuffRows(cos, asg, ME, { now: NOW });
    expect(rows.map(r => `${r.group}:${r.row.id}`)).toEqual(['overdue:o', 'today:t', 'action:r', 'action:p', 'waiting:w', 'inuse:u', 'inuse:q']);
    expect(rows.some(r => r.row.id === 'n')).toBe(false);   // the same NAME is not me
  });
  it("a manager's own approved request is theirs to take", () => {
    const own = { id: 'm', status: 'approved', requestedByEmail: ME };
    expect(checkoutGroup(own, { now: NOW })).toBe('waiting');
    expect(checkoutGroup(own, { now: NOW, canSelfHandOver: true })).toBe('action');
    expect(checkoutGroup({ ...own, assignedAllocatorEmail: ME }, { now: NOW, me: ME })).toBe('action');
  });
  it('a reassignment asks the holder for the item back', () => {
    const rows = myStuffRows([], [{ id: 'z', status: 'return_initiated', returnReason: 'reassign', assigneeEmail: ME }], ME, { now: NOW });
    expect(rows[0].group).toBe('action');
  });
  it('history is the finished ones, newest first', () => {
    expect(myHistory(cos, asg, ME).map(h => h.row.id)).toEqual(['x']);
  });
});

describe('Borrow lists only what people can borrow', () => {
  const byName = new Map([['computer', { name: 'Computer', borrowable: false, loanCapDays: 90 }], ['tools', { name: 'Tools', borrowable: true, loanCapDays: 7 }]]);
  const items = [
    { id: '1', name: 'Drill', itemType: 'Tools', ownershipType: 'transient', status: 'available' },
    { id: '2', name: 'Laptop', itemType: 'Computer', ownershipType: 'transient', status: 'available' },
    { id: '3', name: 'Phone', itemType: 'Devices', ownershipType: 'permanent', status: 'available' },
    { id: '4', name: 'Saw', itemType: 'Tools', ownershipType: 'transient', status: 'available', opStatus: 'lost' },
    { id: '5', name: 'Axe', itemType: 'Tools', ownershipType: 'transient', status: 'checked_out' },
    { id: '6', name: 'Cone', itemType: 'Safety', ownershipType: 'transient', status: 'available' },
  ];
  it('hides non-borrowable types, permanent items and lost ones', () => {
    expect(borrowableItems(items, byName).map(i => i.id)).toEqual(['1', '5', '6']);
    expect(isTypeBorrowable(byName, 'computer')).toBe(false);
    expect(isTypeBorrowable(byName, 'Safety')).toBe(true);    // a type the server does not curate
    expect(loanCapFor(byName, 'Tools')).toBe(7);
    expect(loanCapFor(byName, 'Safety')).toBe(90);
  });
  it('the type control lists only the borrowable types that have items', () => {
    expect(borrowTypeOptions(borrowableItems(items, byName))).toEqual([{ type: 'Safety', count: 1 }, { type: 'Tools', count: 2 }]);
  });
  it('free items first, then by name; search and type narrow it', () => {
    const list = borrowableItems(items, byName);
    expect(filterBorrow(list).map(i => i.name)).toEqual(['Cone', 'Drill', 'Axe']);
    expect(filterBorrow(list, { q: 'dri' }).map(i => i.name)).toEqual(['Drill']);
    expect(filterBorrow(list, { type: 'Safety' }).map(i => i.name)).toEqual(['Cone']);
  });
});

describe('the item record timeline', () => {
  it('tells every step once, newest first, with the handover and return photos side by side', () => {
    const item = { id: 'i' };
    const tl = itemTimeline({
      item,
      checkouts: [{ id: 'c', itemId: 'i', requestedBy: 'Amy Lee', createdAt: '2026-10-28T10:00:00Z', resolvedAt: '2026-10-28T11:00:00Z', resolvedBy: 'Neil K', status: 'returned',
        handedOverAt: '2026-10-29T10:00:00Z', allocatedBy: 'Marcus Ruiz', checkoutPhotoUrl: 'h.jpg', returnedAt: '2026-11-01T10:00:00Z', returnPhotoUrl: 'r.jpg', requestedDueDate: '2026-11-05' }],
      assignments: [],
      audit: [{ id: 9, resource_id: 'i', action: 'Updated item', user_email: 'mia.boss@x.com', timestamp: '2026-10-20T10:00:00' },
        { id: 10, resource_id: 'other', action: 'Updated item', user_email: 'x@x.com', timestamp: '2026-10-21T10:00:00' }],
    });
    expect(tl.map(e => e.text)).toEqual(['Returned by Amy Lee', 'Handed over to Amy Lee by Marcus Ruiz', 'Approved by Neil K', 'Requested by Amy Lee', 'Edited by Mia Boss']);
    expect(tl[0].photos.map(p => p.label)).toEqual(['At Handover', 'At Return']);
    expect(tl[3].detail).toContain('Return by 11/05/2026');
  });
});
