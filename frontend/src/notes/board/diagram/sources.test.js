import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../api', () => ({ api: {} }));
import { orgGraph, workflowGraph, taskGraph } from './sources';
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

describe('taskGraph', () => {
  it('keeps only linked tasks of the project, blocker first', () => {
    const tasks = [
      { id: 1, projectId: 'p', title: 'Pour', blockedByIds: [2], code: 'T-1' },
      { id: 2, projectId: 'p', title: 'Frame', completed: true },
      { id: 3, projectId: 'p', title: 'Alone' },
      { id: 4, projectId: 'q', title: 'Other', blockedByIds: [1] },
      { id: 5, projectId: 'p', title: 'Waits Outside', blockedByIds: [4] },
    ];
    const g = taskGraph(tasks, 'p');
    expect(g.nodes.map((n) => [n.label, n.shape]).sort()).toEqual([['Frame', 'terminal'], ['T-1 Pour', 'step']]);
    expect(g.edges).toEqual([{ from: 't:2', to: 't:1', label: '' }]);
  });
});
