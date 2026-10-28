import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';

// The holiday policy editor (Oct 29 2026): the source list grouped by scope,
// real dates with weekdays, the Observe On select preset by the weekend rule,
// and Save = preview first, then the patch.

const US_2027 = {
  country: 'US', year: 2027, source: 'computed', partial: false, note: '',
  holidays: [
    { date: '2027-01-01', weekday: 'Friday', name: "New Year's Day", scope: 'federal', suggestedType: 'mandatory', tentative: false, observed: '' },
    { date: '2027-02-15', weekday: 'Monday', name: "Presidents' Day", scope: 'federal', suggestedType: 'mandatory', tentative: false, observed: '' },
    { date: '2027-07-04', weekday: 'Sunday', name: 'Independence Day', scope: 'federal', suggestedType: 'mandatory', tentative: false, observed: '2027-07-05' },
    { date: '2027-11-26', weekday: 'Friday', name: 'Day After Thanksgiving', scope: 'company_common', suggestedType: 'mandatory', tentative: false, observed: '' },
    { date: '2027-02-12', weekday: 'Friday', name: "Lincoln's Birthday", scope: 'state:CT,IL,NY', suggestedType: 'optional', tentative: false, observed: '' },
  ],
};
const IN_2027 = {
  country: 'IN', year: 2027, source: 'google', partial: true, note: 'Partial list for 2027 - confirm dates nearer the time.',
  holidays: [
    { date: '2027-01-26', weekday: 'Tuesday', name: 'Republic Day', scope: 'national', suggestedType: 'mandatory', tentative: false, observed: '' },
    { date: '2027-03-10', weekday: 'Wednesday', name: 'Eid al-Fitr', scope: 'gazetted', suggestedType: 'mandatory', tentative: true, observed: '' },
    { date: '2027-03-22', weekday: 'Monday', name: 'Holi', scope: 'restricted', suggestedType: 'optional', tentative: false, observed: '' },
  ],
};

const api = vi.hoisted(() => ({
  getPublicHolidays: vi.fn(),
  getEntities: vi.fn(() => Promise.resolve([])),
  previewHolidayPolicy: vi.fn(),
  updateHolidayPolicy: vi.fn(),
  createHolidayPolicy: vi.fn(),
  copyHolidayPolicyYear: vi.fn(),
}));
vi.mock('../api', () => ({ api }));
const confirm = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), alert: () => Promise.resolve() } }));
// The calendar popover is not what these tests are about: a date box here is
// a plain text box carrying the same value and title.
vi.mock('../tasks/components', async (importOriginal) => ({
  ...(await importOriginal()),
  DateField: ({ value, onChange, title, disabled }) => (
    <input aria-label={title} value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value)} />
  ),
}));

const HolidayPolicyEditor = (await import('./HolidayPolicyEditor')).default;

