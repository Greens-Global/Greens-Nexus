import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PageTrail, { PageTrailProvider, ShellTrail, useTrailCrumbs, tabLabelOf } from './PageTrail';

// The page trail (Neil, 11/04/2026): the module, then the pages above a
// record, above the page title. It never repeats the page you are on.

function Record({ up }) {
  useTrailCrumbs([{ label: 'Portfolio', onClick: up }]);
  return <div><PageTrail title="Greens Storage, Fairfield" /><h2>Greens Storage, Fairfield</h2></div>;
}

// The shell's navigate runs `after` once the move goes ahead (App.jsx).
const go = () => vi.fn((view, sub, after) => after?.());
const shell = (ui, nav = go()) => render(
  <PageTrailProvider view="property-asset" label="Asset Management" onNavigate={nav}>
    <ShellTrail />
    {ui}
  </PageTrailProvider>,
);
const parts = () => [...document.querySelectorAll('.page-trail li')].map((li) => li.textContent);

describe('PageTrail', () => {
  it('names the module over a page title, and the module part goes to the module', () => {
    const nav = go();
    shell(<div><PageTrail title="Shift Planner" /><h2>Shift Planner</h2></div>, nav);
    expect(parts()).toEqual(['Asset Management']);
    fireEvent.click(screen.getByRole('button', { name: 'Asset Management' }));
    expect(nav).toHaveBeenCalledWith('property-asset', null, expect.any(Function));
    expect(document.querySelectorAll('.page-trail')).toHaveLength(1);   // the shell yields to the page's
  });

  it('steps aside when the title already names the module', () => {
    shell(<div><PageTrail title="Asset Management" /><h2>Asset Management</h2></div>);
    expect(document.querySelector('.page-trail')).toBeNull();
  });

  it('puts the pages above a record in the trail, never the record itself', () => {
    const up = vi.fn();
    shell(<Record up={up} />);
    expect(parts()).toEqual(['Asset Management', 'Portfolio']);
    expect(screen.queryByRole('button', { name: /Greens Storage/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
    expect(up).toHaveBeenCalled();
  });

  it('draws the trail itself on a screen with no title row, and clears a record crumb when it closes', () => {
    const { rerender } = shell(<Record up={vi.fn()} />);
    rerender(
      <PageTrailProvider view="property-asset" label="Asset Management" onNavigate={vi.fn()}>
        <ShellTrail />
        <div>A list with no title row</div>
      </PageTrailProvider>,
    );
    expect(parts()).toEqual(['Asset Management']);
    expect(document.querySelector('.page-trail--standalone')).toBeTruthy();
  });

  it('a page held in the module state names its parent and the module part takes it home', () => {
    const home = vi.fn();
    const up = vi.fn();
    const nav = go();
    function Detail() {
      useTrailCrumbs([{ label: 'Portfolios', onClick: up }], home);
      return <div><PageTrail title="West Coast" /><h2>West Coast</h2></div>;
    }
    shell(<Detail />, nav);
    expect(parts()).toEqual(['Asset Management', 'Portfolios']);
    expect(document.querySelector('.page-trail--deep')).toBeTruthy();   // a phone shows "< Portfolios"
    fireEvent.click(screen.getByRole('button', { name: 'Portfolios' }));
    expect(up).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Asset Management' }));
    expect(home).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith('property-asset', null, expect.any(Function));
  });

  it('a first crumb named like the module is the module part (Workflows > the Workflows list)', () => {
    const toList = vi.fn();
    const nav = go();
    function Builder() { useTrailCrumbs([{ label: 'asset management', onClick: toList }]); return <PageTrail title="My Flow" />; }
    shell(<Builder />, nav);
    expect(parts()).toEqual(['Asset Management']);
    fireEvent.click(screen.getByRole('button', { name: 'Asset Management' }));
    expect(toList).toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it('finds a tab label inside a dropdown', () => {
    expect(tabLabelOf([{ key: 'a', label: 'Overview' }, { key: 'g', label: 'Revenue', items: [{ key: 'r1', label: 'Rent Roll' }] }], 'r1')).toBe('Rent Roll');
  });
});

describe('PageTrail and unsaved work', () => {
  it('a deep page keeps its place when the move does not go ahead (Stay)', () => {
    const home = vi.fn();
    const stay = vi.fn();   // a navigate that was refused: never runs `after`
    function Deep() { useTrailCrumbs([{ label: 'Portfolio', onClick: () => {} }], home); return <PageTrail title="One" />; }
    shell(<Deep />, stay);
    fireEvent.click(screen.getByRole('button', { name: /Asset Management/ }));
    expect(stay).toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
  });
});
