import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PhoneMenuSheet } from './PhoneBar';

// The phone's Document Menu (Neil, 11/13/2026) is the computer's menu bar as
// one sheet - the same docMenus data, so every command is reachable on a phone
// with no second copy of it.

const make = (onRename, onPdf) => [
  { label: 'File', items: [
    { label: 'Rename', onClick: onRename },
    false,
    '-',
    { label: 'Download', items: [{ label: 'PDF Document (.pdf)', onClick: onPdf }] },
  ] },
  { label: 'Edit', items: [{ label: 'Undo', disabled: true, onClick: () => {} }] },
];

describe('PhoneMenuSheet', () => {
  it('lists the menus, opens one, runs a command and closes', async () => {
    vi.useFakeTimers();
    const onRename = vi.fn(); const onClose = vi.fn();
    render(<PhoneMenuSheet menus={make(onRename, vi.fn())} onClose={onClose} />);
    expect(screen.getByRole('menuitem', { name: 'File' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onClose).toHaveBeenCalled();
    await act(async () => { vi.runAllTimers(); });
    expect(onRename).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('opens straight at a menu, drills into a submenu and goes back', () => {
    render(<PhoneMenuSheet menus={make(vi.fn(), vi.fn())} startAt="File" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    expect(screen.getByRole('menuitem', { name: 'PDF Document (.pdf)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /File/ }));
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
  });

  it('keeps a disabled command disabled', () => {
    render(<PhoneMenuSheet menus={make(vi.fn(), vi.fn())} startAt="Edit" onClose={() => {}} />);
    expect(screen.getByRole('menuitem', { name: 'Undo' }).disabled).toBe(true);
  });
});
