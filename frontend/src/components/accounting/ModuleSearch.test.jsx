import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ModuleSearch from './ModuleSearch';

// The top-right ledger search on every Accounting screen (chat 10/26, item
// 13 - Urmi, after Viral: "make only icons as Search and when press CTR + F
// it will open"): an icon; a click or Ctrl+F opens it with the cursor in it;
// Escape closes it and keeps the words.

function Shell({ onSubmit = () => {}, initial = '' }) {
  const [text, setText] = useState(initial);
  return (
    <>
      <ModuleSearch value={text} onChange={setText} onSubmit={onSubmit} />
      <output data-testid="text">{text}</output>
    </>
  );
}

const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r())));
const ctrlF = () => fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

describe('ModuleSearch', () => {
  it('is an icon until clicked, then a box with the cursor in it', async () => {
    render(<Shell />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search the Ledger' }));
    await flush();
    const box = screen.getByRole('textbox', { name: 'Search the ledger' });
    expect(document.activeElement).toBe(box);
    expect(box.placeholder).toBe('Search vendor, customer, invoice, amount, memo...');
  });

  it('opens on Ctrl+F and blocks the browser find', async () => {
    render(<Shell />);
    let ev;
    act(() => { ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search the ledger' }));
  });

  it('closes on Escape and keeps the words; the icon stays lit and reopens with them', async () => {
    render(<Shell />);
    ctrlF();
    await flush();
    const box = screen.getByRole('textbox', { name: 'Search the ledger' });
    fireEvent.change(box, { target: { value: 'home depot' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('text').textContent).toBe('home depot');
    const icon = screen.getByRole('button', { name: 'Search the Ledger' });
    expect(icon.title).toContain('home depot');
    fireEvent.click(icon);
    await flush();
    expect(screen.getByRole('textbox', { name: 'Search the ledger' }).value).toBe('home depot');
  });

  it('submits the words on Enter, as before', async () => {
    const onSubmit = vi.fn();
    render(<Shell onSubmit={onSubmit} />);
    ctrlF();
    await flush();
    const box = screen.getByRole('textbox', { name: 'Search the ledger' });
    fireEvent.change(box, { target: { value: 'invoice 1001' } });
    fireEvent.submit(box.closest('form'));
    expect(onSubmit).toHaveBeenCalledWith('invoice 1001');
  });

  it('closes when left empty', async () => {
    render(<Shell />);
    ctrlF();
    await flush();
    fireEvent.blur(screen.getByRole('textbox', { name: 'Search the ledger' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it("leaves Ctrl+F to a screen's own search (Vendors & Customers) whatever order they listen in", async () => {
    // Registered AFTER the module search, like a list mounted on a later screen.
    function ScreenSearch({ onOpen }) {
      useEffect(() => {
        const k = (e) => { if (e.ctrlKey && e.key === 'f') { e.preventDefault(); onOpen(); } };
        window.addEventListener('keydown', k);
        return () => window.removeEventListener('keydown', k);
      }, [onOpen]);
      return null;
    }
    const onOpen = vi.fn();
    const { rerender } = render(<Shell />);
    rerender(<><Shell /><ScreenSearch onOpen={onOpen} /></>);
    ctrlF();
    await flush();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('leaves Ctrl+F to the browser while a popup is open', async () => {
    render(<><Shell /><div role="dialog" aria-modal="true">Entry</div></>);
    let ev;
    act(() => { ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); });
    await flush();
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
