// My Day on a phone (Essentials, Oct 7): one-line title and meta, 44px
// action targets, and nothing that assumes a wide card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getMyBriefing: vi.fn(), actOnMyBriefing: vi.fn() }));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import MyDay from './MyDay.jsx';

function setViewport(isMobile) {
  window.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

const rows = [
  { title: 'Approve: A very long approval title that would wrap onto two lines on a narrow screen', detail: 'Waiting on your decision', module: 'tasks', path: '/tasks/mine?task=t1', taskId: 't1', decision: { kind: 'task_approval', id: 't1' } },
  { title: 'Submit your time card', detail: 'Pay period ending 10/04/2026 is closed - sign off is still open', module: 'timecard', path: '/timeclock' },
  { title: 'Send the Q3 report', detail: 'Due today', module: 'tasks', path: '/tasks/mine?task=t2', taskId: 't2', taskOpen: true },
];
const briefing = (r) => ({ sections: [{ key: 'action_required', label: 'Action Required', rows: r }] });

beforeEach(() => {
  setViewport(true);
  apiMock.actOnMyBriefing.mockResolvedValue({ ok: true });
});
afterEach(() => { setViewport(false); vi.clearAllMocks(); });

describe('My Day on a phone', () => {
  it('gives every action a 44px target', async () => {
    apiMock.getMyBriefing.mockResolvedValue(briefing(rows));
    render(<MyDay />);
    await screen.findByText('3 things need you');
    for (const name of ['Approve', 'Reject', 'Open', 'Complete']) {
      const b = screen.getByRole('button', { name });
      expect(b.style.minHeight).toBe('44px');
      expect(b.style.minWidth).toBe('44px');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    for (const name of ['Confirm Reject', 'Cancel']) expect(screen.getByRole('button', { name }).style.minHeight).toBe('44px');
  });

  it('keeps the title to one line and leaves the status word off so the title has the width', async () => {
    apiMock.getMyBriefing.mockResolvedValue(briefing(rows));
    render(<MyDay />);
    await screen.findByText('3 things need you');
    const title = screen.getByText(/A very long approval title/);
    expect(title.style.whiteSpace).toBe('nowrap');
    expect(title.style.textOverflow).toBe('ellipsis');
    expect(title.style.overflow).toBe('hidden');
    // The row's text column may shrink, so the ellipsis can apply.
    expect(title.parentElement.style.minWidth).toMatch(/^0(px)?$/);
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(screen.queryByText('Due Today')).toBeNull();
  });

  it('shows the status word again on a desktop', async () => {
    setViewport(false);
    apiMock.getMyBriefing.mockResolvedValue(briefing(rows));
    render(<MyDay />);
    await screen.findByText('3 things need you');
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' }).style.minHeight).toBe('');
  });

  it('View All on a phone is also a 44px target', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `Sign: Document ${i + 1}`, detail: 'Signature required', module: 'documents', path: '/documents/documents-esign' }));
    apiMock.getMyBriefing.mockResolvedValue(briefing(many));
    render(<MyDay />);
    await screen.findByText('8 things need you');
    expect(screen.getByRole('button', { name: /View All \(8\)/ }).style.minHeight).toBe('44px');
  });
});
