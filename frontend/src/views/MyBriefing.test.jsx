import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for My Briefing (/briefing): every state paints something
// (loading, empty, error, content), sections open and close, and the action
// buttons send what the backend expects.

const getMyBriefing = vi.fn();
const actOnMyBriefing = vi.fn();
vi.mock('../api', () => ({
  api: {
    getMyBriefing: (...a) => getMyBriefing(...a),
    actOnMyBriefing: (...a) => actOnMyBriefing(...a),
  },
}));

const MyBriefing = (await import('./MyBriefing')).default;

const BRIEFING = {
  greeting: 'Good morning', firstName: 'Pranshu', date: '2026-09-26', since: '2026-09-25T09:00:00',
  reactions: ['\u{1F44D}'],
  sections: [
    { key: 'action_required', label: 'Action Required', rows: [
      { title: 'Approve: Budget', detail: 'Waiting on your decision', module: 'tasks', path: '/tasks/mine?task=t1',
        comments: [], decision: { kind: 'task_approval', id: 't1' }, taskId: 't1', taskOpen: false },
      { title: 'Access request', ref: 'TCK-1', detail: 'Waiting', module: 'tickets', path: '/tickets?ticket=k1',
        comments: [], decision: { kind: 'ticket_approval', id: 'k1' } },
    ] },
    { key: 'needs_to_know', label: 'Updates for You', rows: [
      { title: 'Fix the gate', detail: 'Changed status', module: 'tasks', path: '/tasks/mine?task=t2', taskId: 't2',
        taskOpen: true, taskStatus: 'in_progress', statusOptions: [{ value: 'in_progress', label: 'In Progress' }, { value: 'completed', label: 'Completed' }],
        comments: [{ author: 'Neil Kadakia', body: 'Any update?' }] },
    ] },
  ],
};

beforeEach(() => {
  getMyBriefing.mockReset();
  actOnMyBriefing.mockReset();
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('MyBriefing', () => {
  it('renders the greeting, tiles, sections and rows', async () => {
    getMyBriefing.mockResolvedValue(BRIEFING);
    render(<MyBriefing />);
    expect(await screen.findByText('Good morning, Pranshu.')).toBeTruthy();
    expect(screen.getByText('Need your action')).toBeTruthy();
    expect(screen.getByText('Approve: Budget')).toBeTruthy();
    expect(screen.getByText('Any update?')).toBeTruthy();
    expect(screen.getAllByText('Open in Nexus')[0].getAttribute('href')).toBe('/tasks/mine?task=t1');
  });

  it('shows a friendly empty state', async () => {
    getMyBriefing.mockResolvedValue({ ...BRIEFING, sections: [] });
    render(<MyBriefing />);
    expect(await screen.findByText('Nothing new since your last briefing.')).toBeTruthy();
  });

  it('shows a retryable error instead of a blank screen', async () => {
    getMyBriefing.mockRejectedValue(new Error('boom'));
    render(<MyBriefing />);
    expect(await screen.findByText(/couldn't be loaded/)).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('collapses and reopens a section', async () => {
    getMyBriefing.mockResolvedValue(BRIEFING);
    render(<MyBriefing />);
    await screen.findByText('Approve: Budget');
    fireEvent.click(screen.getByText('Action Required'));
    expect(screen.queryByText('Approve: Budget')).toBeNull();
    fireEvent.click(screen.getByText('Action Required'));
    expect(screen.getByText('Approve: Budget')).toBeTruthy();
  });

  it('approves in one click', async () => {
    getMyBriefing.mockResolvedValue(BRIEFING);
    actOnMyBriefing.mockResolvedValue({ ok: true, message: 'Budget approved.' });
    render(<MyBriefing />);
    await screen.findByText('Approve: Budget');
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() => expect(actOnMyBriefing).toHaveBeenCalledWith(
      { kind: 'decision', id: 't1', decision_kind: 'task_approval', action: 'approve', text: '' }));
    expect(await screen.findByText('Budget approved.')).toBeTruthy();
  });

  it('asks for a reason before rejecting a ticket', async () => {
    getMyBriefing.mockResolvedValue(BRIEFING);
    actOnMyBriefing.mockResolvedValue({ ok: true, message: 'Access request rejected.' });
    render(<MyBriefing />);
    await screen.findByText('Access request');
    fireEvent.click(screen.getAllByText('Reject')[1]);
    expect(actOnMyBriefing).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('Reason for rejecting (required)'), { target: { value: 'Not needed' } });
    fireEvent.click(screen.getByText('Confirm Reject'));
    await waitFor(() => expect(actOnMyBriefing).toHaveBeenCalledWith(
      { kind: 'decision', id: 'k1', decision_kind: 'ticket_approval', action: 'reject', text: 'Not needed' }));
  });

  it('posts a comment and changes status on a task', async () => {
    getMyBriefing.mockResolvedValue(BRIEFING);
    actOnMyBriefing.mockResolvedValue({ ok: true, message: 'Done.' });
    render(<MyBriefing />);
    await screen.findByText('Fix the gate');
    fireEvent.click(screen.getAllByText('Comment')[1]);
    fireEvent.change(screen.getByPlaceholderText('Write a comment'), { target: { value: 'On it' } });
    fireEvent.click(screen.getByText('Post Comment'));
    await waitFor(() => expect(actOnMyBriefing).toHaveBeenCalledWith({ kind: 'task', id: 't2', action: 'comment', text: 'On it' }));
    fireEvent.click(screen.getByText('Change Status'));
    fireEvent.change(screen.getByDisplayValue('In Progress'), { target: { value: 'completed' } });
    fireEvent.click(screen.getByText('Update Status'));
    await waitFor(() => expect(actOnMyBriefing).toHaveBeenCalledWith({ kind: 'task', id: 't2', action: 'status', text: 'completed' }));
  });
});
