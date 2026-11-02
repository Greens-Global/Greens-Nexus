import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// The phone card (approvals/ApprovalCard.jsx): two big decisions from the
// row's inline actions, a third one behind "More", Review and Open when
// nothing runs in place. Which actions exist comes from the row; what they
// call is lib/approvalActions.js - the card only lays them out.

vi.mock('../api', () => ({ api: { getPeopleDirectory: () => Promise.resolve([]) } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@greensglobal.com' }),
}));

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
    fireEvent.click(screen.getByRole('button', { name: 'More: Reimbursement - $20' }));
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
