import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import MenuBar, { ShortcutsCard, flattenMenus, shortcutText } from './MenuBar';

// The document's menu bar (Neil, 11/10/2026: "make the menu better").

afterEach(cleanup);

const make = (bold = vi.fn(), pdf = vi.fn()) => [
  { label: 'File', items: [{ label: 'Download', items: [{ label: 'PDF Document (.pdf)', onClick: pdf }] }, '-', { label: 'Print', shortcut: 'Mod+P', onClick: () => {} }] },
  { label: 'Format', items: [{ label: 'Bold', shortcut: 'Mod+B', checked: true, onClick: bold }, { label: 'Disabled Thing', disabled: true, onClick: () => {} }] },
];

describe('MenuBar', () => {
  it('opens a menu, shows ticks and shortcuts, runs an item and closes', async () => {
    const bold = vi.fn();
    render(<MenuBar menus={make(bold)} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Format' }));
    const item = await screen.findByRole('menuitemcheckbox', { name: /Bold/ });
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(item.textContent).toMatch(/Ctrl\+B/);
    expect(screen.getByRole('menuitem', { name: /Disabled Thing/ }).disabled).toBe(true);
    fireEvent.click(item);
    expect(bold).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menuitemcheckbox', { name: /Bold/ })).toBeNull());
  });

  it('opens a submenu beside its item', async () => {
    const pdf = vi.fn();
    render(<MenuBar menus={make(vi.fn(), pdf)} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Download/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /PDF Document/ }));
    expect(pdf).toHaveBeenCalled();
  });

  it('once a menu is open, pointing at another opens it', async () => {
    render(<MenuBar menus={make()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    await screen.findByRole('menuitem', { name: /Print/ });
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'Format' }));
    expect(await screen.findByRole('menuitemcheckbox', { name: /Bold/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Print/ })).toBeNull();
  });

  it('searches every command, submenus included, and runs the first on Enter', async () => {
    const pdf = vi.fn();
    render(<MenuBar menus={make(vi.fn(), pdf)} />);
    const box = screen.getByLabelText('Search the menus');
    fireEvent.change(box, { target: { value: 'pdf' } });
    expect((await screen.findByRole('menuitem', { name: /PDF Document/ })).textContent).toMatch(/File › Download/);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(pdf).toHaveBeenCalled();
  });

  it('lists the shortcuts by menu, and finds commands inside submenus', () => {
    const menus = make();
    expect(flattenMenus(menus).map((c) => c.label)).toEqual(['PDF Document (.pdf)', 'Print', 'Bold', 'Disabled Thing']);
    expect(shortcutText('Mod+Shift+V')).toBe('Ctrl+Shift+V');
    render(<ShortcutsCard menus={menus} onClose={() => {}} />);
    const card = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    expect(card.textContent).toMatch(/PrintCtrl\+P/);
    expect(card.textContent).toMatch(/BoldCtrl\+B/);
  });
});
