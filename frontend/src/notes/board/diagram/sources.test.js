import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../api', () => ({ api: {} }));
import { orgGraph, workflowGraph, taskGraph, propertyGraph, NEXUS_MAP_TEXT } from './sources';
import { parseText, layout } from './graph';
import { layout as wfLayout } from '../../../workflows/canvas/layout';

describe('orgGraph', () => {
  const people = [
    { email: 'Boss@x.com', name: 'Boss', jobTitle: 'Owner', managerEmail: '' },
    { email: 'b@x.com', name: 'Bea', jobTitle: 'Ops', managerEmail: 'boss@x.com' },
    { email: 'a@x.com', name: 'Al', managerEmail: 'boss@x.com' },
    { email: 'c@x.com', name: 'Cy', managerEmail: 'b@x.com' },
    { email: 'loop@x.com', name: 'Self', managerEmail: 'loop@x.com' },
  ];
  it('draws everyone from the top, names then titles, reports in name order', () => {
    const g = orgGraph(people);
    expect(g.nodes.map((n) => n.label)).toEqual(['Boss\nOwner', 'Al', 'Bea\nOps', 'Cy', 'Self']);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['p:boss@x.com>p:a@x.com', 'p:boss@x.com>p:b@x.com', 'p:b@x.com>p:c@x.com']);
  });
  it('starts at one person and stops at a depth', () => {
    expect(orgGraph(people, 'B@x.com').nodes.map((n) => n.id)).toEqual(['p:b@x.com', 'p:c@x.com']);
    expect(orgGraph(people, 'boss@x.com', 1).nodes).toHaveLength(1);
  });
});

describe('workflowGraph', () => {
  it('reads the builder layout, folds joins and keeps branch labels', () => {
    const def = {
      trigger: { kind: 'event', event: 'ticket.created' },
      steps: [
        { id: 's1', kind: 'if', conditions: [], then: [{ id: 's2', kind: 'action', action: 'notify' }], else: [] },
        { id: 's3', kind: 'action', action: 'notify' },
      ],
    };
    const g = workflowGraph(def, wfLayout, (n) => n.kind);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['w:s1', 'w:s2', 'w:s3']));
    expect(g.nodes.every((n) => !/join|ghost/.test(n.label))).toBe(true);
    expect(g.nodes.find((n) => n.id === 'w:s1').shape).toBe('decision');
    expect(g.edges.some((e) => e.from === 'w:s1' && e.to === 'w:s2' && e.label)).toBe(true);
    expect(g.edges.some((e) => e.from === 'w:s2' && e.to === 'w:s3')).toBe(true);
    for (const e of g.edges) { expect(ids).toContain(e.from); expect(ids).toContain(e.to); }
  });
});

describe('orgGraph by company (11/08/2026)', () => {
  it('boxes each company with its people, arrows still manager to report', () => {
    const people = [
      { email: 'boss@x.com', name: 'Boss', managerEmail: '', companyName: 'Greens Global' },
      { email: 'b@x.com', name: 'Bea', managerEmail: 'boss@x.com', companyName: 'Greens India' },
      { email: 'c@x.com', name: 'Cy', managerEmail: 'boss@x.com', company: 'gg', companyName: 'Greens Global' },
      { email: 'd@x.com', name: 'Di', managerEmail: 'boss@x.com' },
    ];
    expect(orgGraph(people).groups).toBeUndefined();
    const g = orgGraph(people, '', 0, { byCompany: true });
    expect(g.groups.map((x) => [x.label, x.members, x.glyph])).toEqual([
      ['Greens Global', ['p:boss@x.com', 'p:c@x.com'], 'building-2'],
      ['Greens India', ['p:b@x.com'], 'building-2'],
      ['No Company', ['p:d@x.com'], 'building-2'],
    ]);
    expect(g.edges).toHaveLength(3);
  });
});

