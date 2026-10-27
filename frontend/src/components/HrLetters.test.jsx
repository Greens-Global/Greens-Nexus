import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// HR letters (Oct 27 2026): the employee's card (requests, statuses, the
// download of an issued one), the HR queue panel and the Settings panel all
// render, and the request form sends what was picked.

const calls = {};
const fn = (name, impl) => { calls[name] = vi.fn(impl); return (...a) => calls[name](...a); };
vi.mock('../api', () => ({
  api: {
    hrLettersMine: fn('hrLettersMine', async () => []),
    hrLetterTypes: fn('hrLetterTypes', async () => []),
    hrLetterQueue: fn('hrLetterQueue', async () => ({ canReview: false, requests: [] })),
    hrLetterRequest: fn('hrLetterRequest', async () => ({})),
    hrLetterReview: fn('hrLetterReview', async () => ({})),
    hrLetterStartReview: fn('hrLetterStartReview', async () => ({})),
    hrLetterPreview: fn('hrLetterPreview', async () => ({ blob: new Blob(['%PDF']) })),
    hrLetterSettings: fn('hrLetterSettings', async () => ({})),
    hrLetterSettingsSave: fn('hrLetterSettingsSave', async () => ({})),
    myHrDocDownload: fn('myHrDocDownload', async () => ({ url: 'https://example.test/x.pdf' })),
  },
}));

const { MyLettersCard, LetterRequestsPanel, HrLettersSettings } = await import('./HrLetters');

const TYPES = [
  { key: 'employment_verification', label: 'Employment Verification', desc: 'Confirms you work here.', printsPay: false },
  { key: 'salary_certificate', label: 'Salary Certificate', desc: 'Confirms your pay.', printsPay: true },
];
const row = (over = {}) => ({
  id: 'r1', type: 'employment_verification', typeLabel: 'Employment Verification', status: 'requested',
  statusLabel: 'Requested', purpose: 'Apartment lease', addressedTo: '', neededBy: '2026-11-02', notes: '',
  employeeName: 'Erin Test', createdAt: '2026-10-27T15:00:00+00:00', declineReason: '', note: '', documentId: '', ...over,
});

beforeEach(() => {
  Object.values(calls).forEach(c => c.mockClear());
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:x';
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};
});

describe('MyLettersCard', () => {
  it('lists my letters with US dates and soft status labels, and downloads an issued one', async () => {
    calls.hrLettersMine.mockResolvedValueOnce([
      row(), row({ id: 'r2', status: 'issued', statusLabel: 'Issued', documentId: 'env-1' }),
      row({ id: 'r3', status: 'declined', statusLabel: 'Declined', declineReason: 'Need your new address first.' }),
    ]);
    calls.hrLetterTypes.mockResolvedValueOnce(TYPES);
    const flash = vi.fn();
    render(<MyLettersCard flash={flash} />);
    expect(await screen.findByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('Issued')).toBeInTheDocument();
    expect(screen.getByText('Need your new address first.')).toBeInTheDocument();
    expect(screen.getAllByText(/Needed by 11\/02\/2026/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/2026-11-02/)).toBeNull();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    await waitFor(() => expect(calls.myHrDocDownload).toHaveBeenCalledWith('env-1'));
    open.mockRestore();
  });

  it('sends a request with the letter picked and its purpose', async () => {
    calls.hrLetterTypes.mockResolvedValueOnce(TYPES);
    calls.hrLetterRequest.mockResolvedValueOnce(row({ id: 'new', type: 'salary_certificate', typeLabel: 'Salary Certificate' }));
    render(<MyLettersCard flash={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Request a Letter/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Salary Certificate/ }));
    expect(screen.getByText(/shows your pay/)).toBeInTheDocument();
    const send = screen.getByRole('button', { name: /Send Request/ });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What Is It For?'), { target: { value: 'Car loan' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.hrLetterRequest).toHaveBeenCalledWith(
      expect.objectContaining({ letter_type: 'salary_certificate', purpose: 'Car loan' })));
  });

  it('shows the requests waiting on me as HR', async () => {
    calls.hrLetterQueue.mockResolvedValueOnce({ canReview: true, requests: [row({ employeeName: 'Pat Peer' })] });
    render(<MyLettersCard flash={vi.fn()} />);
    expect(await screen.findByText(/Waiting on You as HR/)).toBeInTheDocument();
    expect(screen.getByText('Pat Peer')).toBeInTheDocument();
  });
});

describe('LetterRequestsPanel', () => {
  it('renders nothing for someone who is not HR', async () => {
    const { container } = render(<LetterRequestsPanel />);
    await waitFor(() => expect(calls.hrLetterQueue).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the open requests for HR', async () => {
    calls.hrLetterQueue.mockResolvedValueOnce({ canReview: true, requests: [row(), row({ id: 'r2', status: 'awaiting_signature', statusLabel: 'Awaiting Signature' })] });
    render(<LetterRequestsPanel />);
    expect(await screen.findByText(/Letter Requests - 2 open/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review/ })).toBeInTheDocument();
  });
});

describe('HrLettersSettings', () => {
  const cfg = (over = {}) => ({
    companyId: 'c1', hasOverride: false, letterheadId: '',
    types: TYPES.map(t => ({ ...t, on: true, templateId: '', defaultTemplateId: `hr-letter-${t.key}`, templateName: `HR Letter - ${t.label}` })),
    templates: [{ id: 'hr-letter-employment_verification', name: 'HR Letter - Employment Verification', published: true },
      { id: 't-own', name: 'Our Verification Letter', published: true }],
    letterheads: [{ id: 'lh1', name: 'Greens Letterhead', isDefault: true }],
    ...over,
  });

  it('turns a letter off for a company, saving on the click', async () => {
    calls.hrLetterSettings.mockResolvedValueOnce(cfg());
    calls.hrLetterSettingsSave.mockResolvedValueOnce(cfg({ hasOverride: true }));
    const onOverride = vi.fn();
    render(<HrLettersSettings company="c1" onOverride={onOverride} toastOk={vi.fn()} />);
    const sw = await screen.findByRole('switch', { name: 'Salary Certificate' });
    expect(screen.getByText(/Using the default for every company/)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(calls.hrLetterSettingsSave).toHaveBeenCalledWith('c1', expect.objectContaining({
      types: expect.objectContaining({ salary_certificate: { on: false, templateId: '' } }),
    })));
    expect(await screen.findByRole('button', { name: 'Use the Default' })).toBeInTheDocument();
    expect(onOverride).toHaveBeenLastCalledWith(true);
  });
});
