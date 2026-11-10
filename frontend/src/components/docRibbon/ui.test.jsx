import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { Menu, Group, BigBtn, RibbonBar, PickList, SizeBox } from './ui';

// Ribbon menus (Neil, 11/10/2026: "make sure the menus are better and robust").

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ribbon Menu', () => {
  it('opens from the keyboard, runs an item and closes; Escape closes too', async () => {
    const pick = vi.fn();
    render(<Menu label="Aa" title="Change Case" items={[{ label: 'UPPERCASE', onClick: pick }, '-', { label: 'lowercase', onClick: () => {} }]} />);
    const btn = screen.getByRole('button', { name: 'Change Case' });
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    // It renders at the top of the page, outside the ribbon, so no edge clips it.
    const menu = await screen.findByRole('menu');
    expect(btn.parentElement.contains(menu)).toBe(false);
    fireEvent.click(screen.getByRole('menuitem', { name: 'UPPERCASE' }));
    expect(pick).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'UPPERCASE' })).toBeNull());
    fireEvent.click(btn);
    await screen.findByRole('menuitem', { name: 'lowercase' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'lowercase' })).toBeNull());
  });

  it('opening one menu closes the other', async () => {
    render(<><Menu label="A" title="First" items={[{ label: 'One', onClick: () => {} }]} /><Menu label="B" title="Second" items={[{ label: 'Two', onClick: () => {} }]} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    await screen.findByRole('menuitem', { name: 'One' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    await screen.findByRole('menuitem', { name: 'Two' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'One' })).toBeNull());
  });
});

describe('PickList and SizeBox', () => {
  it('searches a grouped list and picks the first match on Enter', async () => {
    const onPick = vi.fn();
    render(<PickList ariaLabel="Font" label="Default Font" groups={[['Serif', [['Georgia', 'Georgia'], ['Garamond', 'Garamond']]], ['Sans-serif', [['Arial', 'Arial']]]]} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font' }));
    const search = await screen.findByLabelText('Search Font');
    fireEvent.change(search, { target: { value: 'gar' } });
    expect(screen.queryByRole('option', { name: 'Arial' })).toBeNull();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('Garamond');
  });

  it('takes a typed size on Enter, clamped and rounded to a half', () => {
    const onPick = vi.fn();
    render(<SizeBox sizes={['10', '12']} value="12" onPick={onPick} />);
    const box = screen.getByLabelText('Font Size');
    fireEvent.change(box, { target: { value: '13.3' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('13.5');
    fireEvent.change(box, { target: { value: '9000' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('400');
  });
});

describe('RibbonBar', () => {
  it('keeps one row: groups that do not fit move into More, in order', async () => {
    // jsdom has no layout: every group 200px wide, a 500px bar.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 60, top: 0, left: 0, right: 200, bottom: 60, x: 0, y: 0 });
    const ran = vi.fn();
    render(<RibbonBar tabKey="home" render={() => (<>
      <Group label="One"><BigBtn label="Alpha" onClick={() => {}} /></Group>
      <Group label="Two"><BigBtn label="Beta" onClick={() => {}} /></Group>
      <Group label="Three"><BigBtn label="Gamma" onClick={ran} /></Group>
    </>)} />);
    const groups = [...document.querySelectorAll('.doc-ribbon-bar > .doc-ribbon-group:not(.doc-ribbon-more)')];
    // 200 + 200 fit beside the 64px More button in 500px; the third does not.
    expect(groups.map((g) => g.classList.contains('is-overflow'))).toEqual([false, false, true]);
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    const more = await screen.findByRole('toolbar', { name: 'More tools' });
    // More shows only the groups the row hid.
    const shown = [...more.querySelectorAll('.doc-ribbon-overflow-body > .doc-ribbon-group')].filter((g) => g.style.display !== 'none');
    expect(shown.map((g) => g.textContent)).toEqual(['GammaThree']);
    // A command run from More closes it.
    fireEvent.click([...more.querySelectorAll('button')].find((b) => b.textContent === 'Gamma'));
    expect(ran).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'More tools' })).toBeNull());
  });
});
