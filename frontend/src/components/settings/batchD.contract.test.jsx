import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { renderInGroup, typedFields, editField, saveRows } from './settingsContract.testkit';

// The Settings save contract (Oct 23 2026) for Workflows, Letterheads,
// Payroll Export Codes, Shift Differentials and the Schedule Basics slice of
// the shift settings: a typed field reports the group dirty the moment it
// changes, there is ONE Save row and its Save opens up. The Intacct nightly
// sync says a failed load failed, with Retry - never "no companies".

const api = vi.hoisted(() => ({
  wfSettings: vi.fn(), wfSettingsSave: vi.fn(), wfPauseAll: vi.fn(),
  getDocLetterheads: vi.fn(), createDocLetterhead: vi.fn(), updateDocLetterhead: vi.fn(), deleteDocLetterhead: vi.fn(),
  getEntities: vi.fn(), timeExportCodesGet: vi.fn(), timeExportCodesSet: vi.fn(),
  timePremiumsGet: vi.fn(), timePremiumsSet: vi.fn(),
  shiftRequestSettingsGetFor: vi.fn(), shiftRequestSettingsSaveFor: vi.fn(), shiftRequestSettingsReset: vi.fn(), shiftRequestsInbox: vi.fn(),
  timeCalendarSyncStatus: vi.fn(),
  intacctCodesSettings: vi.fn(), setIntacctCodesNightly: vi.fn(),
}));
vi.mock('../../api', () => ({ api }));
vi.mock('../../contexts/RoleContext', () => ({
  useRole: () => ({ myRole: 'owner', can: () => true, myGrantedModules: new Map(), hrTeam: false }),
}));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn(), undo: vi.fn() } }));
vi.mock('../../teamsGraph', () => ({ graphTokenSilent: vi.fn(), graphTokenInteractive: vi.fn(), listMyChats: vi.fn(), channelTokenInteractive: vi.fn(), listMyChannels: vi.fn() }));
vi.mock('../PersonHoverCard', () => ({ default: ({ children }) => children }));

const { WorkflowsSettings } = await import('../../workflows/WorkflowsSettings');
const { LetterheadsPanel } = await import('../DocumentTemplates');
const PayrollExportCodes = (await import('../PayrollExportCodes')).default;
const PayPremiums = (await import('../PayPremiums')).default;
const { ShiftSettingsPanel } = await import('../shifts/ShiftSettingsSections');
const { IntacctNightlySync } = await import('../IntacctEmployeeCodes');

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.wfSettings.mockResolvedValue({ enabled: true, ownerDigest: false, maxRunsPerHourCap: 500, maxRecipientsCap: 200, nexusRunAs: false, webhookHosts: [], webhookSecretsSet: [], override: false });
  api.getDocLetterheads.mockResolvedValue([]);
  api.getEntities.mockResolvedValue([{ id: 'c1', name: 'Greens Global' }]);
  api.timeExportCodesGet.mockResolvedValue({ maxLength: 31, quickbooksCompanyName: '', quickbooksCompanyDefault: 'Greens Global', classes: [{ key: 'regular', default: 'Regular Pay', code: 'Regular Pay', custom: false }] });
  api.timePremiumsGet.mockResolvedValue({ enabled: true, differentials: [{ id: 'r1', name: 'Night', kind: 'flat', amount: 2, start: '22:00', end: '06:00', days: [], sites: [] }], callBack: { enabled: false, minimumMin: 120, gapMin: 60 }, sites: [], maxRules: 20 });
  api.shiftRequestSettingsGetFor.mockResolvedValue({ timeZone: 'America/Los_Angeles', weekStart: 'monday', defaultGraceMin: 10 });
  api.timeCalendarSyncStatus.mockResolvedValue({ enabled: false });
});
afterEach(() => cleanup());

const PANELS = [
  ['Workflows', () => <WorkflowsSettings company="" />, () => screen.findByLabelText('Runs per hour cap')],
  ['Letterheads (a new one)', () => <LetterheadsPanel />, async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Add Letterhead/ }));
    return screen.getByLabelText('Letterhead name');
  }],
  ['Payroll Export Codes', () => <PayrollExportCodes company="c1" />, () => screen.findByLabelText('Regular code')],
  ['Shift Differentials', () => <PayPremiums company="c1" />, () => screen.findByLabelText('Differential name')],
  ['Schedule Basics', () => <ShiftSettingsPanel company="" part="basics" />, () => screen.findByLabelText('Default grace')],
];

describe('Settings save contract (batch D)', () => {
  it.each(PANELS)('%s: a typed edit reports the group dirty, with one Save row', async (_name, ui, ready) => {
    const { container, group } = renderInGroup(ui());
    const first = await ready();
    expect(saveRows(container)).toBe(1);
    expect(group.dirty).toBe(false);
    expect(screen.getByRole('button', { name: /^(Save|Add Letterhead)$/, hidden: false })).toBeDisabled();
    const fields = typedFields(container);
    expect(fields).toContain(first);
    editField(first);
    await waitFor(() => expect(group.dirty).toBe(true));
    // Each dirty form gave its save, so the prompt can offer Save and Leave.
    expect(group.saves.every((s) => typeof s === 'function')).toBe(true);
    const save = screen.getAllByRole('button', { name: /^(Save|Add Letterhead)$/ }).find((b) => b.closest('[data-save-row]'));
    expect(save).not.toBeDisabled();
  });

  it('Schedule Basics puts the instant controls first and says what its Save row saves', async () => {
    const { container } = renderInGroup(<ShiftSettingsPanel company="" part="basics" />);
    await screen.findByLabelText('Default grace');
    const order = [...container.querySelectorAll('[aria-label="Team time zone"], [aria-label="Week starts on"], [aria-label="Default grace"], [data-save-row]')]
      .map((el) => el.getAttribute('aria-label') || 'save row');
    expect(order.slice(-2)).toEqual(['Default grace', 'save row']);
    expect(screen.getByText(/^Saves Default Grace\. Switches and lists save as you go\.$/)).toBeInTheDocument();
  });

  it('Intacct Nightly Sync: a failed load shows an error with Retry, not an empty list', async () => {
    api.intacctCodesSettings.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ companies: [{ id: 'c1', name: 'Greens Global', nightly: false }], lastRun: {} });
    renderInGroup(<IntacctNightlySync embedded />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText(/No companies/)).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByRole('switch', { name: 'Greens Global' })).toBeInTheDocument();
  });

  it('Intacct Nightly Sync: a switch that fails to save goes back', async () => {
    const toastErr = vi.fn();
    api.intacctCodesSettings.mockResolvedValue({ companies: [{ id: 'c1', name: 'Greens Global', nightly: false }], lastRun: {} });
    api.setIntacctCodesNightly.mockRejectedValue(new Error('No'));
    renderInGroup(<IntacctNightlySync embedded toastErr={toastErr} />);
    const sw = await screen.findByRole('switch', { name: 'Greens Global' });
    fireEvent.click(sw);
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith('No'));
    expect(sw.checked).toBe(false);
  });

  it('Letterheads: a failed load shows an error with Retry', async () => {
    api.getDocLetterheads.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([]);
    renderInGroup(<LetterheadsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No letterheads yet.')).toBeInTheDocument();
  });
});
