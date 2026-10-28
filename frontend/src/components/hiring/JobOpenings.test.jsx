import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for job openings (Oct 27 2026): the list with seats and
// candidate counts, the editor (Open needs the description), the careers
// page links, Post On LinkedIn copying the posting and opening LinkedIn, and
// the pay toggle offered only to Pay & Benefits.

const op = {
  id: 'op1', headcountId: 'h1', headcountCode: 'HC-0001', company: 'ent', companyName: 'Hire Co', department: 'Accounting',
  roleId: 'r1', title: 'Staff Accountant', description: 'Close the books.', employmentType: 'full_time', employmentLabel: 'Full-Time',
  seats: 2, workSiteId: '', location: 'Austin, TX', street: '', city: 'Austin', region: 'TX', postalCode: '', country: 'US',
  remote: false, locationLine: 'Austin, TX', status: 'draft', statusLabel: 'Draft', showPay: false, hasPay: true,
  hiringOwnerEmail: 'maya@x.com', hiringOwnerName: 'Maya T', validThrough: '', openedAt: '', filledAt: '', closedAt: '',
  listed: false, counts: { total: 3, hired: 1, applied: 2 }, careersUrl: 'https://nexus.example/careers/hire-co/op1', history: [],
};
const update = vi.fn();
vi.mock('../../api', () => ({
  api: {
    listOpenings: () => Promise.resolve([op]),
    getPeopleDirectory: () => Promise.resolve([]),
    careersLinks: () => Promise.resolve([{ companyId: 'ent', name: 'Hire Co', url: 'https://nexus.example/careers/hire-co' }]),
    updateOpening: (...a) => update(...a),
    openingPosting: () => Promise.resolve({ text: 'Staff Accountant\nApply: https://nexus.example/careers/hire-co/op1\n', listed: false,
      careersUrl: op.careersUrl, boards: [{ id: 'linkedin', name: 'LinkedIn', mode: 'copy', url: 'https://www.linkedin.com/talent/post-a-job' },
        { id: 'indeed', name: 'Indeed', mode: 'link', url: 'https://employers.indeed.com/' }] }),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => false, myGrantedModules: new Set(), myEmail: 'holly@x.com' }) }));
vi.mock('../../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'maya@x.com', name: 'Maya T' }] }) }));
const { default: JobOpenings } = await import('./JobOpenings');

beforeEach(() => {
  update.mockReset().mockImplementation((id, body) => Promise.resolve({ ...op, ...(body.status ? { status: body.status, statusLabel: 'Open', listed: true } : {}) }));
});

describe('JobOpenings', () => {
  it('lists openings with their seats and candidates, and opens one', async () => {
    const toastOk = vi.fn();
    render(<JobOpenings toastOk={toastOk} toastErr={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Staff Accountant')).toBeTruthy());
    expect(screen.getByText(/1 of 2 hired · 3 candidates/)).toBeTruthy();
    expect(screen.getByText('https://nexus.example/careers/hire-co')).toBeTruthy();
    fireEvent.click(screen.getByText('Staff Accountant'));
    expect(await screen.findByText('Open On Careers Page')).toBeTruthy();
    expect(screen.getByText('Pay is visible to Pay & Benefits only.')).toBeTruthy();
    fireEvent.click(screen.getByText('Open On Careers Page'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('op1', expect.objectContaining({ status: 'open' })));
    expect(toastOk).toHaveBeenCalledWith('Open - it is on the careers page now.');
  });

  it('Post On LinkedIn copies the posting and opens LinkedIn', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobOpenings toastOk={vi.fn()} toastErr={vi.fn()} canSeePay />);
    fireEvent.click(await screen.findByText('Staff Accountant'));
    expect(await screen.findByText('Show The Pay Range On The Careers Page')).toBeTruthy();
    fireEvent.click(screen.getByText('Post On LinkedIn'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Apply: https://nexus.example/careers/hire-co/op1')));
    expect(open).toHaveBeenCalledWith('https://www.linkedin.com/talent/post-a-job', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
});
