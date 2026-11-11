import { describe, it, expect } from 'vitest';
import { NAV } from './Sidebar';
import { orderNav, railSections, KICKERS } from './navOrder';

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

  it('reads the Work group as Tasks, Tickets, Files, Credentials, with Workflows under System (Neil, 11/10/2026)', () => {
    const groups = [[]];
    for (const item of orderNav(NAV)) {
      if (item.divider) groups.push([]); else groups[groups.length - 1].push(item.label);
    }
    expect(groups[1]).toEqual(['Tasks', 'Tickets', 'Files', 'Credentials']);
    expect(groups[2]).not.toContain('Workflows');
    const shown = (labels) => labels.filter((l) => !NAV.find((i) => i.label === l)?.menuOnly);
    expect(shown(groups[groups.length - 1])).toEqual(['Help Center', 'Workflows', 'Settings']);
    // Files is the one module for Egnyte and Documents: either grant shows it.
    expect(NAV.filter((i) => i.label === 'Files').map((i) => [i.view, i.grants])).toEqual([['documents', ['documents', 'egnyte']]]);
    expect(NAV.some((i) => i.view === 'egnyte')).toBe(false);
    expect(groups[2]).not.toContain('Credentials');
  });
});

// The rail's Modules group in sections (11/05/2026): hairline dividers split
// it into Operations, Finance and Company, alphabetical inside each; every
// other group and every divider keeps its label; nothing is lost or added.
describe('railSections', () => {
  const sections = (items) => {
    const out = [{ kicker: KICKERS[0], labels: [] }];
    for (const item of items) {
      if (item.divider) out.push({ kicker: item.kicker, labels: [] }); else out[out.length - 1].labels.push(item.label);
    }
    return out;
  };

  it('splits Modules into Operations, Finance and Company behind dividers', () => {
    const rail = railSections(orderNav(NAV).filter((i) => !i.menuOnly), KICKERS);
    const got = sections(rail);
    expect(got.map((g) => g.kicker)).toEqual(['My Desk', 'Work', 'Operations', 'Finance', 'Company', 'System']);
    const by = Object.fromEntries(got.map((g) => [g.kicker, g.labels]));
    expect(by.Operations).toEqual(['Asset Management', 'Construction', 'IT', 'Item Management', 'Operations']);
    expect(by.Finance).toEqual(['Accounting', 'Investor Relations']);
    expect(by.Company).toEqual(['Marketing', 'People']);
    expect(by.Work).toEqual(['Tasks', 'Tickets', 'Files', 'Credentials']);
    expect(by.System).toEqual(['Help Center', 'Workflows', 'Settings']);
    expect(rail.filter((i) => !i.divider)).toHaveLength(orderNav(NAV).filter((i) => !i.menuOnly && !i.divider).length);
  });

  it('names the Modules divider after the first section a person can see, and adds no empty sections', () => {
    const items = orderNav(NAV).filter((i) => !i.menuOnly && (i.divider || !['ops', 'it', 'inventory', 'operations', 'property-asset', 'marketing', 'hr'].includes(i.view)));
    const got = sections(railSections(items, KICKERS));
    expect(got.map((g) => g.kicker)).toEqual(['My Desk', 'Work', 'Finance', 'System']);
  });

  it('leaves a list with no dividers (an external guest) as it is', () => {
    const items = NAV.filter((i) => !i.divider).slice(0, 4);
    expect(railSections(items, KICKERS)).toEqual(items);
  });
});
