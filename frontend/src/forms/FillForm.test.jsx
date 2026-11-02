import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Fill a Form (Forms & Checklists, Neil 11/02/2026). Review Focus 1: a
// showIf field hidden at submit time is neither required nor sent. Review
// Focus 4: Submit sends once, and a retry carries the same entryKey. Plus
// the repeat group, the draft that is offered back, the photo upload into
// forms/<entryKey>, and the server's 422 landing on its field.

const formGet = vi.fn();
const formSubmit = vi.fn();
const storeTaskFile = vi.fn();
const getPosition = vi.fn();
vi.mock('../api', () => ({ api: { formGet: (...a) => formGet(...a), formSubmit: (...a) => formSubmit(...a) } }));
vi.mock('../tasks/lib', async (orig) => ({ ...(await orig()), storeTaskFile: (...a) => storeTaskFile(...a) }));
vi.mock('../tasks/components', async (orig) => ({
  ...(await orig()),
  DateField: ({ value, onChange, title }) => <input aria-label={title || 'date'} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock('../components/ESign', () => ({
  SignaturePad: ({ onAdopt, onClose }) => (
    <div>
      <button type="button" onClick={() => onAdopt({ kind: 'drawn', data: 'data:image/png;base64,iVBORw0KGgo=' })}>Adopt</button>
      <button type="button" onClick={onClose}>Close Pad</button>
    </div>
  ),
}));
const mode = vi.hoisted(() => ({ phone: false }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => mode.phone }));
vi.mock('../lib/geoPosition', () => ({ getPosition: (...a) => getPosition(...a) }));

const FillForm = (await import('./FillForm')).default;

const TEMPLATE = {
  id: 't1', title: 'Vehicle Check', category: 'vehicle', description: 'Before you drive.', version: 3,
  sections: ['Vehicle', 'Damage', 'Tires'],
  workSites: [{ id: 's1', name: 'Austin', lat: 30.2672, lng: -97.7431 }, { id: 's2', name: 'Temecula', lat: 33.4936, lng: -117.1484 }],
  fieldDefs: [
    { token: 'plate', label: 'Plate', type: 'text', required: true, section: 'Vehicle' },
    { token: 'damage', label: 'Any Damage?', type: 'yesno', required: true, section: 'Damage' },
    { token: 'damage_detail', label: 'Describe the Damage', type: 'multiline', required: true, section: 'Damage',
      showIf: { token: 'damage', op: 'eq', value: true } },
    { token: 'photos', label: 'Photos', type: 'photo', section: 'Damage' },
    { token: 'where', label: 'Where', type: 'gps', section: 'Damage' },
    { token: 'signed', label: 'Signature', type: 'signature', section: 'Damage' },
    { token: 'tire', label: 'Tire', type: 'text', section: 'Tires', repeat: { group: 'tires', max: 4 } },
    { token: 'psi', label: 'PSI', type: 'number', section: 'Tires', repeat: { group: 'tires', max: 4 } },
  ],
};
const ENTRY = { id: 'e1', templateId: 't1', title: 'Vehicle Check', status: 'submitted' };
const UUID_RE = /^[0-9a-f-]{20,}$/i;

const typeIn = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

beforeEach(() => {
  mode.phone = false;
  localStorage.clear();
  formGet.mockReset().mockResolvedValue(TEMPLATE);
  formSubmit.mockReset().mockResolvedValue(ENTRY);
  storeTaskFile.mockReset().mockResolvedValue('https://x.supabase.co/storage/v1/object/public/task-files/forms/k/p.png');
  getPosition.mockReset().mockResolvedValue({ lat: '30.2680', lng: '-97.7420', accuracy_m: 12 });
});

describe('FillForm', () => {
  it('a showIf field hidden at submit time is not required and not sent, even with a stale value', async () => {
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    typeIn('Describe the Damage', 'a scratch');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByLabelText('Describe the Damage')).toBeNull();
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(1));
    const [tid, body] = formSubmit.mock.calls[0];
    expect(tid).toBe('t1');
    expect(body.answers).toMatchObject({ plate: 'ABC123', damage: false });
    expect('damage_detail' in body.answers).toBe(false);
    expect(body.source).toBe('web');
    expect(await screen.findByText(/Sent/)).toBeTruthy();
  });

  it('a visible required showIf field blocks Submit with an inline message', async () => {
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    submit();
    expect(await screen.findAllByText('This field is required')).toHaveLength(1);
    expect(formSubmit).not.toHaveBeenCalled();
  });

  it('a repeat group adds and removes rows and is sent as a list of maps', async () => {
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: /Add Another Tires/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add Another Tires/ }));
    const tires = screen.getAllByLabelText('Tire');
    expect(tires).toHaveLength(2);
    // The group's one name (its section): "Tires 1", "Tires 2", "Add Another Tires".
    expect(screen.getByText('Tires 1')).toBeTruthy();
    expect(screen.getByText('Tires 2')).toBeTruthy();
    fireEvent.change(tires[0], { target: { value: 'FL' } });
    fireEvent.change(screen.getAllByLabelText('PSI')[0], { target: { value: '32' } });
    fireEvent.change(tires[1], { target: { value: 'RR' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[1]);
    expect(screen.getAllByLabelText('Tire')).toHaveLength(1);
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(1));
    expect(formSubmit.mock.calls[0][1].answers.tires).toEqual([{ tire: 'FL', psi: '32' }]);
  });

  it('keeps a draft in localStorage and offers it back with Continue / Discard', async () => {
    const first = render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'DRAFT1');
    await waitFor(() => expect(localStorage.getItem('nexus.formDraft.t1') || '').toContain('DRAFT1'));
    const saved = JSON.parse(localStorage.getItem('nexus.formDraft.t1'));
    expect(saved.entryKey).toMatch(UUID_RE);
    first.unmount();

    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    expect(screen.getByText(/You have an unsent Vehicle Check from \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Plate')).toHaveValue('DRAFT1');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(1));
    // The continued draft keeps its entryKey, and a sent form leaves no draft behind.
    expect(formSubmit.mock.calls[0][1].entryKey).toBe(saved.entryKey);
    await waitFor(() => expect(localStorage.getItem('nexus.formDraft.t1')).toBeNull());
  });

  it('Discard throws the draft away', async () => {
    localStorage.setItem('nexus.formDraft.t1', JSON.stringify({ entryKey: 'old-key-1234567890', title: 'Vehicle Check', savedAt: '2026-11-02T21:14:00Z', answers: { plate: 'OLD' } }));
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(/You have an unsent/)).toBeNull();
    expect(localStorage.getItem('nexus.formDraft.t1')).toBeNull();
    expect(screen.getByLabelText('Plate')).toHaveValue('');
  });

  it('Submit sends once; a failed send can be retried and carries the same entryKey', async () => {
    let release;
    formSubmit.mockImplementationOnce(() => new Promise((_, reject) => { release = () => reject(new Error('network')); }));
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    // Three taps before React repaints: the ref guard (and then the disabled
    // "Sending..." button) let exactly one request out.
    const go = screen.getByRole('button', { name: 'Submit' });
    fireEvent.click(go); fireEvent.click(go); fireEvent.click(go);
    expect(formSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled();
    await act(async () => { release(); });
    expect(await screen.findByText(/network/)).toBeTruthy();
    // The draft is still there for the retry.
    expect(localStorage.getItem('nexus.formDraft.t1') || '').toContain('ABC123');
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(2));
    const k1 = formSubmit.mock.calls[0][1].entryKey;
    const k2 = formSubmit.mock.calls[1][1].entryKey;
    expect(k1).toMatch(UUID_RE);
    expect(k2).toBe(k1);
    expect(await screen.findByText(/Sent/)).toBeTruthy();
  });

  it("the server's refusal lands on its fields - a top-level token and a repeat row's", async () => {
    // routers/forms.py: 400, detail {message, errors: [{token, message}]}, row tokens as "tires[1].psi".
    const err = new Error('Check the form'); err.status = 400;
    err.detail = { message: 'Check the form', errors: [{ token: 'plate', message: 'Bad plate' }, { token: 'tires[1].psi', message: 'Too high' }] };
    formSubmit.mockRejectedValueOnce(err);
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.click(screen.getByRole('button', { name: /Add Another Tires/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add Another Tires/ }));
    fireEvent.change(screen.getAllByLabelText('Tire')[0], { target: { value: 'FL' } });
    fireEvent.change(screen.getAllByLabelText('Tire')[1], { target: { value: 'RR' } });
    submit();
    expect(await screen.findByText('Bad plate')).toBeTruthy();
    expect(screen.getByText('Too high')).toBeTruthy();
    expect(screen.getByText(/Some answers were refused/)).toBeTruthy();
  });

  it('uploads a photo as taken into forms/<entryKey> and sends its URL', async () => {
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    // The sheet portals to document.body.
    const cam = document.querySelector('input[type="file"][capture="environment"][accept="image/*"]');
    expect(cam).toBeTruthy();
    const file = new File(['x'], 'shot.jpg', { type: 'image/jpeg' });
    fireEvent.change(cam, { target: { files: [file] } });
    await waitFor(() => expect(storeTaskFile).toHaveBeenCalledTimes(1));
    const [sentFile, , folder] = storeTaskFile.mock.calls[0];
    expect(sentFile).toBe(file);
    expect(folder).toMatch(/^forms\/[0-9a-f-]{20,}$/i);
    await screen.findByAltText(/Photo 1/);
    expect(screen.getByText(/or press Ctrl\+V/)).toBeTruthy();
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(1));
    const body = formSubmit.mock.calls[0][1];
    expect(folder).toBe(`forms/${body.entryKey}`);
    expect(body.answers.photos).toEqual(['https://x.supabase.co/storage/v1/object/public/task-files/forms/k/p.png']);
  });

  it('stamps a location with the nearest site name, and uploads an adopted signature', async () => {
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.click(screen.getByRole('button', { name: /Stamp My Location/ }));
    expect(await screen.findByText(/Austin/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sign$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt' }));
    await waitFor(() => expect(storeTaskFile).toHaveBeenCalledTimes(1));
    expect(storeTaskFile.mock.calls[0][0].name).toMatch(/\.png$/);
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(1));
    const a = formSubmit.mock.calls[0][1].answers;
    expect(a.where).toMatchObject({ lat: 30.268, lng: -97.742, accuracyM: 12, siteName: 'Austin' });
    expect(a.signed).toMatch(/^https:/);
  });

  it('preview mode never sends', async () => {
    render(<FillForm template={TEMPLATE} preview onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    expect(formGet).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.getByText(/Preview/)).toBeTruthy();
  });

  it('on a phone the chips, Yes / No and the rating stars are 44px tap targets', async () => {
    mode.phone = true;
    const tpl = { ...TEMPLATE, fieldDefs: [...TEMPLATE.fieldDefs, { token: 'score', label: 'Score', type: 'rating', section: 'Damage' }] };
    render(<FillForm template={tpl} onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    for (const name of ['Yes', 'No', 'Take a Photo', 'Upload', 'Stamp My Location', 'Sign', '3 of 5']) {
      expect(screen.getByRole('button', { name })).toHaveStyle({ minHeight: '44px' });
    }
    expect(screen.getByRole('button', { name: '3 of 5' })).toHaveStyle({ padding: '9px' });
  });

  it('a location that does not answer says how to turn it on', async () => {
    getPosition.mockResolvedValue(null);
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    fireEvent.click(screen.getByRole('button', { name: 'Stamp My Location' }));
    expect(await screen.findByText('Location is off or did not answer. Allow location for Nexus in your browser settings, then tap Stamp My Location again.')).toBeTruthy();
  });

  it('with one work site the entry is at that site without asking', async () => {
    formGet.mockResolvedValue({ ...TEMPLATE, workSites: [TEMPLATE.workSites[0]] });
    render(<FillForm templateId="t1" onClose={() => {}} />);
    await screen.findByText('Vehicle Check');
    expect(screen.queryByText('Work Site')).toBeNull();
    typeIn('Plate', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    submit();
    await waitFor(() => expect(formSubmit).toHaveBeenCalledTimes(1));
    expect(formSubmit.mock.calls[0][1].workSiteId).toBe('s1');
  });
});
