import { describe, it, expect, vi } from 'vitest';
import {
  ACTIVITY_MAX_LINES, activityConfig, activitySub, bankKindOf, canUseDims, columnModes, parseActivitySub, resolveConfig, runReport, runningBalances,
} from './reportModel';

// Oct 22 (Neil, item 07): Reports > Banking & Credit Cards > Credit Card
// Activity and Bank Activity - pick one card or bank account, see its
// transactions with a running balance, then the usual filters. Cards and bank
// accounts are told apart by the reconciliation list's rule, so the picker
// and Dashboard > Overview > Account Reconciliations agree.

const TB_ROWS = [
  { account_no: '11310', title: 'Chase Checking 6532', type: 'cash_bank', section: 'asset', opening: 1000, debit: 500, credit: 200, closing: 1300 },
  { account_no: '11400', title: 'Petty Cash', type: 'petty_cash', section: 'asset', opening: 50, debit: 0, credit: 0, closing: 50 },
  { account_no: '12000', title: 'Accounts Receivable', type: 'asset', section: 'asset', opening: 9000, debit: 100, credit: 0, closing: 9100 },
  { account_no: '21500', title: 'Amex Credit Card 1001', type: 'liability', section: 'liability', opening: -400, debit: 300, credit: 250, closing: -350 },
  { account_no: '21600', title: 'Ramp Card', type: 'liability', section: 'liability', opening: 0, debit: 0, credit: 75, closing: -75 },
  { account_no: '20000', title: 'Accounts Payable', type: 'liability', section: 'liability', opening: -5000, debit: 0, credit: 0, closing: -5000 },
];

function fakeApi({ lines = [], total = null, tbFails = false } = {}) {
  return {
    getAccountingTrialBalance: vi.fn(async () => {
      if (tbFails) throw new Error('statement timeout');
      return { org: 'Greens Global', rows: TB_ROWS, totals: {}, generated_at: '2026-10-22T10:00:00Z' };
    }),
    searchAccountingLedger: vi.fn(async ({ offset = 0, limit }) => ({ rows: lines.slice(offset, offset + limit), total: total ?? lines.length })),
  };
}
const base = (patch) => resolveConfig({ report: 'bank-activity', preset: 'custom', from: '2026-09-01', to: '2026-09-30', ...patch });
// The search hands lines back newest first.
const LINES = [
  { entry_id: 'e3', entry_no: 'GJ-3', entry_date: '2026-09-20', description: 'Rent', vendor_name: 'Sunbelt Realty', location_name: 'Neil & Archana Kadakia', debit: 0, credit: 200 },
  { entry_id: 'e2', entry_no: 'GJ-2', entry_date: '2026-09-10', description: 'Deposit', vendor_name: '', location_name: 'Neil & Archana Kadakia', debit: 400, credit: 0 },
  { entry_id: 'e1', entry_no: 'GJ-1', entry_date: '2026-09-02', memo: 'Transfer in', vendor_id: 'V-100', location_name: 'Neil & Archana Kadakia', debit: 100, credit: 0 },
];

describe('which accounts are cards and which are bank accounts', () => {
  it('follows the reconciliation list: cash_bank / petty_cash are bank, liabilities named like a card are cards', () => {
    expect(TB_ROWS.map((r) => [r.account_no, bankKindOf(r)])).toEqual([
      ['11310', 'bank'], ['11400', 'bank'], ['12000', null], ['21500', 'card'], ['21600', 'card'], ['20000', null],
    ]);
    expect(bankKindOf({ type: 'liability', title: 'Visa - Capital One 4411' })).toBe('card');
    expect(bankKindOf({ type: 'liability', title: 'Cardinal Loan' })).toBeNull();
    expect(bankKindOf({ bank_kind: 'card', type: 'asset' })).toBe('card');
    expect(bankKindOf({ group: 'Bank', title: 'Old payload' })).toBe('bank');
  });

  it('lists only credit cards in Credit Card Activity and only bank accounts in Bank Activity', async () => {
    const cards = await runReport(fakeApi(), base({ report: 'card-activity' }));
    expect(cards.pickable.map((p) => p.code)).toEqual(['21500', '21600']);
    const banks = await runReport(fakeApi(), base());
    expect(banks.pickable.map((p) => p.code)).toEqual(['11310', '11400']);
    // Nothing picked: the accounts with their movement and closing balance, and a nudge to pick one.
    expect(banks.rows.filter((r) => r.kind === 'account').map((r) => [r.code, r.values[2], r.values[3]])).toEqual([['11310', 300, 1300], ['11400', 0, 50]]);
    expect(banks.notes[0]).toMatch(/Pick a bank account/);
  });

  it('has the standard filters: a period, a book, entities and Filters, one Total Only layout', () => {
    const c = base({ book: 'cash', entities: ['32000'], dims: { vendor: ['V-1'] } });
    expect(c.book).toBe('cash');
    expect(canUseDims(c)).toBe(true);
    expect(columnModes(c.report).map((m) => m.key)).toEqual(['total']);
    expect(base({ book: 'both' }).book).toBe('accrual');
  });
});

