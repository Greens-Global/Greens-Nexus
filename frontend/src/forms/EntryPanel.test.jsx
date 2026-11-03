import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// The panel a form entry opens beside the list (Neil, 11/02/2026): answers by
// section, photos opening the viewer, the map link, the signature, review with
// a note, Make a Ticket / Make a Task through the existing create modals, PDF.

const getFormEntry = vi.fn();
const getDocTemplate = vi.fn();
const reviewFormEntry = vi.fn();
const linkFormEntry = vi.fn();
const formEntryPdf = vi.fn();
vi.mock('../api', () => ({
  api: {
    getFormEntry: (...a) => getFormEntry(...a),
    getDocTemplate: (...a) => getDocTemplate(...a),
    reviewFormEntry: (...a) => reviewFormEntry(...a),
    linkFormEntry: (...a) => linkFormEntry(...a),
    formEntryPdf: (...a) => formEntryPdf(...a),
    viewerBlob: () => Promise.reject(new Error('offline')),
  },
}));
vi.mock('../tasks/components', () => ({
  AttachmentViewer: ({ att, onClose }) => <div role="dialog" aria-label="viewer">viewing {att.url}<button onClick={onClose}>Close viewer</button></div>,
}));
// The create modals need the Tasks store; entryMounts wraps them in it. Here
// they only record what they were handed.
const ticketProps = vi.fn();
const taskProps = vi.fn();
vi.mock('./entryMounts', () => ({
  TicketComposer: (p) => { ticketProps(p); return <div>ticket composer<button onClick={() => p.onCreated({ id: 'tk-9' })}>made ticket</button></div>; },
  TaskComposer: (p) => { taskProps(p); return <div>task composer<button onClick={() => p.onCreated({ id: 'ta-4' })}>made task</button></div>; },
}));

const EntryPanel = (await import('./EntryPanel')).default;
const { takePendingOpen } = await import('../lib/pendingOpen');

const TEMPLATE = {
  id: 'f1', name: 'Vehicle Check', docType: 'form', fieldDefs: [
    { token: 'odometer', label: 'Odometer', type: 'number', section: 'Vehicle' },
    { token: 'damage', label: 'Any Damage?', type: 'yesno', section: 'Vehicle' },
    { token: 'damage_photos', label: 'Damage Photos', type: 'photo', section: 'Vehicle', showIf: { token: 'damage', op: 'eq', value: true } },
    { token: 'where', label: 'Where Are You?', type: 'gps', section: 'Location' },
    { token: 'tire', label: 'Tire', type: 'text', section: 'Tires', repeat: { group: 'tires', max: 6 } },
    { token: 'psi', label: 'PSI', type: 'number', section: 'Tires', repeat: { group: 'tires', max: 6 } },
    { token: 'condition', label: 'Condition', type: 'rating', section: 'Sign Off' },
    { token: 'driver_sig', label: 'Driver Signature', type: 'signature', section: 'Sign Off' },
  ],
};
const ENTRY = {
  id: 'e1', templateId: 'f1', templateVersion: 3, title: 'Vehicle Check', entryKey: 'k1',
  answers: {
    odometer: 48210, damage: true, damage_photos: ['https://x/a.jpg', 'https://x/b.jpg'],
    where: { lat: 30.27, lng: -97.74, accuracyM: 12, siteName: 'Austin' },
    tires: [{ tire: 'Front Left', psi: 35 }, { tire: 'Front Right', psi: 34 }],
    condition: 4, driver_sig: 'https://x/sig.png',
  },
  company: 'Greens Global', workSiteId: 's1', workSiteName: 'Austin', shiftId: '', submittedBy: 'sam@greensglobal.com', submittedByName: 'Sam Rivera',
  submittedAt: '2026-11-02T21:14:00Z', source: 'phone', status: 'submitted', reviewerEmail: '', reviewedAt: '', reviewNote: '',
  linkedTicketId: '', linkedTaskId: '', linkedAssetId: '', canReview: true,
};

beforeEach(() => {
  getFormEntry.mockReset().mockResolvedValue(ENTRY);
  // The fields arrive a beat after the panel, as on a real network (CI race, 11/02/2026).
  getDocTemplate.mockReset().mockImplementation(() => new Promise((r) => setTimeout(() => r(TEMPLATE), 30)));
  reviewFormEntry.mockReset().mockImplementation((id, d) => Promise.resolve({ ...ENTRY, ...d, reviewNote: d.note }));
  linkFormEntry.mockReset().mockImplementation((id, d) => Promise.resolve({ ...ENTRY, linkedTicketId: d.ticketId || '', linkedTaskId: d.taskId || '' }));
  formEntryPdf.mockReset().mockResolvedValue({ blob: new Blob(['%PDF']), filename: 'vehicle-check.pdf' });
  globalThis.URL.createObjectURL = () => 'blob:x';
  globalThis.URL.revokeObjectURL = () => {};
});

