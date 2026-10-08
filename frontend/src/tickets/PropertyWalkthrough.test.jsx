import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Property Walkthrough (Neil, 10/05): many lines, one submit, one batch_id.
// Opened from a property, the property is fixed (Pranshu, 10/06).
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const PROPS = { properties: [{ id: 'gst', name: 'Greens Storage Temecula', city: 'Temecula', state: 'CA', units: ['Office'] }], canWalkthrough: true };
const createTicketWalkthrough = vi.fn(() => Promise.resolve({
  batchId: 'b1', property: { id: 'gst', name: 'Greens Storage Temecula' }, replayed: false,
  tickets: [{ id: 't1', code: '000101', subject: 'Broken handrail' }, { id: 't2', code: '000102', subject: 'Repaint door' }],
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    getTicketProperties: () => Promise.resolve(PROPS),
    getMyTicketDepartments: () => Promise.resolve([{ id: 'd-hr', name: 'Human Resources' }, { id: 'd-fac', name: 'Facilities' }]),
    createTicketWalkthrough,
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
vi.mock('./evidenceUpload', () => ({ uploadTicketEvidence: vi.fn(() => Promise.resolve('https://x.supabase.co/storage/v1/object/public/ticket-evidence/p.jpg')) }));

const { default: PropertyWalkthrough } = await import('./PropertyWalkthrough');
const { HELP_TOPICS } = await import('./ticketMeta');
// Normally loaded from the admin's taxonomy (ticketConfig.js).
HELP_TOPICS.push(
  { label: 'Construction & Maintenance', departments: ['facilities'], topics: [{ name: 'Painting', area: 'facilities' }, { name: 'Railings or Stairs', area: 'facilities' }] },
  { label: 'HR', departments: ['human resources'], topics: [{ name: 'Benefits', area: 'general' }] },
);
const GST = { id: 'gst', name: 'Greens Storage Temecula' };

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); createTicketWalkthrough.mockClear(); });

// Fill line n: a title and a topic picked from the building team's list.
const fill = async (n, title, topic = 'Painting') => {
  fireEvent.change(await screen.findByLabelText(`Issue ${n}`), { target: { value: title } });
  fireEvent.click(screen.getAllByText('HVAC, Plumbing, Painting…')[0]);
  // The open menu renders last; a line that already picked this topic shows it too.
  fireEvent.click((await screen.findAllByText(topic)).at(-1));
};

describe('Property Walkthrough', () => {
  it('fixes the property and offers only building and site teams', async () => {
    render(<PropertyWalkthrough onClose={vi.fn()} property={GST} />);
    expect(await screen.findByText('Greens Storage Temecula - Temecula, CA')).toBeTruthy();
    expect(screen.queryByText('Select property')).toBeNull();
    expect(await screen.findByText('Facilities')).toBeTruthy();          // preselected building team
    fireEvent.click(screen.getByText('Facilities'));
    expect(screen.queryByText('Human Resources')).toBeNull();           // never a people team
  });

  it('Enter in a title starts the next line', async () => {
    render(<PropertyWalkthrough onClose={vi.fn()} property={GST} />);
    const first = await screen.findByLabelText('Issue 1');
    fireEvent.change(first, { target: { value: 'Broken handrail' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(await screen.findByLabelText('Issue 2')).toBeTruthy();
  });

  it('files every filled line in one request with one batch id, and drops blank cards', async () => {
    render(<PropertyWalkthrough onClose={vi.fn()} property={GST} />);
    await screen.findByText('Facilities');
    await fill(1, 'Broken handrail', 'Railings or Stairs');
    fireEvent.keyDown(screen.getByLabelText('Issue 1'), { key: 'Enter' });
    await fill(2, 'Repaint door');
    fireEvent.keyDown(screen.getByLabelText('Issue 2'), { key: 'Enter' });   // a third, left blank
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create 2 Tickets/ })); });
    expect(createTicketWalkthrough).toHaveBeenCalledTimes(1);
    const body = createTicketWalkthrough.mock.calls[0][0];
    expect(body).toMatchObject({ property_asset_id: 'gst', hr_department_id: 'd-fac' });
    expect(body.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.lines.map((l) => [l.subject, l.application])).toEqual([['Broken handrail', 'Railings or Stairs'], ['Repaint door', 'Painting']]);
    expect(await screen.findByText(/created at/)).toBeTruthy();
  });

  it('marks the line the server refused and keeps everything', async () => {
    createTicketWalkthrough.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('1 line needs attention - nothing was filed yet.'),
      { status: 422, detail: { message: '1 line needs attention', lines: [{ index: 0, field: 'subject', error: 'Keep the title under 200 characters.' }] } })));
    render(<PropertyWalkthrough onClose={vi.fn()} property={GST} />);
    await screen.findByText('Facilities');
    await fill(1, 'x');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create 1 Ticket/ })); });
    expect(await screen.findByText('Keep the title under 200 characters.')).toBeTruthy();
    expect(screen.getByLabelText('Issue 1').value).toBe('x');
  });

  it('locks the lines after a lost response, so the retry is the same request', async () => {
    createTicketWalkthrough.mockImplementationOnce(() => Promise.reject(new Error('Failed to fetch')));   // no status
    render(<PropertyWalkthrough onClose={vi.fn()} property={GST} />);
    await screen.findByText('Facilities');
    await fill(1, 'Broken handrail');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create 1 Ticket/ })); });
    expect(screen.getByLabelText('Issue 1').closest('fieldset').disabled).toBe(true);   // can't add or edit lines now
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try Again' })); });
    const [first, second] = createTicketWalkthrough.mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);                                               // the same body
  });

  it('on batch_mismatch shows what was filed and carries the rest into a new walkthrough', async () => {
    createTicketWalkthrough.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('already filed'), {
      status: 409, detail: { code: 'batch_mismatch', property: GST, tickets: [{ id: 't1', code: '000101', subject: 'Broken handrail' }] } })));
    render(<PropertyWalkthrough onClose={vi.fn()} property={GST} />);
    await screen.findByText('Facilities');
    await fill(1, 'Broken handrail');
    fireEvent.keyDown(screen.getByLabelText('Issue 1'), { key: 'Enter' });
    await fill(2, 'Exit sign out');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create 2 Tickets/ })); });
    expect(await screen.findByText(/1 line was added or changed/)).toBeTruthy();
    const firstId = createTicketWalkthrough.mock.calls[0][0].batch_id;
    fireEvent.click(screen.getByRole('button', { name: /Start a Walkthrough With the 1 Unfiled Line/ }));
    expect(screen.getByLabelText('Issue 1').value).toBe('Exit sign out');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Create 1 Ticket/ })); });
    expect(createTicketWalkthrough.mock.calls[1][0].batch_id).not.toBe(firstId);   // a NEW batch
  });
});
