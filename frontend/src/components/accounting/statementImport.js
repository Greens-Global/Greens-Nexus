// Import Hub (Neil, 10/14): a bank or brokerage statement (Fidelity, a bank's
// CSV export, or a sheet saved as XLSX) turned into an Intacct General
// Ledger journal entry import file. Everything here is pure - the screen
// (ImportHub.jsx) reads the file, these functions find the header row, guess
// the columns, read dates and amounts, and build the balanced import rows.
// Nothing is sent anywhere: the file is built in the browser and downloaded.

/** Parse CSV text (quoted fields, doubled quotes, CRLF or LF) into rows of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

const norm = (h) => String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Header names seen on common exports, best first. Fidelity: Run Date,
// Action, Security Description, Amount ($), Settlement Date. Chase: Posting
// Date / Transaction Date, Description, Amount. Bank of America and others:
// Date, Description, Debit, Credit (or Withdrawals / Deposits).
const GUESS = {
  date: ['run date', 'posting date', 'post date', 'transaction date', 'trans date', 'date', 'settlement date', 'effective date', 'value date'],
  description: ['description', 'action', 'transaction description', 'payee', 'name', 'details', 'narrative', 'transaction'],
  memo: ['security description', 'memo', 'symbol', 'category', 'notes', 'type'],
  reference: ['check number', 'check no', 'check', 'reference', 'reference no', 'ref', 'confirmation', 'transaction id', 'id'],
  amount: ['amount', 'net amount', 'transaction amount', 'amount usd'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'debits', 'payment', 'money out', 'paid out'],
  credit: ['credit', 'deposit', 'deposits', 'credits', 'money in', 'paid in'],
};

/** The first row that reads like a header: it names a date column and an amount (or debit/credit) column. */
export function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i += 1) {
    const cells = (rows[i] || []).map(norm);
    const hasDate = cells.some((c) => GUESS.date.includes(c) || /\bdate\b/.test(c));
    const hasMoney = cells.some((c) => GUESS.amount.includes(c) || GUESS.debit.includes(c) || GUESS.credit.includes(c));
    if (hasDate && hasMoney) return i;
  }
  return 0;
}

/** Guess which column holds what, by header name. Returns indexes (-1 = none). */
export function guessColumns(header) {
  const cells = (header || []).map(norm);
  const used = new Set();
  const pick = (names) => {
    for (const n of names) {
      const i = cells.findIndex((c, idx) => c === n && !used.has(idx));
      if (i >= 0) { used.add(i); return i; }
    }
    return -1;
  };
  const date = pick(GUESS.date);
  const amount = pick(GUESS.amount);
  const debit = amount >= 0 ? -1 : pick(GUESS.debit);
  const credit = amount >= 0 ? -1 : pick(GUESS.credit);
  const description = pick(GUESS.description);
  const reference = pick(GUESS.reference);
  const memo = pick(GUESS.memo);
  return { date, description, memo, reference, amount, debit, credit, mode: amount >= 0 || (debit < 0 && credit < 0) ? 'amount' : 'split' };
}

/** "$1,234.56", "(1,234.56)", "-1234.56", "1,234.56 CR" -> number; blank or text -> null. */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\s*(CR|DR)$/i.test(s)) { if (/DR$/i.test(s)) neg = !neg; s = s.replace(/\s*(CR|DR)$/i, ''); }
  s = s.replace(/[$,\s]/g, '').replace(/^USD/i, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

const pad = (n) => String(n).padStart(2, '0');

/** A statement date (MM/DD/YYYY, M/D/YY, YYYY-MM-DD, an Excel serial) -> { y, m, d } or null. */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const dt = new Date(Math.round((v - 25569) * 86400000));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return valid(y, +m[1], +m[2]);
  }
  return null;
}
function valid(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  return { y, m, d };
}
/** { y, m, d } -> MM/DD/YYYY (the date Intacct reads, and the one Nexus shows). */
export const usDate = (p) => (p ? `${pad(p.m)}/${pad(p.d)}/${p.y}` : '');

/**
 * Statement rows -> transactions { date, description, memo, reference, amount }.
 * `amount` > 0 is money INTO the account (a deposit), < 0 money out. With
 * `flip` the signs turn over (a statement that shows withdrawals as positive).
 * Rows with no readable date or a zero amount are skipped and counted.
 */
export function readTransactions(rows, map, { flip = false } = {}) {
  const out = [];
  let skipped = 0;
  const at = (r, i) => (i >= 0 ? r[i] ?? '' : '');
  for (const r of rows) {
    const date = parseDate(at(r, map.date));
    let amount;
    if (map.mode === 'split') {
      const debit = parseAmount(at(r, map.debit));
      const credit = parseAmount(at(r, map.credit));
      amount = debit === null && credit === null ? null : Math.abs(credit || 0) - Math.abs(debit || 0);
    } else amount = parseAmount(at(r, map.amount));
    if (!date || amount === null || Math.abs(amount) < 0.005) { skipped += 1; continue; }
    out.push({
      date,
      description: String(at(r, map.description) || '').trim(),
      memo: String(at(r, map.memo) || '').trim(),
      reference: String(at(r, map.reference) || '').trim(),
      amount: Math.round((flip ? -amount : amount) * 100) / 100,
    });
  }
  return { transactions: out, skipped };
}

/** The columns of Intacct's General Ledger journal entry import template -
 * the same header the stand-alone Import Hub's Fidelity export writes. */
export const INTACCT_JE_COLUMNS = ['DONOTIMPORT', 'JOURNAL', 'DATE', 'REVERSEDATE', 'DESCRIPTION', 'REFERENCE_NO', 'LINE_NO', 'ACCT_NO', 'LOCATION_ID', 'DEPT_ID', 'DOCUMENT', 'MEMO', 'DEBIT', 'CREDIT', 'SOURCEENTITY'];

const money = (n) => (n ? n.toFixed(2) : '');

/**
 * One balanced journal entry per transaction, two lines each, laid out like
 * the stand-alone Import Hub's export: line 1 the offset account, line 2 the
 * cash (or brokerage) account; the entry's journal, date, description and
 * reference sit on line 1 only. Money in debits cash and credits the offset;
 * money out the other way round. Returns rows including the header.
 */
export function buildIntacctRows(transactions, { journal, cashAccount, offsetAccount, location = '', department = '' }) {
  const rows = [INTACCT_JE_COLUMNS];
  transactions.forEach((t) => {
    const date = usDate(t.date);
    const description = (t.description || t.memo || 'Statement transaction').slice(0, 400);
    const memo = [t.description, t.memo].filter(Boolean).join(' - ').slice(0, 1000);
    const amt = Math.abs(t.amount);
    const cashIn = t.amount > 0;
    const line = (no, acct, debit, credit) => [
      '', no === 1 ? journal || '' : '', no === 1 ? date : '', '', no === 1 ? description : '', no === 1 ? t.reference || '' : '',
      String(no), acct, location, department, '', memo, money(debit), money(credit), location,
    ];
    rows.push(line(1, offsetAccount, cashIn ? 0 : amt, cashIn ? amt : 0));
    rows.push(line(2, cashAccount, cashIn ? amt : 0, cashIn ? 0 : amt));
  });
  return rows;
}

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Rows -> CSV text, no byte-order mark (Intacct reads the first header name literally). */
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