const ENTITIES = [
  { id: 'c1', name: 'Greens Global', country: 'US' },
  { id: 'c2', name: 'Greens India', country: 'IN' },
];
const POLICY = {
  id: 'p1', name: 'US Holidays', description: '', weekendRule: 'keep', companyId: 'c1',
  companies: [{ id: 'c1', name: 'Greens Global', skipped: [] }], holidays: [], years: [2027], canEdit: true,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 28, 9, 0));
  api.getPublicHolidays.mockImplementation((country) => Promise.resolve(country === 'IN' ? IN_2027 : US_2027));
  api.previewHolidayPolicy.mockResolvedValue({ companies: [{
    id: 'c1', name: 'Greens Global', assigned: true, added: [{ key: 'US:independence-day:2027', date: '2027-07-04', name: 'Independence Day' }],
    removed: [], changed: [], detached: [], changedSkipped: 0, conflicts: [],
  }] });
  api.createHolidayPolicy.mockResolvedValue({ policy: { ...POLICY, id: 'p9' }, sync: { companies: 1, added: 1, updated: 0, removed: 0, detached: 0 } });
  api.updateHolidayPolicy.mockResolvedValue({ policy: POLICY, sync: { companies: 1, added: 1, updated: 0, removed: 0 } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

function open(policy = POLICY, extra = {}) {
  const props = { onClose: vi.fn(), onSaved: vi.fn(), toastOk: vi.fn(), toastErr: vi.fn(), ...extra };
  render(<HolidayPolicyEditor policy={policy} entities={ENTITIES} {...props} />);
  return props;
}

describe('HolidayPolicyEditor', () => {
  it('groups the US list by scope and shows each real date with its weekday', async () => {
    open();
    expect(await screen.findByRole('region', { name: 'Federal Holidays' })).toBeInTheDocument();
    expect(api.getPublicHolidays).toHaveBeenCalledWith('US', 2027);
    const federal = screen.getByRole('region', { name: 'Federal Holidays' });
    expect(within(federal).getByText("Presidents' Day")).toBeInTheDocument();
    expect(within(federal).getByText('07/04/2027 (Sunday)')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Common Company Holidays' })).getByText('Day After Thanksgiving')).toBeInTheDocument();
    const states = screen.getByRole('region', { name: 'Some States Only' });
    expect(within(states).getByText("Lincoln's Birthday")).toBeInTheDocument();
    expect(within(states).getByText('CT, IL, NY')).toBeInTheDocument();
    // Only a weekend holiday asks when to observe it.
    expect(screen.queryByLabelText("Observe Presidents' Day On")).not.toBeInTheDocument();
  });

  it('presets Observe On from the weekend rule - the real date by default, the Monday after on the federal rule', async () => {
    open();
    const observe = await screen.findByLabelText('Observe Independence Day On');
    expect(observe).toHaveValue('2027-07-04');
    fireEvent.change(screen.getByLabelText('When A Holiday Falls On A Weekend'), { target: { value: 'nearest_weekday' } });
    expect(screen.getByLabelText('Observe Independence Day On')).toHaveValue('2027-07-05');

    // Checking it adds it on that day, with the real date kept beside it.
    fireEvent.click(screen.getByLabelText('Add Independence Day'));
    expect(screen.getByText('Holiday is 07/04/2027 (Sunday)')).toBeInTheDocument();
    expect(screen.getByText('Holidays In 2027 (1)')).toBeInTheDocument();
  });

  it('shows a Tentative chip and the partial note for an India list', async () => {
    open({ ...POLICY, id: 'p2', name: 'India Holidays', companyId: 'c2', companies: [{ id: 'c2', name: 'Greens India', skipped: [] }] });
    expect(await screen.findByRole('region', { name: 'Gazetted Holidays' })).toBeInTheDocument();
    expect(api.getPublicHolidays).toHaveBeenCalledWith('IN', 2027);
    expect(screen.getByRole('region', { name: 'National Holidays' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Restricted Holidays (Optional)' })).toBeInTheDocument();
    const eid = within(screen.getByRole('region', { name: 'Gazetted Holidays' }));
    expect(eid.getByText('Tentative')).toBeInTheDocument();
    expect(screen.getByText('Partial list for 2027 - confirm dates nearer the time.')).toBeInTheDocument();
  });

  it('saves through the preview: Applies To sends the companies, the summary names each company, then the patch', async () => {
    const props = open();
    fireEvent.click(await screen.findByLabelText('Add Independence Day'));
    // Applies To: add Greens India.
    fireEvent.click(screen.getByText('Greens Global').closest('button'));
    fireEvent.click(await screen.findByText('Greens India'));

    fireEvent.click(screen.getByRole('button', { name: /Save Policy/ }));
    await waitFor(() => expect(api.updateHolidayPolicy).toHaveBeenCalled());
    const [pid, body] = api.previewHolidayPolicy.mock.calls[0];
    expect(pid).toBe('p1');
    expect(body.companies).toEqual(['c1', 'c2']);
    expect(body.weekendRule).toBe('keep');
    expect(body.holidays).toEqual([expect.objectContaining({
      key: 'US:independence-day:2027', date: '2027-07-04', actualDate: '', name: 'Independence Day', type: 'mandatory', countries: ['US'],
    })]);
    expect(confirm.mock.calls[0][0]).toBe('This updates 1 company: Greens Global (1 added).');
    expect(api.previewHolidayPolicy.mock.invocationCallOrder[0]).toBeLessThan(api.updateHolidayPolicy.mock.invocationCallOrder[0]);
    expect(api.updateHolidayPolicy).toHaveBeenCalledWith('p1', body);
    expect(props.toastOk).toHaveBeenCalledWith('Saved - updated 1 company');
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('previews a new policy as "new", lists clashes, and sends its owner company', async () => {
    api.previewHolidayPolicy.mockResolvedValueOnce({ companies: [{
      id: 'c1', name: 'Greens Global', assigned: true, added: [{ key: 'k', date: '2027-07-04', name: 'Independence Day' }],
      removed: [], changed: [], detached: [], changedSkipped: 0,
      conflicts: [{ date: '2027-07-04', name: 'Independence Day', with: "Company's Own Holidays" }],
    }] });
    const props = { onClose: vi.fn(), onSaved: vi.fn(), toastOk: vi.fn(), toastErr: vi.fn() };
    render(<HolidayPolicyEditor policy={null} entities={ENTITIES} {...props} />);
    fireEvent.change(screen.getByPlaceholderText('e.g. US Holidays'), { target: { value: 'US Holidays' } });
    fireEvent.click(screen.getByText('Pick one or more companies').closest('button'));
    fireEvent.click(await screen.findByText('Greens Global'));
    fireEvent.click(screen.getByRole('button', { name: /Save Policy/ }));
    await waitFor(() => expect(api.createHolidayPolicy).toHaveBeenCalled());
    expect(api.previewHolidayPolicy.mock.calls[0][0]).toBe('new');
    expect(confirm.mock.calls[0][0]).toContain("Independence Day 07/04/2027 is also in Company's Own Holidays.");
    expect(api.createHolidayPolicy.mock.calls[0][0]).toMatchObject({ name: 'US Holidays', companies: ['c1'], companyId: 'c1' });
    expect(props.toastOk).toHaveBeenCalledWith('Saved - updated 1 company');
  });

  it('does not save when the summary is cancelled', async () => {
    confirm.mockResolvedValueOnce(false);
    open();
    fireEvent.click(await screen.findByLabelText('Add Independence Day'));
    fireEvent.click(screen.getByRole('button', { name: /Save Policy/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(api.updateHolidayPolicy).not.toHaveBeenCalled();
  });

  // ── Oct 29 2026 review ──────────────────────────────────────────────────
  const row = (name) => document.querySelector(`[data-policy-holiday="${name}"]`);
  const hol = (extra) => ({ actualDate: '', type: 'mandatory', countries: ['US'], source: 'public', scope: 'federal', tentative: false, ...extra });

  it('a plain date edit changes the day only - the old day is not kept as the real date (finding 7)', async () => {
    open({ ...POLICY, holidays: [hol({ key: 'US:founders-day:2027', date: '2027-03-17', name: 'Founders Day', source: 'manual', scope: 'manual' })] });
    await screen.findByRole('region', { name: 'Federal Holidays' });
    fireEvent.change(within(row('Founders Day')).getByLabelText('Change Date'), { target: { value: '2027-03-18' } });
    expect(within(row('Founders Day')).queryByText(/Holiday is/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save Policy/ }));
    await waitFor(() => expect(api.updateHolidayPolicy).toHaveBeenCalled());
    expect(api.updateHolidayPolicy.mock.calls[0][1].holidays[0]).toMatchObject({ date: '2027-03-18', actualDate: '' });
  });

  it('explains the weekend rule and applies it to the holidays already there on request (finding 10)', async () => {
    open({ ...POLICY, holidays: [hol({ key: 'US:independence-day:2027', date: '2027-07-04', name: 'Independence Day' })] });
    expect(screen.getByText('Applies to holidays you add from now on. Holidays already in the policy keep their dates.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('When A Holiday Falls On A Weekend'), { target: { value: 'nearest_weekday' } });
    // Changing the rule alone moves nothing.
    expect(within(row('Independence Day')).getByLabelText('Change Date')).toHaveValue('2027-07-04');
    fireEvent.click(screen.getByRole('button', { name: 'Apply To Existing Holidays' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toContain('Independence Day: 07/04/2027 to 07/05/2027');
    expect(confirm.mock.calls[0][1].title).toBe('Apply To Existing Holidays');
    await waitFor(() => expect(within(row('Independence Day')).getByLabelText('Change Date')).toHaveValue('2027-07-05'));
    expect(within(row('Independence Day')).getByText('Holiday is 07/04/2027 (Sunday)')).toBeInTheDocument();
  });

  it('warns on a row that shares its day with another holiday (finding 1)', async () => {
    open({ ...POLICY, holidays: [
      hol({ key: 'US:christmas-day:2027', date: '2027-12-24', actualDate: '2027-12-25', name: 'Christmas Day' }),
      hol({ key: 'US:christmas-eve:2027', date: '2027-12-24', name: 'Christmas Eve', type: 'half_day', scope: 'company_common' }),
    ] });
    expect(within(row('Christmas Day')).getByText('Same day as Christmas Eve - Christmas Day wins')).toBeInTheDocument();
    expect(within(row('Christmas Eve')).getByText('Same day as Christmas Day - Christmas Day wins')).toBeInTheDocument();
  });

  it('says how many companies outside your scope a save updates (finding 4)', async () => {
    api.previewHolidayPolicy.mockResolvedValueOnce({ otherCompanies: 2, sameDay: [], companies: [{
      id: 'c1', name: 'Greens Global', assigned: true, added: [{ key: 'k', date: '2027-07-04', name: 'Independence Day' }],
      removed: [], changed: [], detached: [], changedSkipped: 0, conflicts: [],
    }] });
    open();
    fireEvent.click(await screen.findByLabelText('Add Independence Day'));
    fireEvent.click(screen.getByRole('button', { name: /Save Policy/ }));
    await waitFor(() => expect(api.updateHolidayPolicy).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toBe('This updates 1 company: Greens Global (1 added) and 2 other companies.');
  });

  it('does not show a second same-name holiday as chosen (finding 11)', async () => {
    api.getPublicHolidays.mockImplementation(() => Promise.resolve({ country: 'IN', year: 2026, holidays: [
      { date: '2026-01-03', weekday: 'Saturday', name: "Hazarat Ali's Birthday", scope: 'restricted', suggestedType: 'optional', tentative: false, observed: '' },
      { date: '2026-12-23', weekday: 'Wednesday', name: "Hazarat Ali's Birthday", scope: 'restricted', suggestedType: 'optional', tentative: false, observed: '' },
    ] }));
    open({ ...POLICY, id: 'p2', name: 'India Holidays', companyId: 'c2', companies: [{ id: 'c2', name: 'Greens India', skipped: [] }], years: [2026],
      holidays: [hol({ key: "IN:hazarat-ali-s-birthday:2026", date: '2026-01-03', name: "Hazarat Ali's Birthday", countries: ['IN'], type: 'optional' })] });
    await screen.findByRole('region', { name: 'Restricted Holidays (Optional)' });
    const boxes = screen.getAllByLabelText("Add Hazarat Ali's Birthday");
    expect(boxes.map(b => b.checked)).toEqual([true, false]);
  });

  it('opens a policy another company owns read-only', async () => {
    open({ ...POLICY, canEdit: false, holidays: [{ key: 'US:presidents-day:2027', date: '2027-02-15', actualDate: '', name: "Presidents' Day", type: 'mandatory', countries: ['US'] }] });
    expect(screen.getByText(/Only Greens Global can change this policy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Policy/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Holiday name')).toBeDisabled();
    expect(api.getPublicHolidays).not.toHaveBeenCalled();
  });
});
