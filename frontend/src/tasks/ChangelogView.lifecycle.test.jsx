import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

// What's New after release, Oct 18 2026: request statuses, known issues and
// rollbacks, deprecations, guided tours, attachments, Live in Production.

vi.mock('../api', () => ({
  api: {
    getTaskChangelog: vi.fn(), getTaskChangelogAutoStatus: vi.fn(), getRolesDirectory: vi.fn(),
    getPeopleDirectory: vi.fn(), markTaskChangelogSeen: vi.fn(), getTaskChangelogComments: vi.fn(),
    addTaskChangelogComment: vi.fn(), recordTaskChangelogViews: vi.fn(), getTaskChangelogMe: vi.fn(),
    getTaskChangelogAnalytics: vi.fn(), getTaskChangelogInsights: vi.fn(), getTaskChangelogFeedbackList: vi.fn(),
    bulkTaskChangelog: vi.fn(), getTaskChangelogFeedback: vi.fn(), sendTaskChangelogFeedback: vi.fn(),
    saveTaskChangelogSubscription: vi.fn(), getTaskChangelogFeedLink: vi.fn(), rotateTaskChangelogFeedLink: vi.fn(),
    createTaskChangelog: vi.fn(), getTaskChangelogAudienceOptions: vi.fn(), getTaskChangelogHints: vi.fn(),
    getTaskChangelogHistory: vi.fn(), getTaskChangelogEntryAnalytics: vi.fn(),
    getMyChangelogRequests: vi.fn(), raiseChangelogRequest: vi.fn(), setChangelogRequestStatus: vi.fn(),
    raiseChangelogIssue: vi.fn(), resolveChangelogIssue: vi.fn(), clearChangelogIssue: vi.fn(),
    getChangelogTour: vi.fn(), finishChangelogTour: vi.fn(), checkChangelogProduction: vi.fn(),
  },
}));
vi.mock('../contexts/RoleContext', () => ({
  MODULES: [{ id: 'tickets', label: 'Tickets' }, { id: 'tasks', label: 'Tasks' }],
  useRole: () => ({ myEmail: 'admin@greensglobal.com', can: (r) => r !== 'administrator', myGrantedModules: new Map([['tickets', 'editor']]) }),
}));

import { api } from '../api';
import Changelog from './ChangelogView';
import { WhatsNewHint } from './changelogExtras';
import { stageOf, daysUntil, TOUR_EVENT } from './changelogLifecycle';

const at = (h, day = 15) => new Date(2026, 9, day, h, 0).toISOString();
const isoDay = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const usDay = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const rel = (id, title, extra = {}) => ({
  id, title, description: 'Plain words.', type: 'Bug Fix', module: 'Tickets', status: 'Released',
  releasedAt: at(10), authorId: 'admin@greensglobal.com', reactions: {}, myReactions: [], commentCount: 0, ...extra,
});
const GOING = isoDay(5);

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/whats-new');
  window.localStorage.clear();
  window.sessionStorage.clear();
  api.getTaskChangelog.mockResolvedValue([
    rel('i1', 'Payroll Export', { issue: { kind: 'known', note: 'Totals double-count', workaround: 'Use the old export', at: at(9) } }),
    rel('d1', 'Old Queue Notice', { deprecation: { removeOn: GOING, what: 'The Old Queue', replacement: 'Smart Queue' } }),
    rel('m1', 'Merged Thing', { origin: 'pr', environment: 'Staging' }),
    rel('m2', 'Shipped Thing', { origin: 'pr', environment: 'Staging', prodAt: at(12) }),
    rel('t1', 'Tour Thing', { screen: 'tickets', tour: [{ title: 'Find It', body: 'Top right.', image: '', selector: '' }],
      attachments: [{ name: 'Guide.pdf', url: 'https://x.supabase.co/storage/v1/object/public/task-files/whats-new/g.pdf', size: 2048 }] }),
  ]);
  api.getTaskChangelogMe.mockResolvedValue({ sinceAt: '', subscription: { modules: [], categories: [], digest: false } });
  api.getTaskChangelogAutoStatus.mockResolvedValue({ enabled: true });
  api.getRolesDirectory.mockResolvedValue([]);
  api.getPeopleDirectory.mockResolvedValue([]);
  api.markTaskChangelogSeen.mockResolvedValue({});
  api.recordTaskChangelogViews.mockResolvedValue({});
  api.getTaskChangelogComments.mockResolvedValue([]);
  api.getTaskChangelogAnalytics.mockResolvedValue({ totals: {}, entries: {} });
  api.getTaskChangelogInsights.mockResolvedValue({ entries: {}, trends: [], topReacted: [], helpful: {} });
  api.getTaskChangelogFeedbackList.mockResolvedValue([
    { id: 'r1', entryId: 'i1', entryTitle: 'Payroll Export', email: 'amy@greensglobal.com', kind: 'request', note: 'Export to Excel', at: at(9), status: 'New' },
  ]);
  api.getTaskChangelogFeedback.mockResolvedValue({ yes: 0, no: 0, mine: null });
  api.getTaskChangelogAudienceOptions.mockResolvedValue({ companies: [] });
  api.getTaskChangelogEntryAnalytics.mockResolvedValue({ viewers: [], reactions: [] });
  api.getTaskChangelogHistory.mockResolvedValue([]);
});

