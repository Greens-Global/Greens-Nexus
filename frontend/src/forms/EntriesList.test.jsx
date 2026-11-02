import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { formatDateTime } from '../lib/datetime';

// Documents > Forms > Entries (Neil, 11/02/2026): the entries the viewer may
// see, filtered by form / site / status / date / person, soft status labels,
// resizable columns, a row opening beside the list, CSV per form.

const getFormEntries = vi.fn();
const formTemplateCsv = vi.fn();
const getWorkSites = vi.fn();
const getPeopleDirectory = vi.fn();
vi.mock('../api', () => ({
  api: {
    getFormEntries: (...a) => getFormEntries(...a),
    formTemplateCsv: (...a) => formTemplateCsv(...a),
    getWorkSites: (...a) => getWorkSites(...a),
    getPeopleDirectory: (...a) => getPeopleDirectory(...a),
  },
}));
// Column widths are saved through the Accounting prefs store, which talks to
// the server - a plain in-memory pair here.
vi.mock('../components/accounting/prefs', () => {
  const React = require('react');
  return { useAccountingPrefs: () => { const [p, set] = React.useState({}); return [p, (patch) => set((x) => ({ ...x, ...patch }))]; } };
});

const EntriesList = (await import('./EntriesList')).default;

const TEMPLATES = [
  { id: 'f1', name: 'Vehicle Check', docType: 'form', state: 'published' },
  { id: 'f2', name: 'Incident Report', docType: 'form', state: 'published' },
  { id: 't1', name: 'Offer Letter', docType: 'document', state: 'published' },
];
const cell = (text) => screen.findByText(text, { selector: 'td' });
const entry = (over) => ({
  id: 'e1', templateId: 'f1', templateVersion: 2, title: 'Vehicle Check', entryKey: 'k1', answers: {}, company: 'Greens Global',
  workSiteId: 's1', workSiteName: 'Austin', shiftId: '', submittedBy: 'sam@greensglobal.com', submittedByName: 'Sam Rivera',
  submittedAt: '2026-11-02T21:14:00Z', source: 'phone', status: 'submitted', reviewerEmail: '', reviewedAt: '', reviewNote: '',
  linkedTicketId: '', linkedTaskId: '', linkedAssetId: '', canReview: true, ...over,
});
const ENTRIES = [
  entry(),
  entry({ id: 'e2', templateId: 'f2', title: 'Incident Report', submittedByName: 'Priya Shah', workSiteName: 'Temecula', status: 'follow_up', submittedAt: '2026-11-01T15:00:00Z' }),
];

beforeEach(() => {
  getFormEntries.mockReset().mockResolvedValue({ items: ENTRIES, total: 2, page: 1, pageSize: 50 });
  formTemplateCsv.mockReset().mockResolvedValue({ blob: new Blob(['a,b']), filename: 'vehicle-check.csv' });
  getWorkSites.mockReset().mockResolvedValue([{ id: 's1', name: 'Austin' }, { id: 's2', name: 'Temecula' }]);
  getPeopleDirectory.mockReset().mockResolvedValue([{ email: 'sam@greensglobal.com', name: 'Sam Rivera' }]);
  globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:x');
  globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});
});

describe('Entries list', () => {
  it('lists the entries with form, person, site, time (US) and a soft status word', async () => {
    render(<EntriesList templates={TEMPLATES} onOpen={() => {}} />);
    expect(await cell('Sam Rivera')).toBeTruthy();
    expect(screen.getByText('Priya Shah')).toBeTruthy();
    expect(screen.getByText('Austin', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText('Temecula', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText(formatDateTime('2026-11-02T21:14:00Z'))).toBeTruthy();
    expect(screen.getByText('Submitted', { selector: '.nx-label-text' })).toBeTruthy();
    expect(screen.getByText('Needs Follow-Up', { selector: '.nx-label-text' })).toBeTruthy();
    expect(getFormEntries).toHaveBeenCalledWith({ page: 1 });
    // Every column has a resize handle (house rule).
    expect(screen.getAllByRole('separator').length).toBeGreaterThanOrEqual(5);
  });

  it('filters go to the server; only forms are offered in the Form filter', async () => {
    render(<EntriesList templates={TEMPLATES} onOpen={() => {}} />);
    await cell('Sam Rivera');
    const form = screen.getByLabelText('Form');
    expect(within(form).queryByRole('option', { name: 'Offer Letter' })).toBeNull();
    fireEvent.change(form, { target: { value: 'f1' } });
    await waitFor(() => expect(getFormEntries).toHaveBeenLastCalledWith(expect.objectContaining({ template: 'f1', page: 1 })));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'follow_up' } });
    await waitFor(() => expect(getFormEntries).toHaveBeenLastCalledWith(expect.objectContaining({ template: 'f1', status: 'follow_up' })));
    const site = await screen.findByLabelText('Site');
    fireEvent.change(site, { target: { value: 's2' } });
    await waitFor(() => expect(getFormEntries).toHaveBeenLastCalledWith(expect.objectContaining({ site: 's2' })));
    const person = await screen.findByLabelText('Person');
    fireEvent.change(person, { target: { value: 'sam@greensglobal.com' } });
    await waitFor(() => expect(getFormEntries).toHaveBeenLastCalledWith(expect.objectContaining({ person: 'sam@greensglobal.com' })));
  });

  it('Export CSV needs a form picked, then downloads that form\'s entries', async () => {
    render(<EntriesList templates={TEMPLATES} onOpen={() => {}} />);
    await cell('Sam Rivera');
    const btn = screen.getByRole('button', { name: 'Export CSV' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Form'), { target: { value: 'f2' } });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(formTemplateCsv).toHaveBeenCalledWith('f2', { from: '', to: '', status: '', site: '' }));
  });

  it('a row opens beside the list', async () => {
    const onOpen = vi.fn();
    render(<EntriesList templates={TEMPLATES} onOpen={onOpen} />);
    fireEvent.click(await screen.findByText('Priya Shah'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2' }));
  });

  it('pages when the server has more than one page', async () => {
    getFormEntries.mockResolvedValue({ items: ENTRIES, total: 5, page: 1, pageSize: 2 });
    render(<EntriesList templates={TEMPLATES} onOpen={() => {}} />);
    await cell('Sam Rivera');
    expect(screen.getByText('1-2 of 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(getFormEntries).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it('says so when there are no entries, and when the list cannot load', async () => {
    getFormEntries.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    const { unmount } = render(<EntriesList templates={TEMPLATES} onOpen={() => {}} />);
    expect(await screen.findByText('No entries yet. Entries appear here as people fill forms.')).toBeTruthy();
    unmount();
    getFormEntries.mockRejectedValue(new Error('The server said no'));
    render(<EntriesList templates={TEMPLATES} onOpen={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain('The server said no'));
  });
});