// The panel re-reads the entry on open; the fresh copy is what the test says it is.
const open = (over = {}) => {
  getFormEntry.mockResolvedValue({ ...ENTRY, ...over });
  return render(<EntryPanel entry={{ ...ENTRY, ...over }} onClose={() => {}} onChanged={() => {}} toastOk={() => {}} toastErr={() => {}} />);
};

describe('Entry panel', () => {
  it('shows the answers under their sections, in words a person reads', async () => {
    open();
    const panel = await screen.findByRole('complementary', { name: 'Vehicle Check' });
    await within(panel).findByRole('heading', { name: 'Vehicle' });   // the fields come a beat after the panel
    for (const h of ['Vehicle', 'Location', 'Tires', 'Sign Off']) expect(within(panel).getByRole('heading', { name: h })).toBeTruthy();
    expect(within(panel).getByText('48210')).toBeTruthy();
    expect(within(panel).getByText('Yes')).toBeTruthy();
    expect(within(panel).getAllByRole('img', { name: /Damage Photos/ })).toHaveLength(2);
    const map = within(panel).getByRole('link', { name: /Austin/ });
    expect(map.getAttribute('href')).toContain('30.27,-97.74');
    expect(within(panel).getByText('Front Left')).toBeTruthy();
    expect(within(panel).getByText('34')).toBeTruthy();
    expect(within(panel).getByText('4 of 5')).toBeTruthy();
    expect(within(panel).getByRole('img', { name: 'Driver Signature' })).toBeTruthy();
    expect(within(panel).getByText('Sam Rivera')).toBeTruthy();
    const fact = (k) => within(panel).getByText(k, { selector: 'dt' }).nextElementSibling.textContent;
    expect(fact('Form Version')).toBe('3');
    expect(fact('Sent From')).toBe('Phone');
  });

  it('an entry the server no longer shows says so instead of an empty panel', async () => {
    getFormEntry.mockReset().mockRejectedValue(Object.assign(new Error('Entry not found'), { status: 404 }));
    render(<EntryPanel entry={{ id: 'gone1', title: 'Vehicle Check' }} onClose={() => {}} onChanged={() => {}} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('This entry is not available.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a Ticket' })).toBeNull();
  });

  it('reads the answers with the fields the entry was filled on when the server sends them', async () => {
    open({ fieldDefs: [{ token: 'odometer', label: 'Odometer Then', type: 'number', section: 'Back Then' }] });
    const panel = await screen.findByRole('complementary', { name: 'Vehicle Check' });
    expect(await within(panel).findByText('Odometer Then')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Back Then' })).toBeTruthy();
  });

  it('a photo opens the viewer', async () => {
    open();
    const [first] = await screen.findAllByRole('img', { name: /Damage Photos/ });
    fireEvent.click(first);
    expect(await screen.findByRole('dialog', { name: 'viewer' })).toHaveTextContent('https://x/a.jpg');
  });

  it('review: a state and a note, saved together, and the submitter is told by the server', async () => {
    const onChanged = vi.fn();
    const toastOk = vi.fn();
    render(<EntryPanel entry={ENTRY} onClose={() => {}} onChanged={onChanged} toastOk={toastOk} toastErr={() => {}} />);
    await screen.findByRole('complementary');
    fireEvent.click(screen.getByRole('button', { name: 'Needs Follow-Up' }));
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'Fix the latch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Review' }));
    await waitFor(() => expect(reviewFormEntry).toHaveBeenCalledWith('e1', { status: 'follow_up', note: 'Fix the latch' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toastOk).toHaveBeenCalledWith('Marked Needs Follow-Up - Sam Rivera has been notified');
    expect(await screen.findByText('Needs Follow-Up', { selector: '.nx-label-text' })).toBeTruthy();
  });

  it("the submitter sees the review note with who reviewed it and when", async () => {
    open({ canReview: false, status: 'follow_up', reviewNote: 'Fix the latch', reviewerEmail: 'pat@greensglobal.com', reviewerName: 'Pat Lee', reviewedAt: '2026-11-03T16:05:00Z' });
    expect(await screen.findByText('Fix the latch')).toBeTruthy();
    const step = screen.getByText('Fix the latch').closest('.nx-dl-step');
    expect(step).toHaveTextContent('Pat Lee');
    expect(step.querySelector('small').textContent).toMatch(/^Pat Lee - 11\/03\/2026,? \d{1,2}:\d{2} [AP]M/);
  });

  it('no review controls for someone who may only read it', async () => {
    open({ canReview: false });
    await screen.findByRole('complementary');
    expect(screen.queryByRole('button', { name: 'Needs Follow-Up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Reviewed' })).toBeNull();
  });

  it('Download PDF asks the server for the entry\'s PDF', async () => {
    open();
    await screen.findByRole('complementary');
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(formEntryPdf).toHaveBeenCalledWith('e1'));
  });

  it('Make a Ticket prefills the ticket and links it back to the entry', async () => {
    open();
    await screen.findByRole('complementary');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make a Ticket' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Make a Ticket' }));
    expect(await screen.findByText('ticket composer')).toBeTruthy();
    const p = ticketProps.mock.calls.at(-1)[0];
    expect(p.initial.subject).toBe('Vehicle Check - Sam Rivera');
    expect(p.initial.description).toContain('Odometer: 48210');
    expect(p.initial.description).toContain('https://x/a.jpg');
    fireEvent.click(screen.getByText('made ticket'));
    await waitFor(() => expect(linkFormEntry).toHaveBeenCalledWith('e1', { ticketId: 'tk-9' }));
    expect(await screen.findByRole('button', { name: 'Open Ticket' })).toBeTruthy();
  });

  it('Make a Task prefills the task the same way', async () => {
    open();
    await screen.findByRole('complementary');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make a Task' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Make a Task' }));
    expect(await screen.findByText('task composer')).toBeTruthy();
    const p = taskProps.mock.calls.at(-1)[0];
    expect(p.defaults.title).toBe('Vehicle Check - Sam Rivera');
    expect(p.defaults.description).toContain('Any Damage?: Yes');
    fireEvent.click(screen.getByText('made task'));
    await waitFor(() => expect(linkFormEntry).toHaveBeenCalledWith('e1', { taskId: 'ta-4' }));
  });

  it('Make a Ticket and Make a Task wait for the answers, so neither is made without them', async () => {
    let arrive;
    getDocTemplate.mockReset().mockImplementation(() => new Promise((r) => { arrive = () => r(TEMPLATE); }));
    open();
    await screen.findByRole('complementary');
    expect(screen.getByRole('button', { name: 'Make a Ticket' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Make a Task' }).disabled).toBe(true);
    arrive();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make a Ticket' }).disabled).toBe(false));
    expect(screen.getByRole('button', { name: 'Make a Task' }).disabled).toBe(false);
  });

  it('shows the links an entry already has', async () => {
    open({ linkedTicketId: 'tk-1', linkedTaskId: 'ta-2', linkedAssetId: 'as-3' });
    const panel = await screen.findByRole('complementary');
    expect(within(panel).getByRole('button', { name: 'Open Ticket' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Open Task' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Open Asset' })).toBeTruthy();
  });

  it('shows the submission\'s own location stamp with the facts', async () => {
    open({ answers: { ...ENTRY.answers, _location: { lat: 30.1, lng: -97.1, accuracyM: 20, siteName: 'Georgetown' } } });
    const panel = await screen.findByRole('complementary');
    const link = within(panel).getByRole('link', { name: /Georgetown/ });
    expect(link.getAttribute('href')).toContain('30.1,-97.1');
    expect(within(panel).queryByText('_location')).toBeNull();
  });

  it('still renders the raw answers when the template cannot be read', async () => {
    getDocTemplate.mockRejectedValue(new Error('404'));
    open();
    const panel = await screen.findByRole('complementary');
    expect(await within(panel).findByText('48210')).toBeTruthy();
  });
  it('Open Ticket / Open Task land on the record itself, not just its module', async () => {
    open({ linkedTicketId: 'tk-7', linkedTaskId: 'ta-3' });
    const seen = [];
    const listen = (e) => seen.push([e.type, e.detail]);
    for (const t of ['nexus:navigate', 'nexus:open-ticket', 'nexus:open-task']) window.addEventListener(t, listen);
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Open Ticket' }));
      expect(takePendingOpen('ticket')).toBe('tk-7');
      fireEvent.click(screen.getByRole('button', { name: 'Open Task' }));
      expect(takePendingOpen('task')).toBe('ta-3');
      await waitFor(() => expect(seen.map(([t]) => t)).toEqual(expect.arrayContaining(['nexus:open-ticket', 'nexus:open-task'])));
      expect(seen).toContainEqual(['nexus:open-ticket', { ticketId: 'tk-7' }]);
      expect(seen).toContainEqual(['nexus:open-task', { taskId: 'ta-3' }]);
      expect(seen.find(([t]) => t === 'nexus:navigate')[1]).toMatchObject({ view: 'tickets' });
    } finally {
      for (const t of ['nexus:navigate', 'nexus:open-ticket', 'nexus:open-task']) window.removeEventListener(t, listen);
    }
  });
});
