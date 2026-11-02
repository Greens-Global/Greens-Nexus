import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

// The phone card (approvals/ApprovalCard.jsx): two big decisions from the
// row's inline actions, a third one behind "More", Review and Open when
// nothing runs in place. Which actions exist comes from the row; what they
// call is lib/approvalActions.js - the card only lays them out.

vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@greensglobal.com' }),
}));

// jsdom has no PointerEvent: without one fireEvent builds a plain Event and
// clientX / pointerType never reach the swipe handlers.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType || 'mouse'; }
  };
}

const { default: ApprovalCard } = await import('./ApprovalCard');
const { needsNote } = await import('./shared');

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
const A = (key, label, tone = 'plain', note = 'none') => ({ key, label, tone, note });
const base = { key: 'k', id: 'x', person: { email: 'p@x.com', name: 'Priya Sharma' }, title: 'Reimbursement - $20', detail: 'Cab', createdAt: iso(5), priority: 'medium', link: { view: 'myhr', sub: 'reimbursements' } };

describe('ApprovalCard', () => {
  it('puts Approve and Reject side by side, Send Back behind More', () => {
    const onAct = vi.fn(); const onReview = vi.fn();
    const row = { ...base, kind: 'reimbursement', actions: [A('approve', 'Approve', 'primary'), A('send_back', 'Send Back', 'plain', 'required'), A('reject', 'Reject', 'plain', 'required')] };
    render(<ApprovalCard row={row} onAct={onAct} onReview={onReview} />);
    const yes = screen.getByRole('button', { name: 'Approve: Reimbursement - $20 (Priya Sharma)' });
    const no = screen.getByRole('button', { name: 'Reject: Reimbursement - $20 (Priya Sharma)' });
    expect(yes.className).toContain('apv-ph-yes');
    expect(no.className).toContain('apv-ph-no');
    expect(screen.queryByRole('button', { name: /Send Back/ })).toBeNull();
    fireEvent.click(yes);
    expect(onAct).toHaveBeenCalledWith(row, row.actions[0]);
    fireEvent.click(screen.getByRole('button', { name: 'More: Reimbursement - $20 (Priya Sharma)' }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('Cab')).toBeTruthy();
    expect(screen.getByText('5h')).toBeTruthy();
  });

  it('shows Review and Open when nothing runs in place, and Review beside a lone no', () => {
    const onAct = vi.fn();
    const open = { ...base, kind: 'timesheet_review', actions: [A('open', 'Review')] };
    const { unmount } = render(<ApprovalCard row={open} onAct={onAct} onReview={() => {}} />);
    expect(screen.getByRole('button', { name: /^Review:/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Open:/ }));
    expect(onAct).toHaveBeenCalledWith(open, open.actions[0]);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
    unmount();
    const letter = { ...base, kind: 'hr_letter', actions: [A('open', 'Review'), A('decline', 'Decline', 'plain', 'required')] };
    render(<ApprovalCard row={letter} onAct={onAct} onReview={() => {}} />);
    expect(screen.getByRole('button', { name: /^Review:/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Decline:/ }).className).toContain('apv-ph-no');
    expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
  });

  it('colors the wait at three and seven days and marks the urgent card', () => {
    const slow = { ...base, kind: 'time_off', createdAt: iso(26 * 3), actions: [A('approve', 'Approve', 'primary')] };
    const { container, rerender } = render(<ApprovalCard row={slow} onAct={() => {}} onReview={() => {}} />);
    expect(container.querySelector('.apv-ph-age').className).toContain('is-slow');
    expect(container.querySelector('.apv-ph-age').textContent).toBe('3d');
    rerender(<ApprovalCard row={{ ...slow, createdAt: iso(24 * 8), priority: 'urgent' }} onAct={() => {}} onReview={() => {}} />);
    expect(container.querySelector('.apv-ph-age').className).toContain('is-late');
    expect(container.querySelector('.apv-ph-card').getAttribute('data-priority')).toBe('urgent');
    expect(within(container).getByText('Urgent')).toBeTruthy();
    // A lone yes keeps More for the rest of the request.
    expect(screen.getByRole('button', { name: /^More:/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Review:/ })).toBeNull();
  });

  describe('swipe', () => {
    const swipeRow = { ...base, kind: 'reimbursement', actions: [A('approve', 'Approve', 'primary'), A('reject', 'Reject', 'plain', 'required')] };
    const setup = () => {
      const onAct = vi.fn();
      const { container } = render(<ApprovalCard row={swipeRow} swipe onAct={onAct} onReview={() => {}} />);
      const card = container.querySelector('.apv-ph-card');
      Object.defineProperty(card, 'offsetWidth', { value: 300, configurable: true });
      return { onAct, card };
    };
    const touch = (x, y = 100) => ({ pointerType: 'touch', pointerId: 1, clientX: x, clientY: y });

    it('marks only a card that can swipe, so only it claims the horizontal drag', () => {
      const { card } = setup();
      expect(card.hasAttribute('data-swipe')).toBe(true);
      const { container } = render(<ApprovalCard row={swipeRow} onAct={() => {}} onReview={() => {}} />);
      expect(container.querySelector('.apv-ph-card').hasAttribute('data-swipe')).toBe(false);
    });

    it('a cancelled pointer springs back and never decides', () => {
      const { onAct, card } = setup();
      fireEvent.pointerDown(card, touch(10));
      fireEvent.pointerMove(card, touch(250));                   // well past 40% of 300px
      expect(card.style.transform).toBe('translateX(240px)');
      fireEvent.pointerCancel(card, touch(250));
      expect(onAct).not.toHaveBeenCalled();
      expect(card.style.transform).toBe('translateX(0px)');
      fireEvent.pointerUp(card, touch(250));                     // a stray up after the cancel does nothing either
      expect(onAct).not.toHaveBeenCalled();
    });

    it('decides from the drag itself, even when the move and the release land in one render', () => {
      const { onAct, card } = setup();
      fireEvent.pointerDown(card, touch(10));
      act(() => {
        fireEvent.pointerMove(card, touch(30));                  // past the 12px start
        fireEvent.pointerMove(card, touch(200));
        fireEvent.pointerUp(card, touch(200));
      });
      expect(onAct).toHaveBeenCalledWith(swipeRow, swipeRow.actions[0], { fromX: 190 });
    });

    it('under 40% springs back without a decision; a left swipe is the no', () => {
      const { onAct, card } = setup();
      fireEvent.pointerDown(card, touch(200));
      fireEvent.pointerMove(card, touch(150));
      fireEvent.pointerUp(card, touch(150));
      expect(onAct).not.toHaveBeenCalled();
      fireEvent.pointerDown(card, touch(250));
      fireEvent.pointerMove(card, touch(40));
      fireEvent.pointerUp(card, touch(40));
      expect(onAct).toHaveBeenCalledWith(swipeRow, swipeRow.actions[1], { fromX: -210 });
    });
  });

  it('asks for a note only when the server marks the action required', () => {
    // approvals_inbox.py is the one source: `note` on the action itself.
    expect(needsNote(A('reject', 'Reject', 'plain', 'required'))).toBe(true);
    expect(needsNote(A('send_back', 'Send Back', 'plain', 'required'))).toBe(true);
    expect(needsNote(A('reject', 'Reject', 'plain', 'optional'))).toBe(false);
    expect(needsNote(A('decline', 'Decline', 'plain', 'optional'))).toBe(false);   // a shift request's decline
    expect(needsNote(A('approve', 'Approve', 'primary'))).toBe(false);
    expect(needsNote(undefined)).toBe(false);
  });
});
