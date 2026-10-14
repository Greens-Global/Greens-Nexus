import { describe, it, expect } from 'vitest';
import { buildIntacctRows, findHeaderRow, guessColumns, parseAmount, parseCsv, parseDate, readTransactions, toCsv, usDate } from './statementImport';

// Import Hub (Neil, 10/14): a statement in, an Intacct GL journal entry import out.

const FIDELITY = `

Run Date,Account,Action,Symbol,Security Description,Security Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
10/01/2026,"Brokerage X123","DIVIDEND RECEIVED FIDELITY GOVT MONEY MARKET (SPAXX)",SPAXX,"FIDELITY GOVERNMENT MONEY MARKET",Cash,,,,,,"1,234.56",
10/03/2026,"Brokerage X123","Electronic Funds Transfer Paid",,"No Description",Cash,,,,,,-500,

"The data and information in this spreadsheet is provided to you solely for your use"
`;

describe('statement import', () => {
  it('reads a Fidelity export: header past the blank lines, the columns, and the footer skipped', () => {
    const rows = parseCsv(FIDELITY).filter((r) => r.some(Boolean));
    const h = findHeaderRow(rows);
    expect(rows[h][0]).toBe('Run Date');
    const map = guessColumns(rows[h]);
    expect(rows[h][map.date]).toBe('Run Date');
    expect(rows[h][map.description]).toBe('Action');
    expect(rows[h][map.amount]).toBe('Amount ($)');
    expect(map.mode).toBe('amount');
    const { transactions, skipped } = readTransactions(rows.slice(h + 1), map);
    expect(transactions.map((t) => t.amount)).toEqual([1234.56, -500]);
    expect(skipped).toBe(1);
  });

  it('reads a bank export with Debit and Credit columns', () => {
    const rows = parseCsv('Date,Description,Debit,Credit,Balance\n09/30/26,Rent deposit,,"2,000.00",5000\n10/02/26,Check 1001,150.25,,4849.75\n');
    const map = guessColumns(rows[0]);
    expect(map.mode).toBe('split');
    const { transactions } = readTransactions(rows.slice(1), map);
    expect(transactions.map((t) => [usDate(t.date), t.amount])).toEqual([['09/30/2026', 2000], ['10/02/2026', -150.25]]);
  });

  it('reads amounts and dates in the usual shapes', () => {
    expect(parseAmount('(1,234.50)')).toBe(-1234.5);
    expect(parseAmount('$99.10')).toBe(99.1);
    expect(parseAmount('12.00 DR')).toBe(-12);
    expect(parseAmount('Pending')).toBeNull();
    expect(usDate(parseDate('2026-10-14'))).toBe('10/14/2026');
    expect(usDate(parseDate('1/5/26'))).toBe('01/05/2026');
    expect(parseDate('13/40/2026')).toBeNull();
  });

  it('builds one balanced two-line entry per transaction', () => {
    const rows = buildIntacctRows([
      { date: { y: 2026, m: 10, d: 1 }, description: 'Dividend', memo: 'SPAXX', reference: '', amount: 100 },
      { date: { y: 2026, m: 10, d: 3 }, description: 'Transfer out', memo: '', reference: 'T9', amount: -40.5 },
    ], { journal: 'GJ', cashAccount: '10100', offsetAccount: '40500', location: '15000', state: 'Draft' });
    const [head, ...lines] = rows;
    expect(head.slice(0, 12)).toEqual(['JOURNAL', 'DATE', 'DESCRIPTION', 'REFERENCE_NO', 'LINE_NO', 'ACCT_NO', 'LOCATION_ID', 'DEPT_ID', 'DOCUMENT', 'MEMO', 'DEBIT', 'CREDIT']);
    const col = (name) => head.indexOf(name);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => [l[col('LINE_NO')], l[col('ACCT_NO')], l[col('DEBIT')], l[col('CREDIT')]])).toEqual([
      ['1', '10100', '100.00', ''], ['2', '40500', '', '100.00'],
      ['1', '10100', '', '40.50'], ['2', '40500', '40.50', ''],
    ]);
    expect(lines[0][col('DATE')]).toBe('10/01/2026');
    expect(lines[0][col('LOCATION_ID')]).toBe('15000');
    expect(lines[2][col('REFERENCE_NO')]).toBe('T9');
    expect(toCsv(rows).startsWith('JOURNAL,DATE')).toBe(true);
  });
});
