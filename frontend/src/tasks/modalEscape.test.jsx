import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { Modal } from './components';

// Escape belongs to the topmost layer only (Oct 2026 ticket review): a dialog
// stacked over the ticket drawer (Resolve, Save View) used to close the drawer
// too, because every Modal listened on window.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

afterEach(() => cleanup());

function Stack({ onOuter, onInner, nested = false }) {
  const [inner, setInner] = useState(true);
  const innerModal = inner && (
    <Modal title="Resolve Ticket" onClose={() => { setInner(false); onInner(); }}><p>inner</p></Modal>
  );
  return (
    <>
      <Modal title="Ticket #1" onClose={onOuter}><p>outer</p>{nested && innerModal}</Modal>
      {!nested && innerModal}
    </>
  );
}

describe('Escape with stacked modals', () => {
  it('closes only the dialog on top, then the one under it', async () => {
    const onOuter = vi.fn(); const onInner = vi.fn();
    render(<Stack onOuter={onOuter} onInner={onInner} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onInner).toHaveBeenCalledTimes(1));
    expect(onOuter).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('inner')).toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onOuter).toHaveBeenCalledTimes(1));
  });

  it('treats a dialog rendered inside another, mounted in the same commit, as the top one', async () => {
    const onOuter = vi.fn(); const onInner = vi.fn();
    render(<Stack nested onOuter={onOuter} onInner={onInner} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onInner).toHaveBeenCalledTimes(1));
    expect(onOuter).not.toHaveBeenCalled();
  });

  it('leaves an Escape something else already handled alone', async () => {
    const onClose = vi.fn();
    render(<Modal title="Ticket #1" onClose={onClose}><p>body</p></Modal>);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ev.preventDefault();
    await act(async () => { window.dispatchEvent(ev); });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// A text selection dragged from inside the sheet and let go on the scrim: the
// browser sends that click to the scrim (the common ancestor), and the sheet
// closed. Only a press that STARTED on the scrim closes it (11/17/2026).
describe('a click on the scrim', () => {
  const scrim = () => document.querySelector('.nx-tasks-portal.nx-overlay');

  it('does not close when the press began inside the sheet', () => {
    const onClose = vi.fn();
    render(<Modal title="New Lead" onClose={onClose}><input aria-label="Name" defaultValue="Sam Lee" /></Modal>);
    fireEvent.mouseDown(screen.getByLabelText('Name'));
    fireEvent.mouseUp(scrim());
    fireEvent.click(scrim());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the press began on the scrim', () => {
    const onClose = vi.fn();
    render(<Modal title="New Lead" onClose={onClose}><input aria-label="Name" /></Modal>);
    fireEvent.mouseDown(scrim());
    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// "Save your changes?" sat outside the panel's Tab trap and never took focus,
// so a keyboard could not reach it, and Escape only asked again (11/17/2026).
describe('the Save your changes? card', () => {
  it('takes focus, keeps Tab, and Escape is Keep Editing', async () => {
    const onClose = vi.fn();
    render(<Modal title="Edit Lead" onClose={onClose} isDirty onSave={() => {}}><input aria-label="Name" /></Modal>);
    const field = screen.getByLabelText('Name');
    field.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    const keep = await screen.findByRole('button', { name: 'Keep Editing' });
    expect(document.activeElement).toBe(keep);
    const save = screen.getByRole('button', { name: 'Save Changes' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Save your changes?')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });
});

