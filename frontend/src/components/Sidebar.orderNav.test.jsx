import { describe, it, expect } from 'vitest';
import { NAV } from './Sidebar';
import { orderNav } from './navOrder';

describe('orderNav', () => {
  it('sorts the Modules group alphabetically and leaves the other groups alone', () => {
    const groups = [];
    let run = [];
    for (const item of orderNav(NAV)) {
      if (item.divider) { groups.push(run); run = []; } else run.push(item.label);
    }
    groups.push(run);
    const modules = groups[2];
    expect(modules.length).toBeGreaterThan(3);
    expect(modules).toEqual([...modules].sort((a, b) => a.localeCompare(b)));
    // the first group keeps NAV's own order
    const first = NAV.slice(0, NAV.findIndex((i) => i.divider)).map((i) => i.label);
    expect(groups[0]).toEqual(first);
    expect(orderNav(NAV).length).toBe(NAV.length);
  });

  it('reads the Work group as Tasks, Tickets, Files, Documents, Credentials, Workflows (Neil, 10/28/2026)', () => {
    const groups = [[]];
    for (const item of orderNav(NAV)) {
      if (item.divider) groups.push([]); else groups[groups.length - 1].push(item.label);
    }
    expect(groups[1]).toEqual(['Tasks', 'Tickets', 'Files', 'Documents', 'Credentials', 'Workflows']);
    expect(groups[2]).not.toContain('Workflows');
    expect(groups[2]).not.toContain('Credentials');
  });
});
