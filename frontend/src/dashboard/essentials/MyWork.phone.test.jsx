// My Work on a phone: vitest.setup.js stubs matchMedia to "never matches", so
// this file swaps in one that answers the 640px query, and checks every tap
// target (row, Complete, View All, the header actions) is at least 44px tall.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyWork: vi.fn(), updateTask: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../QuickActionModals.jsx', () => ({ default: () => null }));
vi.mock('../../tasks/TasksContext', () => ({ TasksProvider: ({ children }) => <div>{children}</div> }));
vi.mock('../../tickets/TicketsView', () => ({ CreateTicketModal: () => null }));

import MyWork from './MyWork.jsx';

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (q) => ({
    matches: /max-width:\s*640px/.test(q), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false; },
  });
  apiMock.getMyWork.mockResolvedValue({
    overdue: [], week: [], later: [],
    today: [{ kind: 'task', id: 't1', code: 'TASK-1', title: 'Phone task', project: 'Rollout', dueOn: '2026-10-08',
              status: 'not_started', statusLabel: 'Not Started', priority: 'low', unread: false, view: 'tasks', sub: '', taskId: 't1' }],
    counts: { overdue: 0, today: 1, week: 0, later: 0, total: 1 }, localDate: '2026-10-08',
  });
});
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; apiMock.getMyWork.mockReset(); });

const px = (el, prop) => parseFloat(el.style[prop] || '0');

describe('My Work on a phone', () => {
  it('gives every tap target a 44px hit area', async () => {
    render(<MyWork />);
    const row = await screen.findByLabelText('Open Phone task');
    expect(px(row, 'minHeight')).toBeGreaterThanOrEqual(44);
    const done = screen.getByLabelText('Complete Phone task');
    expect(px(done, 'height')).toBeGreaterThanOrEqual(44);
    expect(px(done, 'width')).toBeGreaterThanOrEqual(44);
    expect(px(screen.getByText(/View All/), 'minHeight')).toBeGreaterThanOrEqual(44);
    expect(px(screen.getByText('New Task'), 'minHeight')).toBeGreaterThanOrEqual(44);
    expect(px(screen.getByText('Submit a Ticket'), 'minHeight')).toBeGreaterThanOrEqual(44);
  });
});
