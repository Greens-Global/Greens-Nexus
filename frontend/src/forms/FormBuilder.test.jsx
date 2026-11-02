import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// Documents > Forms > Build (Neil, 11/02/2026): a form is a template with
// docType 'form'; this is its field list - sections, the form-only types and
// keys through the one field editor, order, audience, Preview, Publish.

const getDocTemplate = vi.fn();
const updateDocTemplate = vi.fn();
const publishDocTemplate = vi.fn();
const getWorkSites = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDocTemplate: (...a) => getDocTemplate(...a),
    updateDocTemplate: (...a) => updateDocTemplate(...a),
    publishDocTemplate: (...a) => publishDocTemplate(...a),
    getWorkSites: (...a) => getWorkSites(...a),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myEmail: 'neil@greensglobal.com' }) }));

const FormBuilder = (await import('./FormBuilder')).default;

const FORM = {
  id: 'f1', name: 'Vehicle Check', docType: 'form', category: 'vehicle', department: '', audience: 'company', workSiteId: '', showOnShifts: 0,
  status: 'draft', state: 'draft', version: 1, publishedVersion: 0, tags: [],
  fieldDefs: [
    { token: 'odometer', label: 'Odometer', type: 'number', section: 'Vehicle', required: true },
    { token: 'damage', label: 'Any Damage?', type: 'yesno', section: 'Vehicle' },
  ],
};

beforeEach(() => {
  getDocTemplate.mockReset().mockResolvedValue(FORM);
  updateDocTemplate.mockReset().mockImplementation((id, patch) => Promise.resolve({ ...FORM, ...patch }));
  publishDocTemplate.mockReset().mockResolvedValue({ ...FORM, state: 'published', publishedVersion: 1 });
  getWorkSites.mockReset().mockResolvedValue([{ id: 's1', name: 'Austin' }, { id: 's2', name: 'Temecula' }]);
});

const open = () => render(<FormBuilder templateId="f1" onClose={() => {}} toastOk={() => {}} toastErr={() => {}} />);
const saveForm = () => fireEvent.click(screen.getByRole('button', { name: 'Save Form' }));
const lastPatch = () => updateDocTemplate.mock.calls.at(-1)[1];

describe('Form builder', () => {
  it('lists the fields under their section with the type in words', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Vehicle' })).toBeTruthy();
    expect(screen.getByText('Odometer')).toBeTruthy();
    expect(screen.getByText('Number')).toBeTruthy();
    expect(screen.getByText('Yes / No')).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
  });

  it('adds a photo field shown only when an earlier answer says so, through the one field editor', async () => {
    open();
    await screen.findByText('Odometer');
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Field' });
    const type = within(dialog).getByLabelText('Field Type');
    for (const t of ['Photo', 'Location Stamp', 'QR Scan', 'Rating', 'Yes / No', 'Signature']) expect(within(type).getByRole('option', { name: t })).toBeTruthy();
    // A form has no HR packet - the "who fills it" block stays off it.
    expect(within(dialog).queryByLabelText('Who fills it')).toBeNull();
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Contractor Name'), { target: { value: 'Damage Photos' } });
    fireEvent.change(type, { target: { value: 'photo' } });
    fireEvent.change(within(dialog).getByLabelText('Section'), { target: { value: 'Vehicle' } });
    fireEvent.change(within(dialog).getByLabelText('Show Only When'), { target: { value: 'damage' } });
    fireEvent.change(within(dialog).getByLabelText('Show-when value'), { target: { value: 'true' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Field' })).toBeNull());
    expect(screen.getByText('Damage Photos')).toBeTruthy();
    expect(screen.getByText('Shown when Any Damage? is Yes')).toBeTruthy();
    saveForm();
    await waitFor(() => expect(updateDocTemplate).toHaveBeenCalled());
    const added = lastPatch().fieldDefs.find((f) => f.token === 'damage_photos');
    expect(added).toMatchObject({ type: 'photo', section: 'Vehicle', showIf: { token: 'damage', op: 'eq', value: true } });
  });

  it('a repeating group and a formula are kept on the field', async () => {
    open();
    await screen.findByText('Odometer');
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Field' });
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Contractor Name'), { target: { value: 'Tire PSI' } });
    fireEvent.change(within(dialog).getByLabelText('Field Type'), { target: { value: 'number' } });
    fireEvent.change(within(dialog).getByLabelText('Section'), { target: { value: 'Tires' } });
    fireEvent.change(within(dialog).getByLabelText('Repeat Group'), { target: { value: 'tires' } });
    fireEvent.change(within(dialog).getByLabelText('Repeat up to'), { target: { value: '6' } });
    fireEvent.change(within(dialog).getByLabelText('Formula'), { target: { value: 'field("odometer") / 1000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Tires' })).toBeTruthy());
    saveForm();
    await waitFor(() => expect(updateDocTemplate).toHaveBeenCalled());
    const added = lastPatch().fieldDefs.find((f) => f.token === 'tire_psi');
    expect(added).toMatchObject({ section: 'Tires', repeat: { group: 'tires', max: 6 }, formula: 'field("odometer") / 1000' });
  });

  it('moves and removes fields; the order is what is saved', async () => {
    open();
    await screen.findByText('Odometer');
    fireEvent.click(screen.getByRole('button', { name: 'Move Odometer down' }));
    saveForm();
    await waitFor(() => expect(updateDocTemplate).toHaveBeenCalled());
    expect(lastPatch().fieldDefs.map((f) => f.token)).toEqual(['damage', 'odometer']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Odometer' }));
    expect(screen.queryByText('Odometer')).toBeNull();
    saveForm();
    await waitFor(() => expect(updateDocTemplate).toHaveBeenCalledTimes(2));
    expect(lastPatch().fieldDefs.map((f) => f.token)).toEqual(['damage']);
  });

  it('audience: one work site, shown on that site\'s shift cards', async () => {
    open();
    await screen.findByText('Odometer');
    fireEvent.change(screen.getByLabelText('Who fills it'), { target: { value: 'site' } });
    fireEvent.change(await screen.findByLabelText('Work site'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Show On Shift Cards' }));
    saveForm();
    await waitFor(() => expect(updateDocTemplate).toHaveBeenCalled());
    expect(lastPatch()).toMatchObject({ audience: 'site', workSiteId: 's1', showOnShifts: 1 });
  });

  it('audience: one department is the department that maintains it', async () => {
    open();
    await screen.findByText('Odometer');
    fireEvent.change(screen.getByLabelText('Who fills it'), { target: { value: 'department' } });
    fireEvent.change(await screen.findByLabelText('Department'), { target: { value: 'Construction' } });
    saveForm();
    await waitFor(() => expect(lastPatch()).toMatchObject({ audience: 'department', department: 'Construction' }));
  });

  it('Publish releases the form through the template publish', async () => {
    const toastOk = vi.fn();
    render(<FormBuilder templateId="f1" onClose={() => {}} toastOk={toastOk} toastErr={() => {}} />);
    await screen.findByText('Odometer');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publishDocTemplate).toHaveBeenCalledWith('f1'));
    expect(toastOk).toHaveBeenCalledWith('Published');
  });

  it('Preview falls back to a note until the fill screen ships', async () => {
    open();
    await screen.findByText('Odometer');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Preview is coming with the fill screen.')).toBeTruthy();
  });

  it('refuses a template that is not a form', async () => {
    getDocTemplate.mockResolvedValue({ ...FORM, docType: 'document' });
    open();
    expect(await screen.findByText('This template is a document, not a form. Open it under Templates.')).toBeTruthy();
  });
});
