import { describe, it, expect } from 'vitest';
import { attentionRows, worstTone, alertCount, visibleModule, boardCsvRows, csvText, matchesStat } from './biModel';

// The BI board's data rules (Oct 13 2026): what counts as "needs attention",
// how a module's alert level is read, and how the filters narrow a card.

const modules = [
  { id: 'tasks', label: 'Tasks', nav: 'tasks', stats: [
    { key: 'overdue', label: 'Overdue', value: 623, tone: 'critical', drill: true },
    { key: 'upcoming', label: 'Due This Week', value: 0, tone: 'warning', drill: true },
    { key: 'open_total', label: 'Open', value: 1225, tone: 'neutral', drill: true },
  ], breakdown: [{ label: 'On Track', value: 602, tone: 'neutral' }] },
  { id: 'tickets', label: 'Tickets', nav: 'tickets', stats: [
    { key: 'unassigned', label: 'Unassigned', value: 18, tone: 'critical', drill: true },
    { key: 'open', label: 'Open', value: 25, tone: 'warning', drill: true },
  ] },
  { id: 'accounting', label: 'Accounting', nav: 'accounting', stats: [
    { key: 'cash_on_hand', label: 'Cash on Hand', value: '$1,200', tone: 'good', drill: false },
  ] },
];

describe('attentionRows', () => {
  it('lists critical and warning counts above zero, worst then largest first, with their module', () => {
    const rows = attentionRows(modules);
    expect(rows.map((r) => `${r.moduleId}:${r.key}`)).toEqual(['tasks:overdue', 'tickets:unassigned', 'tickets:open']);
    expect(rows[0].moduleLabel).toBe('Tasks');
    expect(rows[0].nav).toBe('tasks');
  });
  it('ignores zeros, neutral/good counts and non-numeric values', () => {
    const rows = attentionRows(modules);
    expect(rows.find((r) => r.key === 'upcoming')).toBeUndefined();
    expect(rows.find((r) => r.key === 'open_total')).toBeUndefined();
    expect(rows.find((r) => r.key === 'cash_on_hand')).toBeUndefined();
  });
});

describe('worstTone / alertCount', () => {
  it('reads the worst live alert, and a card with only zeros is good', () => {
    expect(worstTone(modules[0])).toBe('critical');
    expect(worstTone(modules[2])).toBe('good');
    expect(worstTone({ stats: [{ key: 'x', value: 0, tone: 'critical' }] })).toBe('good');
    expect(alertCount(modules[0])).toBe(1);
    expect(alertCount(modules[1])).toBe(2);
  });
});

describe('visibleModule', () => {
  it('keeps every stat and the shapes when nothing narrows the card', () => {
    const v = visibleModule(modules[0]);
    expect(v.stats).toHaveLength(3);
    expect(v.shapes).toBe(true);
    expect(v.visible).toBe(true);
  });
  it('narrows by search and by alert level, and drops a card with no match', () => {
    expect(visibleModule(modules[0], 'all', 'over').stats.map((s) => s.key)).toEqual(['overdue']);
    expect(visibleModule(modules[0], 'critical').stats.map((s) => s.key)).toEqual(['overdue']);
    expect(visibleModule(modules[0], 'critical').shapes).toBe(false);
    expect(visibleModule(modules[2], 'critical').visible).toBe(false);
  });
  it('matchesStat is case-insensitive on the label', () => {
    expect(matchesStat({ label: 'SLA Breached', tone: 'critical' }, 'all', 'sla')).toBe(true);
    expect(matchesStat({ label: 'SLA Breached', tone: 'critical' }, 'warning', '')).toBe(false);
  });
});

describe('CSV', () => {
  it('exports the filtered board with a header and quotes what needs quoting', () => {
    const rows = boardCsvRows(modules, 'critical');
    expect(rows[0]).toEqual(['Module', 'Metric', 'Value', 'Alert Level']);
    expect(rows.slice(1)).toEqual([['Tasks', 'Overdue', 623, 'Critical'], ['Tickets', 'Unassigned', 18, 'Critical']]);
    expect(csvText([['a,b', 'say "hi"']])).toBe('"a,b","say ""hi"""');
  });
});
