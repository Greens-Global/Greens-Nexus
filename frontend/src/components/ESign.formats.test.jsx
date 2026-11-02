import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Federal forms in Nexus Sign (Neil, 11/02/2026): a bad value answers 422
// {detail: {field, message}} - the message shows under that field, not as a
// toast; a sensitive value another party filled arrives masked from the
// server and is shown as given.
const api = vi.hoisted(() => ({
  mySignRender: vi.fn(),
  mySignSubmit: vi.fn(),
  mySignHistory: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../api', () => ({ api }));

const { SignModal, OtherPartyField } = await import('./ESign');

const PAYLOAD = {
  id: 'r1', title: 'Form W-4', status: 'pending', source: 'template', myTurn: true, myRole: 'a', myPartyRole: 'signer',
  myName: 'Jane Doe', consentAt: '2026-11-02T10:00:00Z', mySignature: { kind: 'typed', data: 'Jane Doe' },
  body: ['Social Security Number: [[text:a:SSN]]', 'Signed: [[sign:a]]'],
  parties: [{ roleKey: 'a', name: 'Jane Doe', status: 'viewed' }],
};

beforeEach(() => {
  api.mySignRender.mockReset().mockResolvedValue(PAYLOAD);
  api.mySignSubmit.mockReset();
});

describe('Nexus Sign - field formats', () => {
  it('shows a 422 field message under the field instead of a toast', async () => {
    const err = new Error('That is not a valid Social Security number.');
    err.status = 422;
    err.detail = { field: 'text:SSN', message: 'That is not a valid Social Security number.' };
    api.mySignSubmit.mockRejectedValue(err);
    const toastErr = vi.fn();
    const onDone = vi.fn();
    render(<SignModal partyId="p1" onClose={vi.fn()} onDone={onDone} toastOk={vi.fn()} toastErr={toastErr} />);
    const box = await screen.findByPlaceholderText('SSN');
    fireEvent.change(box, { target: { value: '000-12-3456' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Finish/ })[0]);
    await waitFor(() => expect(api.mySignSubmit).toHaveBeenCalled());
    expect(api.mySignSubmit.mock.calls[0][1].field_values).toEqual({ 'text:SSN': '000-12-3456' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('That is not a valid Social Security number.');
    // ... and once more in the pinned Finish bar, so a signer on page 1 of a
    // 5-page form sees it without finding the field first (a plain repeat, not a second alert).
    const bar = screen.getByTestId('finish-bar');
    expect(screen.getByTestId('finish-bar-error').textContent).toBe('That is not a valid Social Security number.');
    expect(bar.contains(screen.getByTestId('finish-bar-error'))).toBe(true);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(toastErr).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    // Typing in that field clears the message - in both places.
    fireEvent.change(box, { target: { value: '123-45-6789' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('finish-bar-error')).toBeNull();
  });

  it('still toasts an ordinary refusal', async () => {
    api.mySignSubmit.mockRejectedValue(new Error('Not your turn.'));
    const toastErr = vi.fn();
    render(<SignModal partyId="p1" onClose={vi.fn()} onDone={vi.fn()} toastOk={vi.fn()} toastErr={toastErr} />);
    await screen.findByPlaceholderText('SSN');
    fireEvent.click(screen.getAllByRole('button', { name: /Finish/ })[0]);
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith('Not your turn.'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows another party\'s sensitive value exactly as the server masked it', () => {
    const payload = { parties: [{ roleKey: 'employee', name: 'Ana Diaz' }], filledByOthers: { ssn: '***-**-1234', acct: '••••4321' }, signedByRole: {} };
    render(<>
      <OtherPartyField field={{ id: 'ssn', type: 'text', role: 'employee', format: 'ssn', sensitive: true }} style={{}} payload={payload} />
      <OtherPartyField field={{ id: 'acct', type: 'text', role: 'employee', format: 'account', sensitive: true }} style={{}} payload={payload} />
    </>);
    expect(screen.getByText('***-**-1234').getAttribute('title')).toBe('Ana Diaz - shown masked');
    expect(screen.getByText('••••4321')).toBeTruthy();
  });
});
