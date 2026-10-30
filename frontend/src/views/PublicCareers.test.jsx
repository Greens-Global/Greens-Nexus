import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the public careers page (/careers/<company>[/<opening>],
// Oct 27 2026): the list of open positions, one opening with its apply form,
// the JSON-LD the page adds when the Pages Function has not, the honeypot
// staying empty, the resume type check and the thank-you once sent.

const company = { name: 'Greens Test Co', slug: 'greens-test-co', logoUrl: '', website: 'https://greens.example' };
const opening = { id: 'op-1', title: 'Staff Accountant', department: 'Accounting', employmentLabel: 'Full-Time',
  location: 'Austin, TX', postedAt: '2026-10-20', validThrough: '2026-12-19', pay: '',
  description: 'Close the books.\n\n- Reconcile accounts\n- Run payroll' };
const submit = vi.fn(() => Promise.resolve({ ok: true, message: 'Thank you - your application is in.' }));
const fetchOpening = vi.fn();
vi.mock('../api', () => ({
  fetchCareersCompany: () => Promise.resolve({ company, openings: [opening] }),
  fetchCareersOpening: (...a) => fetchOpening(...a),
  submitCareersApplication: (...a) => submit(...a),
}));
const { default: PublicCareers } = await import('./PublicCareers');

beforeEach(() => {
  submit.mockClear();
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach(n => n.remove());
  fetchOpening.mockReset().mockResolvedValue({ company, opening, consent: 'I agree to keep it.',
    jsonLd: { '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'Staff Accountant' } });
});

describe('PublicCareers', () => {
  it('lists the open positions with links to each', async () => {
    render(<PublicCareers slug="greens-test-co" />);
    await waitFor(() => expect(screen.getByText('Open Positions At Greens Test Co')).toBeTruthy());
    const link = screen.getByText('Staff Accountant').closest('a');
    expect(link.getAttribute('href')).toBe('/careers/greens-test-co/op-1');
    expect(screen.getByText(/Posted 10\/20\/2026/)).toBeTruthy();
  });

  it('shows one opening, adds its JobPosting data and sends an application', async () => {
    render(<PublicCareers slug="greens-test-co" openingId="op-1" />);
    // Generous waits: the first render can pass 1 s when the whole suite runs at once.
    await waitFor(() => expect(screen.getByText('Apply For This Job')).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByText('Reconcile accounts').tagName).toBe('LI');
    expect(screen.getByText(/Applications close 12\/19\/2026/)).toBeTruthy();
    // The tag lands in an effect after the page renders; wait for it (flaked on CI 10/30).
    const ld = await waitFor(() => { const t = document.head.querySelector('script[type="application/ld+json"]'); expect(t).toBeTruthy(); return t; });
    expect(JSON.parse(ld.textContent)['@type']).toBe('JobPosting');

    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('Last Name *'), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'jane@example.com' } });
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '512-555-0100' } });
    fireEvent.change(screen.getByLabelText('Location *'), { target: { value: 'Austin, TX' } });
    fireEvent.click(screen.getByText('Send Application'));
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Resume');
    expect(submit).not.toHaveBeenCalled();

    const trap = screen.getByLabelText('Leave Blank');
    expect(trap.getAttribute('autocomplete')).toBe('new-password');
    expect(trap.getAttribute('name')).toBe('nx_f2');
    const input = screen.getByLabelText('Resume');
    fireEvent.change(input, { target: { files: [new File(['x'], 'cv.exe', { type: 'application/octet-stream' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('PDF or Word');
    fireEvent.change(input, { target: { files: [new File(['%PDF-1.7'], 'cv.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Send Application'));
    await waitFor(() => expect(screen.getByText('Thank You')).toBeTruthy(), { timeout: 5000 });
    const [id, form] = submit.mock.calls[0];
    expect(id).toBe('op-1');
    expect(form.get('first_name')).toBe('Jane');
    expect(form.get('consent')).toBe('true');
    expect(form.get('nx_f2')).toBe('');              // the honeypot stays empty for people
    expect(form.get('website')).toBeNull();          // renamed: no semantic name for autofill to match
    expect(form.get('resume').name).toBe('cv.pdf');
  });

  it('says so when a job is no longer open', async () => {
    fetchOpening.mockRejectedValueOnce(new Error('This job is no longer taking applications.'));
    render(<PublicCareers slug="greens-test-co" openingId="gone" />);
    await waitFor(() => expect(screen.getByText('This job is no longer taking applications.')).toBeTruthy());
    expect(screen.getByText('See All Open Positions').getAttribute('href')).toBe('/careers/greens-test-co');
  });
});
