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
