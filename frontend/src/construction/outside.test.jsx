// Outside parties (Construction Round Three item 4, Neil, 11/11/2026): the
// public page an architect or a sub opens from a link, the Send sheet and the
// job's list of links. The rules live on the server
// (backend/test_construction_outside.py); these pin what the screens do.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../api.js', () => ({
  api: { sendOutsideLink: vi.fn(), getOutsideLinks: vi.fn(), revokeOutsideLink: vi.fn() },
  fetchOutsideLink: vi.fn(), submitOutsideAnswer: vi.fn(), submitOutsideDone: vi.fn(),
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), alert: vi.fn() } }));

const mod = await import('../api.js');
const { api, fetchOutsideLink, submitOutsideAnswer, submitOutsideDone } = mod;
const { default: PublicOutside } = await import('../views/PublicOutside');
const { SendLinkSheet, OutsideLinksSection } = await import('./OutsideLinks');

const job = { id: 'j1', name: 'Sample Build' };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('The public page', () => {
  it('an architect reads one RFI and answers it once', async () => {
    fetchOutsideLink.mockResolvedValueOnce({
      kind: 'rfi', job: { name: 'Sample Build', address: '1 Site Rd' }, for: 'Morgan', expiresAt: '2026-11-25T00:00:00+00:00',
      rfi: { number: 'RFI-001', subject: 'Footing depth', question: '24 or 36 in?', dueOn: '2026-11-14', status: 'open',
        files: [{ name: 'sketch.jpg', url: 'https://x/sketch.jpg?signed=1' }] }, canAnswer: true,
    }).mockResolvedValueOnce({
      kind: 'rfi', job: { name: 'Sample Build' }, expiresAt: '2026-11-25T00:00:00+00:00',
      rfi: { number: 'RFI-001', subject: 'Footing depth', question: '24 or 36 in?', status: 'answered', answer: 'Go to 36 in.', answeredOn: '2026-11-11', files: [] },
      canAnswer: false,
    });
    submitOutsideAnswer.mockResolvedValue({ ok: true });
    render(<PublicOutside token="tok-123" />);
    expect(await screen.findByText('RFI-001 - Footing depth')).toBeInTheDocument();
    expect(screen.getByText('Answer needed by 11/14/2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sketch.jpg' })).toHaveAttribute('href', 'https://x/sketch.jpg?signed=1');
    const send = screen.getByRole('button', { name: 'Send Answer' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), { target: { value: 'Go to 36 in.' } });
    fireEvent.click(send);
    await waitFor(() => expect(submitOutsideAnswer).toHaveBeenCalled());
    const [token, form] = submitOutsideAnswer.mock.calls[0];
    expect(token).toBe('tok-123');
    expect(form.get('answer')).toBe('Go to 36 in.');
    expect(await screen.findByText('Thank you - your answer was sent.')).toBeInTheDocument();
    expect(await screen.findByText('Answered 11/11/2026')).toBeInTheDocument();
  });

  it('a sub marks an item Done with a photo; a done item asks nothing', async () => {
    fetchOutsideLink.mockResolvedValue({
      kind: 'sub', job: { name: 'Sample Build' }, expiresAt: '2026-11-25T00:00:00+00:00', sub: { name: 'Acme Plumbing' },
      items: [{ id: 'p-1', title: 'Tighten trap', location: 'Unit 4', dueOn: '2026-11-12', done: false, notes: '' },
        { id: 'p-2', title: 'Seal the vent', done: true, doneAt: '2026-11-10T18:00:00Z', photoUrl: '' }],
    });
    submitOutsideDone.mockResolvedValue({ ok: true });
    const { container } = render(<PublicOutside token="tok-sub" />);
    expect(await screen.findByText('Acme Plumbing - Punch List')).toBeInTheDocument();
    expect(screen.getByText(/1 item to finish/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Take Photo and Mark Done' })).toHaveLength(1);
    const input = container.querySelector('[data-outside-item="p-1"] input[type="file"]');
    expect(input).toHaveAttribute('capture', 'environment');
    const photo = new File(['png'], 'done.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [photo] } });
    await waitFor(() => expect(submitOutsideDone).toHaveBeenCalled());
    expect(submitOutsideDone.mock.calls[0][1]).toBe('p-1');
    expect(submitOutsideDone.mock.calls[0][2].get('photo')).toBe(photo);
  });

  it('an expired link says so in words', async () => {
    fetchOutsideLink.mockRejectedValue(Object.assign(new Error('This link has expired or was turned off. Ask the person who sent it for a new one.'), { status: 410 }));
    render(<PublicOutside token="tok-old" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ask the person who sent it for a new one.');
  });
});

describe('Sending and listing links', () => {
  it('Email the Link sends and shows the link once, with Copy Link', async () => {
    api.sendOutsideLink.mockResolvedValue({ url: 'https://nexus/outside/abc', email: 'morgan@arch.com', expiresAt: '2026-11-25T00:00:00+00:00' });
    const onSent = vi.fn();
    render(<SendLinkSheet project={job} kind="rfi" refId="r1" what="RFI-001 Footing depth" defaultName="Architect" onClose={() => {}} onSent={onSent} />);
    const email = screen.getByRole('textbox', { name: 'Their Email' });
    fireEvent.change(email, { target: { value: 'not an email' } });
    expect(screen.getByRole('button', { name: 'Email the Link' })).toBeDisabled();
    fireEvent.change(email, { target: { value: 'morgan@arch.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email the Link' }));
    await waitFor(() => expect(api.sendOutsideLink).toHaveBeenCalledWith('j1', expect.objectContaining({ kind: 'rfi', ref_id: 'r1', email: 'morgan@arch.com', send_email: true, name: 'Architect' })));
    expect(await screen.findByRole('textbox', { name: 'The link' })).toHaveValue('https://nexus/outside/abc');
    expect(screen.getByText(/the only time the link is shown/)).toBeInTheDocument();
    expect(onSent).toHaveBeenCalled();
  });

  it('the list says who, what and how often, and a live link can be turned off', async () => {
    api.getOutsideLinks.mockResolvedValue({ links: [
      { id: 'l1', kind: 'sub', name: 'Acme Office', email: 'office@acme.com', createdByName: 'Pat Manager', uses: 2, lastUsedAt: '2026-11-11T17:00:00Z', expiresAt: '2026-11-25T00:00:00+00:00', live: true },
      { id: 'l2', kind: 'rfi', name: 'Morgan', email: '', uses: 0, expiresAt: '2026-11-01T00:00:00+00:00', revokedAt: '2026-11-02T00:00:00Z', live: false },
    ] });
    const { container } = render(<OutsideLinksSection project={job} />);
    await waitFor(() => expect(container.querySelector('[data-outside-link="l1"]')).toBeTruthy());
    expect(container.querySelector('[data-outside-link="l1"]').textContent).toContain('opened 2 times');
    expect(container.querySelector('[data-outside-link="l2"]').textContent).toContain('Turned Off');
    expect(screen.getAllByRole('button', { name: /Turn off the link/ })).toHaveLength(1);
  });
});
