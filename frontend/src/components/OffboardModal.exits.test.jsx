import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Offboard (Neil, 11/14/2026): the Last Day starts EMPTY - today is one tap
// ("Today - Access Ends Now") with the red warning, judged by the server's
// own today; Review waits for the date and, when they have direct reports,
// for who takes them over; Offboard Now is held and a click with no press
// falls back to the ordinary confirm (no clickRuns).

const context = vi.fn();
const preview = vi.fn();
vi.mock('../api', () => ({
  api: {
    offboardContext: (...a) => context(...a),
    previewOffboard: (...a) => preview(...a),
    offboard: vi.fn(),
    changeLastDay: vi.fn(),
  },
}));
vi.mock('../lib/queries', () => ({
  usePeopleDirectory: () => ({ data: [{ email: 'next@x.com', name: 'Nia Next' }, { email: 'erin@x.com', name: 'Erin Lee' }] }),
}));
vi.mock('./PersonSearchSelect', () => ({
  default: ({ placeholder, onPick }) => <button type="button" onClick={() => onPick('next@x.com')}>{placeholder}</button>,
}));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [] }));

const { OffboardModal, ChangeLastDayModal } = await import('./HrPersonActions');
const erin = { id: 'e1', firstName: 'Erin', lastName: 'Lee', company: 'c1', jobTitle: 'Analyst', workEmail: 'erin@x.com', personalEmail: 'erin@home.com' };

beforeEach(() => {
  context.mockReset().mockResolvedValue({ reports: [], rolesHeld: [], today: '2026-11-14', scheduled: null });
  preview.mockReset().mockResolvedValue({ immediate: true, lastDay: '2026-11-14', package: false, unresolved: [], recipients: [], documents: [] });
});

const pickType = () => fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });

describe('OffboardModal', () => {
  it('starts with no last day, and today is one tap with the warning', async () => {
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(context).toHaveBeenCalledWith('e1'));
    pickType();
    const reviewBtn = screen.getByRole('button', { name: /Review/ });
    expect(reviewBtn.disabled).toBe(true);                         // no date yet
    expect(screen.getByText(/Pick their last day/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Today - Access Ends Now/ }));
    expect(screen.getByText(/their access ends as soon as you confirm/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /Review/ }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][1].inputs.last_day).toBe('2026-11-14');   // the server's today
    // Offboard Now is held; no click-to-run.
    expect(await screen.findByRole('button', { name: /Offboard Now/ })).toBeTruthy();
  });

  it('needs who takes over their direct reports', async () => {
    context.mockResolvedValue({ reports: [{ id: 'r1', email: 'rae@x.com', name: 'Rae Port', kind: 'manager' },
      { id: 'r2', email: 'cov@x.com', name: 'Cova Red', kind: 'backup' }], rolesHeld: [], today: '2026-11-14' });
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText(/1 direct report: Rae Port/)).toBeTruthy();
    expect(screen.getByText(/Backup Manager for Cova Red/)).toBeTruthy();
    pickType();
    fireEvent.click(screen.getByRole('button', { name: /Today - Access Ends Now/ }));
    expect(screen.getByRole('button', { name: /Review/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Who they report to from now on' }));
    expect(screen.getByText('Nia Next')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review/ }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[0][1].inputs.offboarding.reportsTo).toBe('next@x.com');
  });
});

describe('ChangeLastDayModal', () => {
  it('shows the current day and ends access now only behind a hold', async () => {
    render(<ChangeLastDayModal employee={erin} current="2026-11-21" onClose={() => {}} onDone={() => {}} toastErr={() => {}} />);
    expect(screen.getByText('11/21/2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save Last Day/ }).disabled).toBe(true);
    await waitFor(() => expect(context).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Today - Access Ends Now/ }));
    expect(screen.getByRole('button', { name: /End Access Now/ })).toBeTruthy();
  });
});
