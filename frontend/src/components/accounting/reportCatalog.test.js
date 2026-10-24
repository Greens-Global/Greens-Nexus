import { describe, it, expect } from 'vitest';
import { catalogue, standardEntries } from './reportCatalog';

// Oct 23 (Neil, item 05): the Report Center lists every report - standard,
// memorized, and saved / published from the Report Builder - grouped like the
// Reports menu, each marked.

const GROUPS = [
  { key: 'grp-center', label: 'Report Center', items: [
    { key: 'reports', label: 'Report Center' }, { key: 'report-builder', label: 'Report Builder' }, { key: 'packages', label: 'Packages' },
  ] },
  { key: 'grp-financial', label: 'Financial', items: [
    { key: 'rpt-balance-sheet', label: 'Balance Sheet' },
    { key: 'grp-pnl', label: 'Income Statement', items: [{ key: 'rpt-pnl-t12', label: 'T12' }] },
  ] },
  { key: 'grp-budget', label: 'Budget', items: [{ key: 'budget', label: 'Budget' }] },
  { key: 'grp-audit', label: 'Audit & Insights', items: [{ key: 'mri', label: 'MRI' }] },
];
const SAVED = [
  { id: 's1', name: 'GG Inc BS', config: { report: 'balance-sheet', entities: ['12000'] }, shared: true, owner: 'urmi@greensglobal.com', mine: false },
  { id: 's2', name: 'My P&L', config: { report: 'pnl', preset: 'ytd' }, shared: false, owner: 'me@greensglobal.com', mine: true },
  { id: 'b1', name: 'Custom Lines', config: { kind: 'builder', version: 1, groups: [{ name: 'Line A', accounts: ['61000'] }] }, shared: true, owner: 'me@greensglobal.com', mine: true },
  { id: 'b2', name: 'Draft', config: { kind: 'builder', version: 1 }, shared: false, owner: 'me@greensglobal.com', mine: true },
];

describe('Report Center catalogue', () => {
  it('lists every standard report the menu holds, the statements it does not name, and never itself', () => {
    const rows = standardEntries(GROUPS);
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain('reports');
    expect(keys).toEqual(expect.arrayContaining(['report-builder', 'packages', 'rpt-balance-sheet', 'rpt-pnl-t12', 'budget', 'mri', 'rpt-pnl', 'rpt-budget', 'rpt-general-ledger', 'rpt-card-activity']));
    expect(rows.find((r) => r.key === 'rpt-pnl-t12').label).toBe('Income Statement, T12');
    expect(rows.find((r) => r.key === 'rpt-pnl')).toMatchObject({ label: 'Income Statement', groupKey: 'grp-financial' });
    expect(rows.find((r) => r.key === 'rpt-budget')).toMatchObject({ label: 'Actual vs Budget', groupKey: 'grp-budget' });
  });

  it('marks memorized and builder reports apart from the standard ones, under their groups', () => {
    const rows = catalogue(GROUPS, SAVED);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['rpt-balance-sheet'].type).toBe('standard');
    expect(byId.s1).toMatchObject({ type: 'memorized', key: 'rpt-balance-sheet', group: 'Financial', label: 'GG Inc BS' });
    expect(byId.s2).toMatchObject({ type: 'memorized', key: 'rpt-pnl', groupKey: 'grp-financial' });
    expect(byId.b1).toMatchObject({ type: 'published', key: 'report-builder', group: 'Report Center' });
    expect(byId.b2.type).toBe('saved');
    expect(byId.b1.about).toContain('1 row group');
    // In menu order: the Report Center group first.
    expect(rows[0].groupKey).toBe('grp-center');
    expect(rows.findIndex((r) => r.id === 'b1')).toBeLessThan(rows.findIndex((r) => r.id === 'rpt-balance-sheet'));
  });

  it('shows a limited person only the memorized reports over their own entities', () => {
    const rows = catalogue(GROUPS, SAVED, { limited: true, entities: [{ code: '32000', name: 'Greens Austin' }] });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain('s1');
    expect(ids).toEqual(expect.arrayContaining(['s2', 'b1', 'b2']));
  });
});
