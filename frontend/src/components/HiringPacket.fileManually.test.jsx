import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// File Manually (Pranshu, Oct 15 2026): automatic Egnyte filing failed, HR
// picks the folder with the Egnyte folder picker (Neil, Oct 22: "you click on
// Browse ... You don't add the URL"), and a card filed by hand leaves the
// person's profile.

const now = new Date().toISOString();
const unfiled = {
  id: 'ev-packet', kind: 'hire', title: 'Hiring Packet', status: 'completed', subjectName: 'Demo Demo',
  completedAt: now, createdAt: now, filingStatus: 'pending', parties: [], flags: [], signRequestId: 'req-1',
  filingError: 'The parent folder for this person (/Shared/#Entities/GGCon/Human Resources/Employees) does not exist in Egnyte yet.',
};
const filedByHand = {
  id: 'ev-offer', kind: 'offer', title: 'Offer Letter', status: 'completed', subjectName: 'Demo Demo',
  completedAt: now, createdAt: now, filingStatus: 'filed', filingPath: '/Shared/HR/Demo Demo/x.pdf', parties: [], signRequestId: 'req-2',
  flags: [{ code: 'filed_by_hand', message: 'Filed by hand' }],
};
const filedAuto = { ...filedByHand, id: 'ev-auto', title: 'Promotion Letter', kind: 'promotion', flags: [] };
const fileLifeEventManually = vi.fn();
const egnytePersonDocs = vi.fn();
vi.mock('../api', () => ({
  api: {
    getLifeEvents: () => Promise.resolve([unfiled, filedByHand, filedAuto]),
    fileLifeEventManually: (...a) => fileLifeEventManually(...a),
    egnytePersonDocs: (...a) => egnytePersonDocs(...a),
    retryLifeEventFiling: vi.fn(),
  },
}));
const prompt = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => prompt(...a), confirm: vi.fn(), alert: vi.fn() } }));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [] }));
// Visesh's picker, stood in for: shows where it opened, and picks or closes.
vi.mock('../egnyte/EgnyteFolderPick', () => ({
  default: ({ startPath, title, onPick, onClose }) => (
    <div role="dialog" aria-label={title}>
      <span data-testid="start">{startPath}</span>
      <button onClick={() => onPick('/Shared/HR Manual/Demo Demo')}>Use This Folder</button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const { PersonLifeEvents } = await import('./HiringPacket');

beforeEach(() => {
  fileLifeEventManually.mockReset().mockResolvedValue({ events: [{ ...unfiled, filingStatus: 'filed' }] });
  egnytePersonDocs.mockReset().mockResolvedValue({ folder: '/Shared/#Entities/GGCon/Human Resources/Employees/Demo Demo', missing: false });
  prompt.mockReset();
});

describe('File Manually', () => {
  it('a card filed by hand leaves the profile; one filed automatically stays its 14 days', async () => {
    render(<PersonLifeEvents employeeId="e1" />);
    expect(await screen.findByText('Hiring Packet')).toBeTruthy();
    expect(screen.getByText('Promotion Letter')).toBeTruthy();
    expect(screen.queryByText('Offer Letter')).toBeNull();
  });

  it('opens the Egnyte picker at their folder and files where HR picks', async () => {
    const toastOk = vi.fn();
    render(<PersonLifeEvents employeeId="e1" workEmail="demo@greensglobal.com" toastOk={toastOk} />);
    fireEvent.click(await screen.findByText('File Manually'));
    const picker = await screen.findByRole('dialog', { name: 'File Manually In Egnyte' });
    expect(egnytePersonDocs).toHaveBeenCalledWith('demo@greensglobal.com');
    expect(screen.getByTestId('start').textContent).toBe('/Shared/#Entities/GGCon/Human Resources/Employees/Demo Demo');
    expect(prompt).not.toHaveBeenCalled();                       // no typed path any more
    fireEvent.click(within(picker).getByText('Use This Folder'));
    await waitFor(() => expect(fileLifeEventManually).toHaveBeenCalledWith('ev-packet', '/Shared/HR Manual/Demo Demo'));
    expect(toastOk).toHaveBeenCalledWith('Filed in Egnyte: /Shared/HR Manual/Demo Demo');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no known folder the picker opens at the top, and closing it files nothing', async () => {
    render(<PersonLifeEvents employeeId="e1" />);
    fireEvent.click(await screen.findByText('File Manually'));
    await screen.findByRole('dialog');
    expect(egnytePersonDocs).not.toHaveBeenCalled();
    expect(screen.getByTestId('start').textContent).toBe('');
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fileLifeEventManually).not.toHaveBeenCalled();
  });
});

describe('Offboarding with no separation package (Charmi, Oct 20 2026)', () => {
  it('reads No Paperwork - no endless "Filing in Egnyte..." and no Retry Filing', async () => {
    const { LifeEventCard } = await import('./HiringPacket');
    const bare = { id: 'ev-sep', kind: 'separation', title: 'Separation Package', status: 'completed', subjectName: 'Demo Demo',
      completedAt: now, createdAt: now, filingStatus: '', signRequestId: '', parties: [], flags: [], documents: [],
      applyStatus: 'applied', applyNote: 'Marked Left' };
    render(<LifeEventCard ev={bare} />);
    expect(screen.getByText('No Paperwork')).toBeTruthy();
    expect(screen.queryByText(/Filing in Egnyte/)).toBeNull();
    expect(screen.queryByText('Retry Filing')).toBeNull();
    expect(screen.queryByText('Fully Signed')).toBeNull();
  });
});
