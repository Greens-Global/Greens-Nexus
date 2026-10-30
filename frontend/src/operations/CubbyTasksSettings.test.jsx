import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Operations > Cubby Tasks (Neil, Oct 30 2026): both switches start
// off, each facility picks a project that saves on change, the last run is
// summarized, and only people the server says may edit can change anything.

const api = { getCubbyTaskSettings: vi.fn(), saveCubbyTaskSettings: vi.fn(), runCubbyTaskSync: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));

const { default: CubbyTasksSettings } = await import('./CubbyTasksSettings');

const BASE = {
  on: false, closeInCubby: false, projects: {}, updatedBy: '', updatedAt: '',
  facilities: [{ id: 'fac_a', name: 'Greens Storage Temecula', internalName: '01 - GS Temecula' },
    { id: 'fac_b', name: 'Greens Storage Valley Center', internalName: '02 - GS Valley' }],
  projectOptions: [{ id: 'p1', name: 'GS Temecula Operations', ownerEmail: 'v@x.com' }, { id: 'p2', name: 'GS Valley Operations', ownerEmail: '' }],
  warehouseConfigured: true, writeConfigured: false, writeKeyEnv: 'CUBBY_MANAGER_API_KEY',
  linked: 0, linkedOpen: 0, pending: 0, pendingErrors: [], stuck: 0, lastRun: {}, canEdit: true,
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
});

describe('Cubby Tasks settings', () => {
  it('starts off, lists the facilities with a project picker each, and has no run yet', async () => {
    api.getCubbyTaskSettings.mockResolvedValue(BASE);
    render(<CubbyTasksSettings />);
    const on = await screen.findByRole('switch', { name: 'Bring Cubby Tasks Into Nexus' });
    expect(on.checked).toBe(false);
    expect(screen.getByRole('switch', { name: 'Close Tasks in Cubby' }).checked).toBe(false);
    expect(screen.getByRole('combobox', { name: 'Project for 01 - GS Temecula' }).value).toBe('');
    expect(screen.getByRole('combobox', { name: 'Project for 02 - GS Valley' })).toBeTruthy();
    expect(screen.getByText(/No run yet/)).toBeTruthy();
  });

  it('a facility project saves on change and the switch turns on with a toast', async () => {
    api.getCubbyTaskSettings.mockResolvedValue(BASE);
    api.saveCubbyTaskSettings.mockImplementation(async (patch) => ({ ...BASE, ...patch }));
    const ok = vi.fn();
    render(<CubbyTasksSettings toastOk={ok} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project for 01 - GS Temecula' }), { target: { value: 'p1' } });
    await waitFor(() => expect(api.saveCubbyTaskSettings).toHaveBeenCalledWith({ projects: { fac_a: 'p1' } }));
    expect(ok).toHaveBeenCalledWith('01 - GS Temecula tasks go to GS Temecula Operations');
    fireEvent.click(screen.getByRole('switch', { name: 'Bring Cubby Tasks Into Nexus' }));
    await waitFor(() => expect(api.saveCubbyTaskSettings).toHaveBeenCalledWith({ on: true }));
    expect(ok).toHaveBeenCalledWith('Cubby Tasks is on');
  });

  it('closing in Cubby asks first and warns when the Manager key is missing', async () => {
    api.getCubbyTaskSettings.mockResolvedValue({ ...BASE, on: true });
    api.saveCubbyTaskSettings.mockResolvedValue({ ...BASE, on: true, closeInCubby: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CubbyTasksSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Close Tasks in Cubby' }));
    await waitFor(() => expect(api.saveCubbyTaskSettings).toHaveBeenCalledWith({ closeInCubby: true }));
    expect(await screen.findByText(/no Cubby key with the Manager role/)).toBeTruthy();
  });

  it('summarizes the last run, what was skipped, and the queue', async () => {
    api.getCubbyTaskSettings.mockResolvedValue({
      ...BASE, on: true, projects: { fac_a: 'p1' }, linked: 12, linkedOpen: 9, pending: 2,
      pendingErrors: [{ title: 'B306 mislocked', error: 'Cubby returned 500', attempts: 3 }],
      lastRun: { at: '2026-10-31T01:00:00Z', status: 'partial', open: 52, created: 5, updated: 1, reassigned: 0,
        completedFromCubby: 2, reopenedFromCubby: 0, unmapped: { fac_b: 7 }, unmatchedPeople: { 'Vicki Hale': 2 },
        errors: ['Move-out (Greens Storage Valley Center): boom'], warehouse: 'ok', noCreator: [] },
    });
    render(<CubbyTasksSettings />);
    const run = await screen.findByTestId('cubby-tasks-run');
    expect(run.textContent).toContain('finished with errors');
    expect(run.textContent).toContain('52 open in Cubby');
    expect(run.textContent).toContain('5 new in Nexus');
    expect(run.textContent).toContain('Skipped, no project picked: 02 - GS Valley (7)');
    expect(run.textContent).toContain('Vicki Hale (2)');
    expect(run.textContent).toContain('12 Cubby tasks linked, 9 open.');
    expect(run.textContent).toContain('2 changes waiting to go to Cubby (Close Tasks in Cubby is off)');
    expect(screen.getByTestId('cubby-tasks-push-errors').textContent).toContain('B306 mislocked: Cubby returned 500 (tried 3×)');
  });

  it('Sync Now runs the sync and reports what it did', async () => {
    api.getCubbyTaskSettings.mockResolvedValue({ ...BASE, on: true });
    api.runCubbyTaskSync.mockResolvedValue({ ...BASE, on: true, run: { status: 'ok', created: 3, updated: 0, completedFromCubby: 1 } });
    const ok = vi.fn();
    render(<CubbyTasksSettings toastOk={ok} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sync Now/ }));
    await waitFor(() => expect(ok).toHaveBeenCalledWith('Synced: 3 new, 0 updated, 1 completed from Cubby'));
  });

  it('a viewer sees everything disabled', async () => {
    api.getCubbyTaskSettings.mockResolvedValue({ ...BASE, canEdit: false });
    render(<CubbyTasksSettings />);
    expect((await screen.findByRole('switch', { name: 'Bring Cubby Tasks Into Nexus' })).disabled).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Project for 01 - GS Temecula' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Sync Now/ })).toBeNull();
    expect(screen.getByText(/Only a Global Admin/)).toBeTruthy();
  });
});