describe('one account\'s transactions', () => {
  it('lists date, description, vendor, amount and a running balance from the opening balance', async () => {
    const api = fakeApi({ lines: LINES });
    const r = await runReport(api, base({ accounts: ['11310'], entities: ['32000'] }));
    expect(api.searchAccountingLedger).toHaveBeenCalledWith(expect.objectContaining({ account: '11310', location: '32000', from: '2026-09-01', to: '2026-09-30', book: 'accrual' }));
    expect(r.glLabel).toBe('Date');
    expect(r.columns.map((c) => c.label)).toEqual(['Description', 'Vendor', 'Amount', 'Running Balance', 'Entity', 'Entry']);
    const opening = r.rows[0];
    expect([opening.label, opening.values[3]]).toEqual(['Opening Balance', 1000]);
    const lines = r.rows.filter((x) => x.kind === 'line');
    expect(lines.map((l) => [l.label, l.values[0], l.values[1], l.values[2], l.values[3]])).toEqual([
      ['09/02/2026', 'Transfer in', 'V-100', 100, 1100],
      ['09/10/2026', 'Deposit', '', 400, 1500],
      ['09/20/2026', 'Rent', 'Sunbelt Realty', -200, 1300],
    ]);
    // The last running balance is the account's balance at the period end.
    const closing = r.rows.at(-1);
    expect([closing.label, closing.values[2], closing.values[3]]).toEqual(['Closing Balance', 300, 1300]);
    expect(lines.at(-1).values[3]).toBe(closing.values[3]);
    expect(r.summary.map((s) => s.label)).toEqual(['Opening Balance', 'Closing Balance', 'Transactions']);
    expect(r.activity).toEqual({ account: '11310', title: 'Chase Checking 6532' });
  });

  it('says so when the opening balance cannot be read, instead of starting at zero', async () => {
    const r = await runReport(fakeApi({ lines: LINES, tbFails: true }), base({ accounts: ['11310'] }));
    const lines = r.rows.filter((x) => x.kind === 'line');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.values[3] === '')).toBe(true);
    expect(r.rows.some((x) => x.label === 'Opening Balance')).toBe(false);
    expect(r.notes.join(' ')).toMatch(/opening balance could not be read \(statement timeout\)/);
  });

  it('drops the running balance when Filters narrow the lines', async () => {
    const r = await runReport(fakeApi({ lines: LINES.slice(0, 1) }), base({ accounts: ['11310'], dims: { vendor: ['SUN'] } }));
    expect(r.rows.filter((x) => x.kind === 'line').every((l) => l.values[3] === '')).toBe(true);
    expect(r.notes.join(' ')).toMatch(/Filters narrow the lines/);
    expect(r.summary[0].label).toBe('Net of Lines Shown');
  });

  it('counts back from the closing balance when the oldest lines are not listed', () => {
    const lines = [{ debit: 100, credit: 0 }, { debit: 0, credit: 30 }];
    expect(runningBalances(lines, { opening: 10, closing: 80 })).toEqual([110, 80]);
    expect(runningBalances(lines, { opening: 10, closing: 500, partial: true })).toEqual([530, 500]);
    expect(runningBalances(lines, {})).toBeNull();
    expect(ACTIVITY_MAX_LINES).toBeGreaterThan(1000);
  });
});

describe('deep links (Dashboard > Overview > Account Reconciliations)', () => {
  it('writes and reads the account, entity, months and book in the sub key', () => {
    const sub = activitySub('card-activity', { account: '21500', entity: '15001-1', from: '2026-09-01', to: '2026-09-30', book: 'cash' });
    expect(sub).toBe('rpt-card-activity:21500:15001-1:2026-09-01:2026-09-30:cash');
    expect(parseActivitySub(sub)).toEqual({ report: 'card-activity', account: '21500', entity: '15001-1', from: '2026-09-01', to: '2026-09-30', book: 'cash' });
    expect(activitySub('bank-activity', { account: '11310', book: 'accrual' })).toBe('rpt-bank-activity:11310');
    expect(activitySub('bank-activity', { account: 'A:1' })).toBe('rpt-bank-activity:A%3A1');
    expect(parseActivitySub('rpt-bank-activity:A%3A1').account).toBe('A:1');
    expect(parseActivitySub('rpt-bank-activity:1:2:not-a-date:2026-09-30').from).toBe('');
    expect(parseActivitySub('rpt-general-ledger:11310')).toBeNull();
    expect(parseActivitySub('overview')).toBeNull();
  });

  it('opens the report with the account already picked', async () => {
    const link = parseActivitySub('rpt-bank-activity:11310:32000:2026-09-01:2026-09-30');
    const config = resolveConfig({ report: link.report, entities: ['99999'], ...activityConfig(link) });
    expect(config).toMatchObject({ report: 'bank-activity', accounts: ['11310'], entities: ['32000'], preset: 'custom', from: '2026-09-01', to: '2026-09-30', book: 'accrual' });
    // No entity on the link: every entity in reach, not a leftover pick.
    expect(resolveConfig({ entities: ['99999'], ...activityConfig({ account: '11310' }) }).entities).toEqual([]);
    const r = await runReport(fakeApi({ lines: LINES }), config);
    expect(r.rows.at(-1).values[3]).toBe(1300);
  });
});
