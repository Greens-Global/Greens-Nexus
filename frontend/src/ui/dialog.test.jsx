import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { dialog, DialogHost } from './dialog';

// `minLength` (Oct 23): the Unlock reason needs 5 characters on the server,
// and "jn" failed with only a toast - the prompt now says so and waits.
describe('dialog.prompt minLength', () => {
  it('keeps OK disabled, with a hint, until the text is long enough', async () => {
    render(<DialogHost />);
    let result;
    await act(async () => { result = dialog.prompt('Why?', { confirmText: 'Unlock', required: true, minLength: 5 }); });
    const ok = screen.getByRole('button', { name: 'Unlock' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'jn' } });
    expect(ok.disabled).toBe(true);
    expect(screen.getByText('At least 5 characters (2 so far).')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wrong lunch' } });
    expect(ok.disabled).toBe(false);
    expect(screen.queryByText(/At least 5 characters/)).toBeNull();
    await act(async () => { fireEvent.click(ok); });
    expect(await result).toBe('Wrong lunch');
  });
});

// Boxed: an async function that returned the dialog's promise would wait for it.
const open = async (fn) => { const box = {}; await act(async () => { box.result = fn(); }); return box; };
const settled = async (p) => { let v = 'pending'; p.then((x) => { v = x; }); await act(async () => {}); return v; };

// Enter confirmed the dialog wherever focus sat inside it, Cancel included
// (11/17/2026): Enter on Cancel confirmed a delete, and in a prompt it
// submitted the typed text. A button in focus keeps its own Enter.
describe('Enter in the dialog', () => {
  it('on Cancel does not confirm - the key is left to the button', async () => {
    render(<DialogHost />);
    const { result } = await open(() => dialog.confirm('Delete this view?', { confirmText: 'Delete View' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    // true = nobody called preventDefault, so the browser presses Cancel.
    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true);
    expect(await settled(result)).toBe('pending');
    await act(async () => { fireEvent.click(cancel); });
    expect(await result).toBe(false);
  });

  it('on Cancel does not submit a prompt; in the field it does', async () => {
    render(<DialogHost />);
    let { result } = await open(() => dialog.prompt('Why?'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wrong lunch' } });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(await settled(result)).toBe('pending');
    await act(async () => { fireEvent.click(cancel); });
    expect(await result).toBe(null);

    ({ result } = await open(() => dialog.prompt('Why?')));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Wrong lunch' } });
    box.focus();
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(await result).toBe('Wrong lunch');
  });
});

// A second call while a dialog was open replaced it, and the first caller's
// promise never resolved. Later calls wait their turn.
describe('two dialogs at once', () => {
  it('shows them one after the other and resolves both', async () => {
    render(<DialogHost />);
    const { result: first } = await open(() => dialog.confirm('First question?'));
    const { result: second } = await open(() => dialog.confirm('Second question?'));
    expect(screen.getByText('First question?')).toBeTruthy();
    expect(screen.queryByText('Second question?')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
    expect(await first).toBe(true);
    expect(await screen.findByText('Second question?')).toBeTruthy();
    expect(screen.queryByText('First question?')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(await second).toBe(false);
  });
});

// The keys worked only while focus was inside the card: click the message,
// press Escape, and the sheet underneath closed while the confirm stayed.
describe('the dialog keeps its keys and its focus', () => {
  it('Escape and Enter work with focus outside the card, and nothing under it hears Escape', async () => {
    const under = vi.fn();
    window.addEventListener('keydown', under);
    render(<DialogHost />);
    let { result } = await open(() => dialog.confirm('Delete this view?'));
    document.body.focus();
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(await result).toBe(false);
    expect(under).not.toHaveBeenCalled();
    window.removeEventListener('keydown', under);

    ({ result } = await open(() => dialog.confirm('Delete this view?')));
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Enter' }); });
    expect(await result).toBe(true);
  });

  it('keeps Tab inside the card', async () => {
    render(<DialogHost />);
    await open(() => dialog.confirm('Delete this view?'));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const ok = screen.getByRole('button', { name: 'Confirm' });
    ok.focus();
    fireEvent.keyDown(ok, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ok);
    // From the page under the dialog, Tab comes in.
    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    await act(async () => { fireEvent.click(cancel); });
  });

  it('gives focus back to the button that opened it', async () => {
    render(<><button type="button">Delete View</button><DialogHost /></>);
    const opener = screen.getByRole('button', { name: 'Delete View' });
    opener.focus();
    const { result } = await open(() => dialog.confirm('Delete this view?'));
    const ok = screen.getByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(document.activeElement).toBe(ok));
    await act(async () => { fireEvent.click(ok); });
    expect(await result).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});
