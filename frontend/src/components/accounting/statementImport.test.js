import { describe, it, expect } from 'vitest';
import { buildIntacctRows, classifyLines, findHeaderRow, guessColumns, parseAmount, parseCsv, parseDate, readTransactions, ruleFromLine, ruleMatches, toCsv, usDate } from './statementImport';

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
    expect(parseCsv(`${String.fromCharCode(0xfeff)}Date,"A ""quoted"" one"\r\n1/2/26,x`)).toEqual([['Date', 'A "quoted" one'], ['1/2/26', 'x']]);
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
    ], { journal: 'GJCA', cashAccount: '10100', offsetAccount: '40500', location: '15000' });
    const [head, ...lines] = rows;
    expect(head).toEqual(['DONOTIMPORT', 'JOURNAL', 'DATE', 'REVERSEDATE', 'DESCRIPTION', 'REFERENCE_NO', 'LINE_NO', 'ACCT_NO', 'LOCATION_ID', 'DEPT_ID', 'DOCUMENT', 'MEMO', 'DEBIT', 'CREDIT', 'SOURCEENTITY']);
    const col = (name) => head.indexOf(name);
    expect(lines).toHaveLength(4);
    // Line 1 the offset, line 2 the cash account; each entry balances.
    expect(lines.map((l) => [l[col('LINE_NO')], l[col('ACCT_NO')], l[col('DEBIT')], l[col('CREDIT')]])).toEqual([
      ['1', '40500', '', '100.00'], ['2', '10100', '100.00', ''],
      ['1', '40500', '40.50', ''], ['2', '10100', '', '40.50'],
    ]);
    expect(lines[0][col('JOURNAL')]).toBe('GJCA');
    expect(lines[0][col('DATE')]).toBe('10/01/2026');
    expect(lines[1][col('DATE')]).toBe('');
    expect(lines[0][col('LOCATION_ID')]).toBe('15000');
    expect(lines[1][col('SOURCEENTITY')]).toBe('15000');
    expect(lines[2][col('REFERENCE_NO')]).toBe('T9');
    expect(toCsv(rows).startsWith('DONOTIMPORT,JOURNAL,DATE')).toBe(true);
  });
});

// Rules (Charmi, 10/27 call item 01): "the $200 which hits my account every
// month has to be classified as interest income ... that $200 transaction
// going from my bank account will also have a rule set up."
describe('statement rules', () => {
  const day = { y: 2026, m: 10, d: 1 };
  const T = [
    { date: day, description: 'INTEREST PAYMENT', memo: '', reference: '', amount: 200 },
    { date: day, description: 'Online Transfer to  CHK 4410', memo: '', reference: '', amount: -200 },
    { date: day, description: 'AAA INSURANCE AUTOPAY', memo: '', reference: '', amount: -734.33 },
    { date: day, description: 'Coffee', memo: '', reference: '', amount: -4.5 },
  ];
  const RULES = [
    { id: 'r1', matchText: 'interest payment', matchType: 'contains', direction: 'in', amount: null, account: '40100', priority: 100, active: true },
    { id: 'r2', matchText: 'online transfer to chk', matchType: 'starts_with', direction: 'out', amount: 200, account: '20500', vendorId: 'V00099', vendorName: 'Sam Payee', priority: 100, active: true },
    { id: 'r3', matchText: 'AAA INSURANCE', matchType: 'contains', direction: 'any', amount: null, account: '61500', vendorId: 'V00037', priority: 50, active: true },
    { id: 'r4', matchText: 'aaa insurance autopay', matchType: 'equals', direction: 'any', amount: null, account: '99999', priority: 90, active: true },
    { id: 'r5', matchText: 'Coffee', matchType: 'equals', direction: 'any', amount: null, account: '62000', priority: 1, active: false },
  ];

  it('matches on description text, direction and amount, case and spacing ignored', () => {
    expect(ruleMatches(RULES[0], T[0])).toBe(true);
    expect(ruleMatches(RULES[0], { ...T[0], amount: -200 })).toBe(false);         // money out, rule is money in
    expect(ruleMatches(RULES[1], T[1])).toBe(true);
    expect(ruleMatches(RULES[1], { ...T[1], amount: -200.01 })).toBe(false);      // another amount
    expect(ruleMatches(RULES[3], T[2])).toBe(true);
    expect(ruleMatches(RULES[3], { ...T[2], description: 'AAA INSURANCE AUTOPAY 2' })).toBe(false);
    expect(ruleMatches(RULES[4], T[3])).toBe(false);                               // turned off
    expect(ruleMatches(RULES[0], { ...T[0], description: '', memo: 'Interest  Payment Oct' })).toBe(true);
  });

  it('classifies each line by the first rule in priority order; a pick on the line wins', () => {
    const lines = classifyLines(T, RULES, { 3: { account: '62000' } });
    expect(lines.map((l) => [l.account, l.vendorId, l.how, l.classified])).toEqual([
      ['40100', '', 'rule', true], ['20500', 'V00099', 'rule', true],
      ['61500', 'V00037', 'rule', true],                                           // priority 50 beats 90
      ['62000', '', 'hand', true],
    ]);
    const open = classifyLines(T, RULES.slice(0, 1));
    expect(open.filter((l) => !l.classified).map((l) => l.index)).toEqual([1, 2, 3]);
    // Clearing a rule's account on the line leaves it unclassified, on purpose.
    expect(classifyLines(T, RULES, { 0: { account: '' } })[0].classified).toBe(false);
  });

  it('puts each line on its own account and its vendor or customer in the Intacct columns', () => {
    const lines = classifyLines(T, RULES, { 0: { customerId: 'C00010' } });
    const rows = buildIntacctRows(lines.map((l) => ({ ...l, account: l.account || '12000' })), { journal: 'GJCA', cashAccount: '10100', offsetAccount: '12000' });
    const [head, ...out] = rows;
    // Charmi's own template carries the dimensions after SOURCEENTITY, in this order.
    expect(head.slice(15)).toEqual(['CURRENCY', 'EXCH_RATE_DATE', 'EXCH_RATE_TYPE_ID', 'EXCHANGE_RATE', 'STATE', 'ALLOCATION_ID', 'BILLABLE', 'RPESENTRY', 'GLENTRY_CUSTOMERID', 'GLENTRY_VENDORID']);
    const col = (n) => head.indexOf(n);
    expect(out.map((l) => [l[col('ACCT_NO')], l[col('GLENTRY_VENDORID')], l[col('GLENTRY_CUSTOMERID')]])).toEqual([
      ['40100', '', 'C00010'], ['10100', '', ''],
      ['20500', 'V00099', ''], ['10100', '', ''],
      ['61500', 'V00037', ''], ['10100', '', ''],
      ['12000', '', ''], ['10100', '', ''],
    ]);
    expect(out.every((l) => l.length === head.length)).toBe(true);
  });

  it('turns a line into a rule to save', () => {
    const [line] = classifyLines([T[1]], [], { 0: { account: '20500', vendorId: 'V00099' } });
    expect(ruleFromLine(line)).toMatchObject({ matchText: 'Online Transfer to  CHK 4410', direction: 'out', amount: null, account: '20500', vendorId: 'V00099' });
    expect(ruleFromLine(line, { withAmount: true }).amount).toBe(200);
  });
});
