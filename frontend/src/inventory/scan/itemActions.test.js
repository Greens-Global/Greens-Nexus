import { describe, it, expect } from 'vitest';
import { itemActionsFor } from './itemActions';

// Items phase 4: a scanned item opens with what this person can do with it.

const ME = 'erin@greensglobal.com';
const keys = (r) => r.actions.map((a) => a.key);
const item = (over = {}) => ({ id: 'it-1', name: 'Hammer Drill', ownershipType: 'transient', status: 'available', ...over });
const co = (status, over = {}) => ({ id: 'co-1', itemId: 'it-1', status, requestedBy: 'Amy Lee', requestedByEmail: 'amy@greensglobal.com', days: 3, allocatedAt: '2026-11-01T15:00:00Z', ...over });

describe('the scanned item\'s actions', () => {
  it('an available loaner can be borrowed', () => {
    const r = itemActionsFor({ item: item(), userEmail: ME });
    expect(r.state).toBe('Available to borrow');
    expect(keys(r)).toEqual(['borrow']);
  });

  it('my item in hand: Start Return', () => {
    const r = itemActionsFor({ item: item({ status: 'checked_out' }), checkouts: [co('allocated', { requestedByEmail: ME })], userEmail: ME });
    expect(keys(r)).toEqual(['return']);
    expect(r.state).toMatch(/^With you - (due back|overdue since) \d{2}\/\d{2}\/\d{4}$/);
  });

  it('handed to me, not yet confirmed: Confirm Receipt', () => {
    const r = itemActionsFor({ item: item(), checkouts: [co('pending_receipt', { requestedByEmail: ME })], userEmail: ME });
    expect(keys(r)).toEqual(['confirm-receipt']);
  });

  it('the allocator, or a manager, hands an approved checkout over - never the requester', () => {
    const approved = co('approved', { assignedAllocatorEmail: ME });
    expect(keys(itemActionsFor({ item: item(), checkouts: [approved], userEmail: ME }))).toEqual(['hand-over']);
    expect(keys(itemActionsFor({ item: item(), checkouts: [co('approved')], userEmail: 'mia@greensglobal.com', isManager: true })))
      .toEqual(['hand-over', 'details', 'print-tag']);
    expect(keys(itemActionsFor({ item: item(), checkouts: [co('approved', { requestedByEmail: ME, assignedAllocatorEmail: ME })], userEmail: ME }))).toEqual([]);
  });

  it('someone else\'s item in use offers nothing to an employee', () => {
    const r = itemActionsFor({ item: item({ status: 'checked_out' }), checkouts: [co('allocated')], userEmail: ME });
    expect(keys(r)).toEqual([]);
    expect(r.state).toMatch(/^With Amy Lee - due back/);
  });

  it('a pending request: a manager reviews it', () => {
    expect(keys(itemActionsFor({ item: item(), checkouts: [co('pending')], userEmail: 'mia@greensglobal.com', isManager: true })))
      .toEqual(['review-request', 'details', 'print-tag']);
  });

  it('a permanent assignment: accept it, or start its return', () => {
    const asg = (status) => ({ id: 'as-1', itemId: 'it-1', status, assigneeEmail: ME, assigneeName: 'Erin' });
    const perm = item({ ownershipType: 'permanent', status: 'permanently_assigned' });
    expect(keys(itemActionsFor({ item: perm, assignments: [asg('pending_acceptance')], userEmail: ME }))).toEqual(['accept-assignment']);
    expect(keys(itemActionsFor({ item: perm, assignments: [asg('active')], userEmail: ME }))).toEqual(['return-assignment']);
    expect(itemActionsFor({ item: perm, assignments: [asg('active')], userEmail: ME }).state).toBe('Assigned to you');
  });

  it('a lost or retired item is never offered to borrow', () => {
    expect(keys(itemActionsFor({ item: item({ opStatus: 'lost' }), userEmail: ME }))).toEqual([]);
    expect(itemActionsFor({ item: item({ opStatus: 'lost' }), userEmail: ME }).state).toBe('Reported lost');
    expect(keys(itemActionsFor({ item: item({ hasActiveRequest: true }), userEmail: ME }))).toEqual([]);
  });

  it('no item, no actions', () => {
    expect(itemActionsFor({ item: null })).toEqual({ state: '', actions: [], checkout: null, assignment: null });
  });
});
