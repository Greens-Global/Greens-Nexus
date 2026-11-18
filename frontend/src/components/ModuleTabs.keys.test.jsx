import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TabGroupButton } from './ModuleTabs';

// A header tab's dropdown from the keyboard. Enter used to open the menu and
// leave focus on the tab, with no way into its rows. Now: opened by a key,
// focus goes to the first row; Up / Down / Home / End walk the rows; Right
// opens a flyout and Left closes it; Escape and a pick return focus to the
// tab. A pointer opens it exactly as before - focus does not move.

afterEach(cleanup);

const TAB = { key: 'reports', label: 'Reports', items: [
  { key: 'r-a', label: 'Aging' },
  { key: 'r-f', label: 'Financial', items: [{ key: 'r-is', label: 'Income Statement' }, { key: 'r-bs', label: 'Balance Sheet' }] },
  { key: 'r-z', label: 'Budgets' },
] };
const setup = (onSelect = vi.fn()) => {
  render(<TabGroupButton tab={TAB} active="overview" onSelect={onSelect} className="hdr-tab" />);
  return { tab: screen.getByRole('button', { name: /Reports/ }), onSelect };
};
// A real Enter on a button: keydown, then the click the browser makes of it.
const enter = (el) => { fireEvent.keyDown(el, { key: 'Enter' }); fireEvent.click(el); };
const focused = () => document.activeElement?.textContent;

describe('header tab dropdown - keyboard', () => {
  it('Enter opens it on its first row; the arrows, Home and End walk the rows', () => {
    const { tab } = setup();
    tab.focus();
    enter(tab);
    expect(focused()).toBe('Aging');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(focused()).toBe('Financial');
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(focused()).toBe('Budgets');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });   // wraps
    expect(focused()).toBe('Aging');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });     // wraps
    expect(focused()).toBe('Budgets');
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(focused()).toBe('Aging');
  });

  it('the Down arrow opens it too, without opening the tab', () => {
    const { tab, onSelect } = setup();
    tab.focus();
    fireEvent.keyDown(tab, { key: 'ArrowDown' });
    expect(screen.getByRole('menu', { name: 'Reports' })).toBeTruthy();
    expect(focused()).toBe('Aging');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape closes it and returns focus to the tab', () => {
    const { tab } = setup();
    tab.focus();
    enter(tab);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(tab);
  });

  it('Enter on a row picks it and returns focus to the tab', () => {
    const { tab, onSelect } = setup();
    tab.focus();
    enter(tab);
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    fireEvent.click(document.activeElement);
    expect(onSelect).toHaveBeenCalledWith('r-z');
    expect(document.activeElement).toBe(tab);
  });

  it('Right opens a flyout on its first row, the arrows stay inside it, Left closes it back to its row', () => {
    const { tab, onSelect } = setup();
    tab.focus();
    enter(tab);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    const row = document.activeElement;
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(focused()).toBe('Income Statement');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(focused()).toBe('Balance Sheet');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });   // wraps inside the flyout
    expect(focused()).toBe('Income Statement');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('menu', { name: 'Reports' })).toBeTruthy();   // the menu itself stays
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    fireEvent.click(document.activeElement);
    expect(onSelect).toHaveBeenCalledWith('r-bs');
  });

  it('Tab closes it with focus back on the tab', () => {
    const { tab } = setup();
    tab.focus();
    enter(tab);
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(tab);
  });

  it('a pointer opens it as before: focus does not move into the menu', () => {
    const { tab, onSelect } = setup();
    tab.focus();
    fireEvent.pointerDown(tab);
    fireEvent.click(tab);
    expect(screen.getByRole('menu', { name: 'Reports' })).toBeTruthy();
    expect(document.activeElement).toBe(tab);
    fireEvent.click(screen.getByText('Aging'));
    expect(onSelect).toHaveBeenCalledWith('r-a');
  });
});
