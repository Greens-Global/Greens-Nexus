import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { renderInGroup, typedFields, editField, saveRows } from './settings/settingsContract.testkit';

// The Settings save contract (Oct 23 2026) for the HR and pay panels that
// sit in Settings groups: one Save row at the foot, Save disabled until a
// typed field changes, and the group told it is dirty the moment one does.

vi.mock('../api', () => ({
  api: {
    payrollReadinessSettings: () => Promise.resolve({
      company: '', settings: { varPct: 25, varHours: 8 }, limits: {}, override: false,
      canEdit: true, canEditDefault: true, companies: [],
    }),
    payrollReadinessSaveSettings: vi.fn(() => Promise.resolve({ settings: { varPct: 26, varHours: 8 }, override: false })),
    caReviewSettings: () => Promise.resolve({ minWage: 16.9 }),
    caReviewSaveSettings: vi.fn(() => Promise.resolve({})),
    leaveAdmin: () => Promise.resolve({
      canSetup: true, cutover: '2026-01-01', companies: [], defaults: ['us-ca'],
      policies: [{ id: 'us-ca', name: 'US - California', unit: 'hours', hoursPerDay: 8, eligibleTypes: ['full_time'], sick: { method: 'lump', hours: 40, afterDays: 90 }, vacation: { method: 'none' } }],
    }),
    leaveSavePolicies: vi.fn(() => Promise.resolve({})),
    leaveYearEndSettings: () => Promise.resolve({
      vacationMode: 'carry_cap', vacationCap: 40, vacationCapUnit: 'hours', vacationYear: 'calendar',
      sickMode: 'reset', sickCap: 0, sickCapUnit: 'hours', company: '', hasOverride: false, legal: [],
    }),
    leaveYearEndSettingsSave: vi.fn((body) => Promise.resolve({ ...body, legal: [] })),
    probationSettings: () => Promise.resolve({
      company: '', settings: { months: 3, reminderDays: 14, confirmTemplateId: '', extendTemplateId: '', letterheadId: '' },
      limits: { months: [1, 24], reminderDays: [0, 90] }, override: false, canEdit: true, canEditDefault: true,
      companies: [], templates: [], letterheads: [],
    }),
    probationSaveSettings: vi.fn(() => Promise.resolve({ settings: { months: 4, reminderDays: 14 }, override: false })),
  },
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: () => Promise.resolve(true), undo: () => {} } }));
// A Super Administrator by default: the minimum wage is every company's (11/02/2026).
const role = { isGlobalAdmin: true };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, isGlobalAdmin: role.isGlobalAdmin }) }));

const { ReadinessThresholds } = await import('./PayrollReadiness');
const { MinWageForm } = await import('./CaReview');
const { LeaveSetup } = await import('./LeaveBalances');
const { LeaveYearEndSettings } = await import('./LeaveYearEnd');
const { ProbationSettings } = await import('./HrProbation');

afterEach(cleanup);

const PANELS = [
  ['Payroll Readiness thresholds', () => <ReadinessThresholds company="" toastOk={() => {}} toastErr={() => {}} />],
  ['California Minimum Wage', () => <MinWageForm toastOk={() => {}} toastErr={() => {}} />],
  ['Leave Policies', () => <LeaveSetup toastOk={() => {}} toastErr={() => {}} />],
  ['Leave Year-End', () => <LeaveYearEndSettings toastOk={() => {}} toastErr={() => {}} />],
  ['Probation', () => <ProbationSettings company="" toastOk={() => {}} toastErr={() => {}} />],
];

describe('HR and pay Settings panels keep the one save pattern', () => {
  it.each(PANELS)('%s: one Save row, Save disabled until a typed field changes, and the group hears it', async (_name, ui) => {
    const { container, group } = renderInGroup(ui());
    await waitFor(() => expect(saveRows(container)).toBe(1));
    const save = screen.getByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();
    expect(group.dirty).toBe(false);
    const fields = typedFields(container);
    expect(fields.length).toBeGreaterThan(0);
    editField(fields[0]);
    await waitFor(() => expect(group.dirty).toBe(true));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled();
    // The group can save it from the prompt (Save and Leave).
    expect(group.saves.every(s => typeof s === 'function')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    await waitFor(() => expect(group.dirty).toBe(false));
  });

  it('California Minimum Wage is read-only for anyone but a Super Administrator: no Save row, never dirty', async () => {
    role.isGlobalAdmin = false;
    try {
      const { container, group } = renderInGroup(<MinWageForm toastOk={() => {}} toastErr={() => {}} />);
      expect(await screen.findByText('Only a Super Administrator can change this.')).toBeInTheDocument();
      expect(saveRows(container)).toBe(0);
      expect(screen.getByLabelText('Minimum Wage').readOnly).toBe(true);
      expect(typedFields(container)).toHaveLength(0);
      expect(group.dirty).toBe(false);
    } finally {
      role.isGlobalAdmin = true;
    }
  });

  it('Leave Policies has one Save, no second Save Policies / Save Start Date button', async () => {
    const { container } = renderInGroup(<LeaveSetup toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(saveRows(container)).toBe(1));
    expect(screen.queryByRole('button', { name: /Save Policies|Save Start Date/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Save$/ })).toHaveLength(1);
  });

  it('Save and Leave from the group saves and says it saved', async () => {
    const { api } = await import('../api');
    const { container, group } = renderInGroup(<ProbationSettings company="" toastOk={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(saveRows(container)).toBe(1));
    editField(typedFields(container)[0]);
    await waitFor(() => expect(group.dirty).toBe(true));
    await expect(group.saves[0]()).resolves.toBe(true);
    expect(api.probationSaveSettings).toHaveBeenCalledWith({ company: '', settings: { months: 4 } });
  });
});
