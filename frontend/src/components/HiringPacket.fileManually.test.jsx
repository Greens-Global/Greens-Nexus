import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// File Manually (Pranshu, Oct 15 2026): automatic Egnyte filing failed, HR
// names the folder, and a card filed by hand leaves the person's profile.

const now = new Date().toISOString();
const unfiled = {
  id: 'ev-packet', kind: 'hire', title: 'Hiring Packet', status: 'completed', subjectName: 'Demo Demo',
  completedAt: now, createdAt: now, filingStatus: 'pending', parties: [], flags: [],
  filingError: 'The parent folder for this person (/Shared/#Entities/GGCon/Human Resources/Employees) does not exist in Egnyte yet.',
};
const filedByHand = {
  id: 'ev-offer', kind: 'offer', title: 'Offer Letter', status: 'completed', subjectName: 'Demo Demo',
  completedAt: now, createdAt: now, filingStatus: 'filed', filingPath: '/Shared/HR/Demo Demo/x.pdf', parties: [],
  flags: [{ code: 'filed_by_hand', message: 'Filed by hand' }],
};
const filedAuto = { ...filedByHand, id: 'ev-auto', title: 'Promotion Letter', kind: 'promotion', flags: [] };
const fileLifeEventManually = vi.fn();
vi.mock('../api', () => ({
  api: {
    getLifeEvents: () => Promise.resolve([unfiled, filedByHand, filedAuto]),
    fileLifeEventManually: (...a) => fileLifeEventManually(...a),
    retryLifeEventFiling: vi.fn(),
  },
}));
const prompt = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => prompt(...a), confirm: vi.fn(), alert: vi.fn() } }));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [] }));

const { PersonLifeEvents } = await import('./HiringPacket');

beforeEach(() => {
  fileLifeEventManually.mockReset().mockResolvedValue({ events: [{ ...unfiled, filingStatus: 'filed' }] });
  prompt.mockReset();
});

describe('File Manually', () => {
  it('a card filed by hand leaves the profile; one filed automatically stays its 14 days', async () => {
    render(<PersonLifeEvents employeeId="e1" />);
    expect(await screen.findByText('Hiring Packet')).toBeTruthy();
    expect(screen.getByText('Promotion Letter')).toBeTruthy();
    expect(screen.queryByText('Offer Letter')).toBeNull();
  });

  it('asks for the folder and files there', async () => {
    const toastOk = vi.fn();
    prompt.mockResolvedValue(' /Shared/HR Manual/Demo Demo ');
    render(<PersonLifeEvents employeeId="e1" toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('File Manually'));
    await waitFor(() => expect(fileLifeEventManually).toHaveBeenCalledWith('ev-packet', '/Shared/HR Manual/Demo Demo'));
    expect(prompt.mock.calls[0][1]).toMatchObject({ title: 'File Manually In Egnyte', required: true });
    expect(toastOk).toHaveBeenCalledWith('Filed in Egnyte: /Shared/HR Manual/Demo Demo');
  });

  it('does nothing when HR cancels the folder prompt', async () => {
    prompt.mockResolvedValue(null);
    render(<PersonLifeEvents employeeId="e1" />);
    fireEvent.click(await screen.findByText('File Manually'));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(fileLifeEventManually).not.toHaveBeenCalled();
  });
});