describe('Latest tab', () => {
  it('leads with open issues and coming removals, and says where each update is live', async () => {
    render(<Changelog />);
    const strip = await waitFor(() => {
      const el = document.querySelector('[data-whats-new-attention]');
      if (!el) throw new Error('no strip yet');
      return el;
    });
    expect(within(strip).getByText('Payroll Export')).toBeTruthy();
    expect(within(strip).getByText(/Use the old export/)).toBeTruthy();
    expect(within(strip).getByText('The Old Queue')).toBeTruthy();
    expect(within(strip).getByText(/Goes away in 5 days - use Smart Queue instead/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Totals double-count');          // the card's banner
    expect(screen.getAllByText(`Going Away ${usDay(GOING)}`).length).toBeGreaterThan(0);
    expect(screen.getByText('Dev Only')).toBeTruthy();
    expect(screen.getAllByText('In Production').length).toBeGreaterThan(0);
  });
});

describe('Known issues', () => {
  it('an admin reports one from the details, and the update shows it', async () => {
    api.raiseChangelogIssue.mockImplementation(async (id, body) => ({ ...rel('m2', 'Shipped Thing', { origin: 'pr', prodAt: at(12) }),
      issue: { kind: body.kind, note: body.note, workaround: body.workaround, at: at(13) } }));
    window.history.replaceState(null, '', '/whats-new?entry=m2');
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: /Report Issue/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Rolled Back/ }));
    fireEvent.change(within(dialog).getByLabelText('What is wrong'), { target: { value: 'Wrong totals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report Issue' }));
    await waitFor(() => expect(api.raiseChangelogIssue).toHaveBeenCalledWith('m2', { kind: 'rolledBack', note: 'Wrong totals', workaround: '' }));
    expect((await screen.findAllByText('Rolled Back')).length).toBeGreaterThan(0);
  });
});

