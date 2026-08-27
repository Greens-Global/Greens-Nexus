import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Site Activity - the tab the daily logs and weekly report moved onto.
//
// Same guard and same reason as construction.test.jsx: this module's users are
// field crew on phones with no way to report a white screen, and a crash at
// render passes both build and lint. The states covered are the ones that
// actually break: loading, loaded, empty, and no projects at all.

vi.mock('../api', () => ({ api: {
  getConstructionOverview: vi.fn(),
  getConstructionLogs: vi.fn(),
  getConstructionReviewQueue: vi.fn(),
  getConstructionReports: vi.fn(),
  getConstructionMedia: vi.fn(),
  startConstructionLog: vi.fn(),
  getNotifications: vi.fn(),
  markNotifRead: vi.fn(),
} }));

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const { api } = await import('../api');
const { default: SiteActivity } = await import('./SiteActivity');

const project = {
  id: 'p1', name: 'Valley Center Phase 2', address: '100 Site Rd', phase: 'Foundation',
  percentComplete: 42, status: 'active',
};
const project2 = { ...project, id: 'p2', name: 'Harbor View' };
const log = {
  id: 'l1', projectId: 'p1', logDate: '2026-08-05', status: 'submitted',
  authorEmail: 'sagar.shoundik@greensglobal.com', crewSize: 6, hoursWorked: 8,
  notes: 'Formwork on grid C', aiSummary: '', geofenceOk: true, aiProcessedAt: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getConstructionOverview.mockResolvedValue({ projects: [project] });
  api.getConstructionLogs.mockResolvedValue([log]);
  api.getConstructionReviewQueue.mockResolvedValue([]);
  api.getConstructionReports.mockResolvedValue([]);
  api.getNotifications.mockResolvedValue([]);
});

describe('SiteActivity', () => {
  it('renders the daily logs for the first jobsite without being asked', async () => {
    // Landing on a site beats landing on a "pick one" prompt - a worker opening
    // this tab wants today's log, not a menu.
    render(<SiteActivity />);
    expect(await screen.findByText('2026-08-05')).toBeTruthy();
    expect(screen.getByText(/Formwork on grid C/)).toBeTruthy();
    expect(api.getConstructionLogs).toHaveBeenCalledWith('p1');
  });

  it('shows a loading state that is not mistakable for empty', () => {
    api.getConstructionOverview.mockReturnValue(new Promise(() => {}));
    const { container } = render(<SiteActivity />);
    expect(container.querySelector('h2').textContent).toBe('Site Activity');
    expect(screen.queryByText('No daily logs yet')).toBeNull();
  });

  it('says so when the jobsite has no logs yet', async () => {
    api.getConstructionLogs.mockResolvedValue([]);
    render(<SiteActivity />);
    expect(await screen.findByText('No daily logs yet')).toBeTruthy();
  });

  it('points at the dashboard when there are no projects at all', async () => {
    api.getConstructionOverview.mockResolvedValue({ projects: [] });
    render(<SiteActivity />);
    expect(await screen.findByText('No construction projects yet')).toBeTruthy();
    // Nothing to file against, so no misleading action button.
    expect(screen.queryByText("Start Today's Log")).toBeNull();
  });

  it('offers a jobsite picker only when there is more than one', async () => {
    render(<SiteActivity />);
    await screen.findByText('2026-08-05');
    expect(screen.queryByLabelText('Jobsite')).toBeNull();

    api.getConstructionOverview.mockResolvedValue({ projects: [project, project2] });
    render(<SiteActivity />);
    await waitFor(() => expect(screen.getByLabelText('Jobsite')).toBeTruthy());
  });

  // The picker is a searchable dropdown, not a native select: open it, type
  // enough to narrow forty jobsites to one, pick that one.
  it('switching jobsite reloads that site logs', async () => {
    api.getConstructionOverview.mockResolvedValue({ projects: [project, project2] });
    render(<SiteActivity />);
    await waitFor(() => expect(screen.getByLabelText('Jobsite')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Jobsite'));
    fireEvent.change(screen.getByPlaceholderText('Search jobsites…'), { target: { value: 'harbor' } });
    fireEvent.click(screen.getByText('Harbor View'));
    await waitFor(() => expect(api.getConstructionLogs).toHaveBeenCalledWith('p2'));
  });

  it('the jobsite picker filters instead of making you scroll', async () => {
    api.getConstructionOverview.mockResolvedValue({ projects: [project, project2] });
    render(<SiteActivity />);
    await waitFor(() => expect(screen.getByLabelText('Jobsite')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Jobsite'));
    // Open: the trigger names the current site and the menu lists both.
    expect(screen.getAllByText('Valley Center Phase 2')).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText('Search jobsites…'), { target: { value: 'harbor' } });
    expect(screen.getByText('Harbor View')).toBeTruthy();
    // Filtered: only the trigger's own label is left.
    expect(screen.getAllByText('Valley Center Phase 2')).toHaveLength(1);
  });

  it('survives the logs failing without losing the screen', async () => {
    api.getConstructionLogs.mockRejectedValue(new Error('503'));
    render(<SiteActivity />);
    expect(await screen.findByText(/503/)).toBeTruthy();
    expect(screen.getByText('Site Activity')).toBeTruthy();
  });

  it('surfaces a failure to start a log instead of doing nothing', async () => {
    api.startConstructionLog.mockRejectedValue(new Error('Add at least one photo'));
    render(<SiteActivity />);
    fireEvent.click(await screen.findByText("Start Today's Log"));
    expect(await screen.findByText(/Add at least one photo/)).toBeTruthy();
  });
});