describe('Systems maps (11/08/2026)', () => {
  const ws = {
    properties: [
      { id: 'p1', name: 'Escondido', address: '1 Main St, Escondido, CA' },
      { id: 'p2', name: 'Gone', deleted: true },
      { id: 'e1', kind: 'equipment', name: 'Gate Operator', make: 'LiftMaster', address: '1 Main St, Escondido, CA' },
      { id: 'v1', kind: 'vehicle', name: 'Truck 4', parentId: 'p1' },
      { id: 'e2', kind: 'equipment', name: 'Elsewhere', address: '9 Other Rd' },
    ],
    warranties: [{ propertyId: 'p1', scope: 'HVAC Units' }, { propertyId: 'p1', scope: 'HVAC Units' }, { propertyId: 'p9', scope: 'Not Here' }],
    utilities: [{ id: 'u1', propertyId: 'p1', service: 'Electric', provider: 'SDG&E' }, { id: 'u2', propertyId: 'p1', service: 'Water', provider: 'City', deleted: true }],
    vendors: [{ id: 'd1', propertyId: 'p1', company: 'Bug Busters', category: 'Pest Control' }],
  };
  it('draws one property as a group, its equipment, utilities and vendors in groups inside it', () => {
    const g = propertyGraph(ws, 'p1');
    expect(g.groups.map((x) => [x.label, x.parent, x.members.length])).toEqual([
      ['Escondido', '', 0], ['Equipment', 'site', 3], ['Utilities', 'site', 1], ['Vendors', 'site', 1],
    ]);
    expect(g.nodes.map((n) => [n.label, n.glyph])).toEqual([
      ['Gate Operator\nLiftMaster', 'fence'], ['Truck 4', 'truck'], ['HVAC Units', 'fan'],
      ['Electric\nSDG&E', 'zap'], ['Bug Busters\nPest Control', 'bug'],
    ]);
    expect(g.edges).toEqual([]);
    const placed = layout(g);
    expect(placed.groups[0].label).toBe('Escondido');
    expect(placed.groups.slice(1).every((x) => x.parent === 'site')).toBe(true);
  });
  it('keys each box by its record, so Refresh keeps a box on the same record when one before it goes', () => {
    const ids = (w) => Object.fromEntries(propertyGraph(w, 'p1').nodes.map((n) => [n.label.split('\n')[0], n.id]));
    const before = ids(ws);
    expect(before).toMatchObject({ 'Gate Operator': 'equipment:ae1', 'Truck 4': 'equipment:av1', 'HVAC Units': 'equipment:whvac units', Electric: 'utilities:ru1', 'Bug Busters': 'vendors:rd1' });
    const after = ids({ ...ws, properties: ws.properties.filter((a) => a.id !== 'e1') });
    expect(after['Truck 4']).toBe(before['Truck 4']);
    expect(after['HVAC Units']).toBe(before['HVAC Units']);
  });
  it('draws nothing for a property it was not sent, or one in the Trash', () => {
    expect(propertyGraph(ws, 'p2').nodes).toEqual([]);
    expect(propertyGraph(ws, 'nope').nodes).toEqual([]);
    expect(propertyGraph({ properties: [{ id: 'p3', name: 'Bare' }] }, 'p3').nodes).toEqual([]);
  });
  it('maps Nexus and what it connects to, grouped, the sync jobs dashed', () => {
    const g = parseText(NEXUS_MAP_TEXT);
    expect(g.groups.map((x) => x.label)).toEqual(['Hosting', 'Microsoft', 'Business Systems']);
    expect(g.notes).toEqual([]);
    const label = (id) => g.nodes.find((n) => n.id === id).label;
    const dashed = g.edges.filter((e) => e.kind === 'dashed').map((e) => label(e.to)).sort();
    expect(dashed).toEqual(['Cubby', 'Egnyte', 'Intacct']);
    expect(g.nodes.every((n) => n.glyph)).toBe(true);
    expect(NEXUS_MAP_TEXT).not.toMatch(/https?:|\.com|\.net|\.io|secret|password|token|api[_ -]?key/i);
  });
});

describe('taskGraph', () => {
  it('keeps only linked tasks of the project (extra projects count), blocker first', () => {
    const tasks = [
      { id: 1, projectId: 'p', title: 'Pour', blockedByIds: [2], code: 'T-1' },
      { id: 2, projectId: 'p', title: 'Frame', completed: true },
      { id: 3, projectId: 'p', title: 'Alone' },
      { id: 4, projectId: 'q', title: 'Other', blockedByIds: [1] },
      { id: 5, projectId: 'p', title: 'Waits Outside', blockedByIds: [4] },
      { id: 6, projectId: 'q', projectIds: ['p'], title: 'Also Here' },
      { id: 7, projectId: 'p', title: 'Waits on Also Here', blockedByIds: [6] },
    ];
    const g = taskGraph(tasks, 'p');
    expect(g.nodes.map((n) => [n.label, n.shape]).sort()).toEqual([['Also Here', 'step'], ['Frame', 'terminal'], ['T-1 Pour', 'step'], ['Waits on Also Here', 'step']]);
    expect(g.edges).toEqual([{ from: 't:2', to: 't:1', label: '' }, { from: 't:6', to: 't:7', label: '' }]);
  });
});