describe('Feature requests', () => {
  it('Feature Request shows each status and sends a new one', async () => {
    api.getMyChangelogRequests.mockResolvedValue([
      { id: 'r1', note: 'Export to Excel', status: 'Shipped', entryTitle: 'Payroll Export', shippedEntryId: 'm2', shippedTitle: 'Shipped Thing', shippedReleased: true, at: at(9) },
      { id: 'r2', note: 'Dark mode', status: 'Planned', statusNote: 'Next month', module: 'Reports', at: at(8) },
    ]);
    api.raiseChangelogRequest.mockResolvedValue({ id: 'r3' });
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: /Feature Request/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Export to Excel')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Shipped In: Shipped Thing/ })).toBeTruthy();
    expect(within(dialog).getByText('Planned')).toBeTruthy();
    expect(within(dialog).getByText(/Next month/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('What would you like?'), { target: { value: 'Bulk edit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send Request' }));
    await waitFor(() => expect(api.raiseChangelogRequest).toHaveBeenCalledWith({ note: 'Bulk edit', module: '' }));
  });

  it('Manage marks a request shipped in an update', async () => {
    api.setChangelogRequestStatus.mockImplementation(async (id, body) => ({ id, ...body, shippedReleased: true, entryTitle: 'Payroll Export' }));
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await screen.findByText('Export to Excel');
    fireEvent.change(screen.getByLabelText('Request status'), { target: { value: 'Shipped' } });
    fireEvent.change(screen.getByLabelText('Shipped in'), { target: { value: 'm2' } });
    fireEvent.change(screen.getByLabelText('Note for the requester'), { target: { value: 'Done!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setChangelogRequestStatus).toHaveBeenCalledWith('r1', { status: 'Shipped', note: 'Done!', shippedEntryId: 'm2' }));
  });
});

describe('Attachments and tours', () => {
  it('details list attachments and offer the tour', async () => {
    window.history.replaceState(null, '', '/whats-new?entry=t1');
    render(<Changelog />);
    expect((await screen.findAllByRole('button', { name: /Take the Tour/ })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Media (1)' }));
    const link = await screen.findByRole('link', { name: /Guide\.pdf/ });
    // (Through /files/view?...&download=1 where storage is configured; tests have none.)
    expect(link.getAttribute('href')).toContain('whats-new/g.pdf');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('a tour runs its steps and is marked finished', async () => {
    api.getChangelogTour.mockResolvedValue({ id: 't1', title: 'Tour Thing', screen: '', steps: [
      { title: 'Step One', body: 'First.', image: '', selector: '' }, { title: 'Step Two', body: 'Second.', image: '', selector: '' }] });
    api.getTaskChangelogHints.mockResolvedValue([]);
    api.finishChangelogTour.mockResolvedValue({ ok: true });
    render(<WhatsNewHint view="whats-new" />);
    act(() => { window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: { id: 't1' } })); });
    expect(await screen.findByText('Step One')).toBeTruthy();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText('Step Two')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    await waitFor(() => expect(api.finishChangelogTour).toHaveBeenCalledWith('t1'));
  });

  it('the form saves a tour with the update', async () => {
    api.createTaskChangelog.mockImplementation(async ({ payload }) => ({ id: 'n1', ...payload }));
    render(<Changelog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add New Update' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText(/Fixed leave balance/), { target: { value: 'New Filter' } });
    fireEvent.change(within(dialog).getByPlaceholderText(/What changed, and why/), { target: { value: 'Filter by site.' } });
    fireEvent.change(within(dialog).getByPlaceholderText(/HR, Dashboard, Tasks/), { target: { value: 'Tickets' } });
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. v2.8.1'), { target: { value: 'v1.0.1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Step' }));
    fireEvent.change(within(dialog).getByLabelText('Step 1 title'), { target: { value: 'Open Filters' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish Update' }));
    await waitFor(() => expect(api.createTaskChangelog).toHaveBeenCalled());
    const { payload } = api.createTaskChangelog.mock.calls[0][0];
    expect(payload.tour).toEqual([{ title: 'Open Filters', body: '', image: '', selector: '' }]);
    expect(payload.deprecation).toBeUndefined();
  });
});

describe('Screen hint', () => {
  it('an open issue leads, with its workaround', async () => {
    api.getTaskChangelogHints.mockResolvedValue([
      { id: 'i1', kind: 'issue', issueKind: 'known', title: 'Payroll Export', note: 'Totals double-count', workaround: 'Use the old export', stamp: at(9) },
      { id: 'n1', kind: 'new', title: 'Something New', releasedAt: at(9) },
    ]);
    render(<WhatsNewHint view="tickets" />);
    expect(await screen.findByText('Known Issue on This Screen', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/Use the old export/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Payroll Export')).toBeNull();
  });

  it('a coming removal counts down', async () => {
    api.getTaskChangelogHints.mockResolvedValue([
      { id: 'd1', kind: 'deprecation', title: 'Old Queue Notice', what: 'The Old Queue', replacement: 'Smart Queue', removeOn: GOING, daysLeft: 5, stamp: GOING },
    ]);
    render(<WhatsNewHint view="tickets" />);
    expect(await screen.findByText(`Going Away ${usDay(GOING)}`, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/Goes away in 5 days\. Use Smart Queue instead\./)).toBeTruthy();
  });
});

describe('Helpers', () => {
  it('stage: Dev Only until production, then In Production', () => {
    expect(stageOf({ origin: 'pr', environment: 'Staging' }).label).toBe('Dev Only');
    expect(stageOf({ origin: 'pr', environment: 'Staging', prodAt: at(1) }).label).toBe('In Production');
    expect(stageOf({ environment: 'Production' }).label).toBe('In Production');
    expect(stageOf({ environment: 'Staging' }).label).toBe('Staging');
    expect(stageOf({})).toBeNull();
  });

  it('daysUntil counts local days', () => {
    expect(daysUntil(isoDay(0))).toBe(0);
    expect(daysUntil(isoDay(3))).toBe(3);
    expect(daysUntil(isoDay(-2))).toBe(-2);
    expect(daysUntil('')).toBeNull();
  });
});
