import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Mark an Issue on the Map (Charmi, Oct 20 2026): the ticket form opened from
// a mark on the site map shows where it is, asks for a photo, sends the spot
// as map_spot, and files the map's picture as an attachment.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com' }),
}));
const DEPTS = [{ id: 'd-fac', name: 'Facilities' }];
const addTicketAttachment = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    getMyTicketDepartments: () => Promise.resolve(DEPTS), getTicketDepartments: () => Promise.resolve(DEPTS),
    getTicketProperties: () => Promise.resolve({ properties: [], canWalkthrough: false }),
    addTicketAttachment: (...a) => addTicketAttachment(...a),
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
vi.mock('./evidenceUpload', () => ({ uploadTicketEvidence: vi.fn(() => Promise.resolve('https://x.supabase.co/storage/v1/object/public/ticket-evidence/m.jpg')) }));
const confirm = vi.fn(() => Promise.resolve(true));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), alert: vi.fn(() => Promise.resolve()) } }));
const createTicket = vi.fn(() => Promise.resolve({ id: 'tk1', propertyAssetId: 'esc' }));
vi.mock('../tasks/TasksContext', () => ({ useTasks: () => ({ createTicket, projects: [], myEmail: 'me@example.com' }) }));

const { CreateTicketModal } = await import('./TicketsView');
const { HELP_TOPICS } = await import('./ticketMeta');
HELP_TOPICS.push({ label: 'Construction & Maintenance', departments: ['facilities'], topics: [{ name: 'Lights or Electrical', area: 'facilities' }] });

afterEach(() => { cleanup(); createTicket.mockClear(); confirm.mockClear(); addTicketAttachment.mockClear(); });

const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const SPOT = { modelId: 'greens-storage-escondido', u: 12.5, v: -40, y: 0, r: 7.3, outline: [], unit: '', building: 'C',
  place: 'Near C179, Building C', lat: 33.170256, lng: -117.107523, ticketUnit: 'Common Area' };

describe('Mark an Issue: the ticket form', () => {
  it('shows the spot, nudges for a photo and files the spot with the ticket', async () => {
    const onClose = vi.fn();
    render(<CreateTicketModal onClose={onClose} forProperty={{ id: 'esc', name: 'Greens Storage Escondido', unit: 'Common Area' }} mapSpot={{ spot: SPOT, snapshot: PIXEL }} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    expect(screen.getByText('Location on Map')).toBeTruthy();
    expect(screen.getByText('Near C179, Building C')).toBeTruthy();
    expect(screen.getByText(/Circle, about 48 ft across/)).toBeTruthy();
    expect(screen.getByText(/press Ctrl\+V to paste one/)).toBeTruthy();
    expect(screen.getByAltText('Map of Near C179, Building C').getAttribute('src')).toBe(PIXEL);
    fireEvent.change(title, { target: { value: 'Pole light out' } });
    fireEvent.click(screen.getByText('Select one'));
    fireEvent.click(await screen.findByText('Lights or Electrical'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(confirm).toHaveBeenCalledTimes(1);   // no photo yet: asked, not blocked
    expect(createTicket).toHaveBeenCalledTimes(1);
    const body = createTicket.mock.calls[0][0];
    expect(body).toMatchObject({ propertyAssetId: 'esc', propertyUnit: 'Common Area' });
    expect(body.map_spot).toEqual({ modelId: 'greens-storage-escondido', u: 12.5, v: -40, y: 0, r: 7.3, outline: [], unit: '', building: 'C', place: 'Near C179, Building C' });
    expect(addTicketAttachment).toHaveBeenCalledWith('tk1', expect.objectContaining({ kind: 'image', name: expect.stringMatching(/^Map Location - Near C179, Building C\.jpg$/) }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a photo pasted with Ctrl+V skips the question', async () => {
    render(<CreateTicketModal onClose={vi.fn()} forProperty={{ id: 'esc', name: 'Greens Storage Escondido', unit: 'Common Area' }} mapSpot={{ spot: SPOT, snapshot: PIXEL }} />);
    const title = await screen.findByPlaceholderText(/What is the issue\?/);
    const photo = new File(['x'], 'pole.png', { type: 'image/png' });
    fireEvent.paste(title, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => photo }] } });
    expect(await screen.findByText(/Photo added/)).toBeTruthy();
    fireEvent.change(title, { target: { value: 'Pole light out' } });
    fireEvent.click(screen.getByText('Select one'));
    fireEvent.click(await screen.findByText('Lights or Electrical'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Ticket' })); });
    expect(confirm).not.toHaveBeenCalled();
    expect(createTicket).toHaveBeenCalledTimes(1);
  });
});
