import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Due-date accountability (Neil, Sep 24): the "Extended N times" badge and the
// confirm / propose / answer panel in the task drawer.

const confirmTaskDue = vi.fn((id) => Promise.resolve({ id, dueAgreement: 'accepted' }));
const proposeTaskDue = vi.fn((id, dueOn) => Promise.resolve({ id, dueAgreement: 'proposed', dueProposal: { dueOn } }));
vi.mock('../api', () => ({
  api: {
    confirmTaskDue: (...a) => confirmTaskDue(...a),
    proposeTaskDue: (...a) => proposeTaskDue(...a),
    respondTaskDue: () => Promise.resolve({}),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));
const applyServerTask = vi.fn();
let me = 'sagar@greensglobal.com';
vi.mock('./TasksContext', () => ({
  useTasks: () => ({
    myEmail: me, applyServerTask,
    nameOf: (e) => ({ 'sagar@greensglobal.com': 'Sagar', 'neil@greensglobal.com': 'Neil' }[e] || e),
  }),
}));

const DueBadge = (await import('./DueBadge')).default;
const DueNegotiation = (await import('./DueNegotiation')).default;

const history = [
  { at: '2026-09-01T10:00:00Z', from: '', to: '2026-09-19', by: 'neil@greensglobal.com', source: 'app', extension: false },
  { at: '2026-09-18T10:00:00Z', from: '2026-09-19', to: '2026-09-26', by: 'sagar@greensglobal.com', source: 'app', extension: true },
];

describe('DueBadge', () => {
  it('shows nothing for a task never extended', () => {
    const { container } = render(<DueBadge task={{ dueExtensionCount: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('goes yellow, orange, then red', () => {
    const color = (n) => {
      const { getByText, unmount } = render(<DueBadge count={n} />);
      const c = getByText(/Extended/).style.color;
      unmount();
      return c;
    };
    expect(color(1)).toBe('rgb(202, 138, 4)');
    expect(color(2)).toBe('rgb(234, 88, 12)');
    expect(color(3)).toBe('rgb(220, 38, 38)');
    expect(color(9)).toBe('rgb(220, 38, 38)');
  });

  it('says who extended it and when, on hover', () => {
    render(<DueBadge task={{ dueExtensionCount: 1, dueHistory: history }} nameOf={(e) => e.split('@')[0]} />);
    const badge = screen.getByText('Extended once');
    expect(badge.title).toMatch(/09\/19\/2026 → 09\/26\/2026 by sagar on 09\/18\/2026/);
  });

  it('has a compact form for dense cells', () => {
    render(<DueBadge count={3} compact />);
    expect(screen.getByText('Ext 3x')).toBeInTheDocument();
  });
});

describe('DueNegotiation', () => {
  const pending = {
    id: 't1', title: 'Finish Nexus Sign', dueOn: '2026-09-26', completed: false,
    assigneeIds: ['sagar@greensglobal.com'], assigneeId: 'sagar@greensglobal.com',
    requesterId: 'neil@greensglobal.com', dueAgreement: 'pending', dueHistory: history.slice(0, 1),
  };

  it('asks the assignee to confirm, and confirms', async () => {
    me = 'sagar@greensglobal.com';
    render(<DueNegotiation task={pending} />);
    expect(screen.getByText(/Can you make it\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Confirm Date'));
    await waitFor(() => expect(applyServerTask).toHaveBeenCalledWith({ id: 't1', dueAgreement: 'accepted' }));
    expect(confirmTaskDue).toHaveBeenCalledWith('t1');
  });

  it('tells the requester who it is waiting on', () => {
    me = 'neil@greensglobal.com';
    render(<DueNegotiation task={pending} />);
    expect(screen.getByText('Waiting for Sagar to confirm this date.')).toBeInTheDocument();
    expect(screen.queryByText('Confirm Date')).not.toBeInTheDocument();
  });

  it('lets the requester answer a proposal', () => {
    me = 'neil@greensglobal.com';
    render(<DueNegotiation task={{ ...pending, dueAgreement: 'proposed',
      dueProposal: { dueOn: '2026-10-02', by: 'sagar@greensglobal.com', note: 'Blocked on legal' } }} />);
    expect(screen.getByText('Accept 10/02/2026')).toBeInTheDocument();
    expect(screen.getByText('Keep 09/26/2026')).toBeInTheDocument();
    expect(screen.getByText('"Blocked on legal"')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Suggest New Date'));
    expect(screen.getByText('Send Suggestion')).toBeDisabled();   // until a date is picked
  });

  it('lists every move of the date', () => {
    me = 'neil@greensglobal.com';
    render(<DueNegotiation task={{ ...pending, dueAgreement: 'accepted', dueExtensionCount: 1, dueHistory: history }} />);
    fireEvent.click(screen.getByText(/Date History \(2\)/));
    expect(screen.getByText(/Set to 09\/19\/2026 by Neil/)).toBeInTheDocument();
    expect(screen.getByText('Extension')).toBeInTheDocument();
  });
});
