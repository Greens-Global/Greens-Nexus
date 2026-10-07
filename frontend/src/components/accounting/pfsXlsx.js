import JSZip from 'jszip';
import { formatDate } from '../../lib/datetime';
import { conditionOf } from './pfsCondition';
import { pfsExtraSheets } from './pfsAffiliatedExport';
import { addressLine, normalizePfsDetails } from './pfsAddress';

// A personal financial statement as an Excel workbook (Neil, 10/01: "we
// should have the ability to do this in excel also"). One sheet per section
// of the statement - Financial Condition (the bank-style first page, Oct 6),
// Borrower, Assets, Liabilities, Real Estate,
// Schedule E and C when there are any, History - from the same statement the
// server computed and kept on record, so the workbook says what the PDF says.
//
// Written as the .xlsx file format itself (a zip of XML parts), the way
// reportExcel.js writes a financial statement: no spreadsheet library in the
// bundle can write bold or fills. Section totals and net worth are live SUM()
// formulas, so a lender who changes a figure sees the totals move.

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (n) => { let s = ''; let x = n; while (x >= 0) { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } return s; };
const ref = (c, r) => `${colName(c)}${r}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const KIND = { individual: 'Individual', joint: 'Joint', trust: 'Trust' };

// Cell styles, by index (see STYLES_XML).
const S = { text: 0, bold: 1, title: 2, muted: 3, num: 4, numTotal: 5, numGrand: 6, header: 7, headerNum: 8, pct: 9, section: 10 };

const NUM_FMT = '#,##0.00;(#,##0.00);"-"';
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="${esc(NUM_FMT)}"/><numFmt numFmtId="165" formatCode="0.##&quot;%&quot;"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF3C4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECFD"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="4">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom/><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="double"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="medium"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(c, r, { text, num, f, s = S.text }) {
  const at = ref(c, r);
  if (f !== undefined) return `<c r="${at}" s="${s}"><f>${esc(f)}</f>${Number.isFinite(num) ? `<v>${num}</v>` : ''}</c>`;
  if (text !== undefined) return text === '' ? '' : `<c r="${at}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  if (Number.isFinite(num)) return `<c r="${at}" s="${s}"><v>${num}</v></c>`;
  return '';
}

// One sheet under construction: rows of cell specs, with the helpers every
// section of the statement is laid out with.
function sheet(name) {
  const rows = [];
  const push = (cells) => { rows.push(cells); return rows.length; };
  const blank = () => push([]);
  const title = (text, sub) => { push([{ text, s: S.title }]); if (sub) push([{ text: sub, s: S.muted }]); blank(); };
  const heading = (text) => push([{ text, s: S.section }]);
  const header = (cols) => push(cols.map((c) => ({ text: c.label, s: c.num ? S.headerNum : S.header })));
  // A table whose last column(s) are figures; `sumCols` get a SUM() total row.
  const table = (cols, data, { totalLabel, sumCols = [] } = {}) => {
    header(cols);
    const first = rows.length + 1;
    data.forEach((r) => push(cols.map((c, i) => {
      const v = r[i];
      if (c.num) return { num: round2(v), s: S.num };
      if (c.pct) return { num: Number(v) || 0, s: S.pct };
      return { text: v == null ? '' : String(v), s: S.text };
    })));
    const last = rows.length;
    if (totalLabel) {
      const rowNo = rows.length + 1;
      const cells = cols.map(() => ({ text: '' }));
      cells[0] = { text: totalLabel, s: S.bold };
      sumCols.forEach((ci) => {
        cells[ci] = data.length ? { f: `SUM(${ref(ci, first)}:${ref(ci, last)})`, num: round2(data.reduce((s, r) => s + (Number(r[ci]) || 0), 0)), s: S.numTotal } : { num: 0, s: S.numTotal };
      });
      push(cells);
      return rowNo;
    }
    return last;
  };
  const facts = (pairs) => pairs.filter(([, v]) => v).forEach(([k, v]) => push([{ text: k, s: S.muted }, { text: String(v), s: S.text }]));
  return { name, rows, push, blank, title, heading, header, table, facts };
}

const money = (n) => round2(n);
const pct = (n) => Number(n) || 0;
const sourceText = (r) => (r.source === 'ledger' ? 'Ledger' : `Kept by hand${r.asOf ? ` (${formatDate(r.asOf)})` : ''}`);

/** The sheets of one statement: [{ name, rows }]. Exported for tests. */
export function pfsSheets({ statement, preparedBy = '' }) {
  const { profile, asOf } = statement;
  const name = profile.displayName || profile.name || 'Guarantor';
  const sub = `${name}  ·  As of ${formatDate(asOf)}  ·  ${KIND[profile.kind] || 'Individual'} statement  ·  Prepared ${formatDate(new Date())}${preparedBy ? ` by ${preparedBy}` : ''}`;
  const out = [];

  // ── Statement of Financial Condition (Charmi, 10/04) ──────────────────────
  // The first sheet, as the first page of the PDF: every line of a bank's
  // form with the share owned and the amount, live totals, net worth,
  // contingent liabilities, and the year's income from the schedules.
  const cond = conditionOf(statement);
  const summary = sheet('Financial Condition');
  summary.title('Statement of Financial Condition', sub);
  const condCols = (head) => [{ label: head }, { label: 'Ownership' }, { label: 'Amount', num: true }];
  const condRows = (list) => list.map((x) => [x.label, x.count ? x.ownership : '', money(x.amount)]);
  summary.heading('Assets');
  const assetsTotalRow = summary.table(condCols('Assets'), condRows(cond.assets), { totalLabel: 'Total Assets', sumCols: [2] });
  summary.blank();
  summary.heading('Liabilities');
  const liabTotalRow = summary.table(condCols('Liabilities'), condRows(cond.liabilities), { totalLabel: 'Total Liabilities', sumCols: [2] });
  summary.blank();
  const nwRow = summary.push([{ text: 'Net Worth', s: S.bold }, {}, { f: `${ref(2, assetsTotalRow)}-${ref(2, liabTotalRow)}`, num: money(statement.totals.netWorth), s: S.numGrand }]);
  summary.push([{ text: 'Total Liabilities and Net Worth', s: S.muted }, {}, { f: `${ref(2, liabTotalRow)}+${ref(2, nwRow)}`, num: money(cond.totals.liabilities + statement.totals.netWorth), s: S.num }]);
  summary.blank();
  summary.heading('Contingent Liabilities');
  if (cond.contingent.length) {
    summary.table([{ label: 'Guarantee' }, { label: 'Lender' }, { label: 'Owned %', pct: true }, { label: 'Amount', num: true }],
      cond.contingent.map((x) => [x.label, x.institution || '', pct(x.ownershipPct), money(x.amount)]), { totalLabel: 'Total Contingent Liabilities', sumCols: [3] });
  } else {
    const a = cond.contingentAnswer;
    summary.push([{ text: `Guarantor, co-maker or endorser on any debt: ${a?.answer === 'Yes' ? `Yes${a.note ? ` - ${a.note}` : ''}` : a?.answer === 'No' ? 'None.' : 'None listed.'}`, s: S.muted }]);
  }
  if (cond.income) {
    summary.blank();
    summary.heading(`Annual Income ${cond.income.year || ''}`.trim());
    summary.table([{ label: 'Income' }, { label: '' }, { label: 'Amount', num: true }], cond.income.lines.map((x) => [x.label, '', money(x.amount)]), { totalLabel: 'Total Annual Income', sumCols: [2] });
  }
  summary.blank();
  summary.push([{ text: 'Amounts are at the share owned.', s: S.muted }]);
  out.push(summary);

  // ── Borrower ──────────────────────────────────────────────────────────────
  const d = normalizePfsDetails(profile.details);
  const borrower = sheet('Borrower');
  borrower.title('Borrower Information', sub);
  borrower.facts([
    ['Name', name], ['Statement Type', KIND[profile.kind] || 'Individual'], ['Address', addressLine(d)],
    ['Phone', d.phone], ['Email', d.email], ['Date of Birth', d.date_of_birth ? formatDate(d.date_of_birth) : ''], ['Marital Status', d.marital_status],
    ['Employer', d.employer], ['Title', d.title], ['Social Security Number', d.ssn_last4 ? `XXX-XX-${d.ssn_last4}` : ''],
  ]);
  const co = d.coBorrower || {};
  if (co.name) {
    borrower.blank();
    borrower.heading('Co-Borrower');
    borrower.facts([
      ['Name', co.name], ['Address', addressLine(co)], ['Phone', co.phone], ['Email', co.email],
      ['Date of Birth', co.date_of_birth ? formatDate(co.date_of_birth) : ''], ['Marital Status', co.marital_status], ['Employer', co.employer], ['Title', co.title],
      ['Social Security Number', co.ssn_last4 ? `XXX-XX-${co.ssn_last4}` : ''],
    ]);
  }
  if ((d.members || []).length) {
    borrower.blank();
    borrower.heading('Parties to This Statement');
    d.members.forEach((m) => borrower.push([{ text: m.name, s: S.text }, { text: m.role || '', s: S.muted }]));
  }
  out.push(borrower);

  // ── Assets and liabilities ────────────────────────────────────────────────
  const lineCols = [{ label: 'Description' }, { label: 'Institution' }, { label: 'Account' }, { label: 'Figure From' }, { label: 'Owned %', pct: true }, { label: 'Balance', num: true }, { label: 'Adjusted', num: true }];
  const lineRows = (g) => g.rows.map((r) => [r.label, r.institution, r.accountRef, sourceText(r), pct(r.ownershipPct), money(r.balance), money(r.adjusted)]);
  // Oct 7 (Charmi, 10/03): Investments on the Assets sheet - Investment
  // Accounts and Business Interests (counted in the total, as before) and
  // Real Estate at equity (shown only: its value and loans are counted once,
  // on the Real Estate sheet), with a Total Investments row. A statement kept
  // before Oct 7 has no `investments` and lays out as it did.
  const inv = statement.investments?.groups?.length ? statement.investments : null;
  const reEquityCols = [{ label: 'Property' }, { label: 'Kind' }, { label: '' }, { label: '' }, { label: 'Owned %', pct: true }, { label: 'Market Value', num: true }, { label: 'Equity', num: true }];
  const holdings = (sheetName, groups, totalLabel, investments = null) => {
    const sh = sheet(sheetName);
    sh.title(sheetName, sub);
    const totals = [];
    const invKeys = new Set(investments?.assetKeys || []);
    let invDone = !investments;
    const drawInvestments = () => {
      const parts = [];
      investments.groups.forEach((g) => {
        sh.heading(`${investments.label || 'Investments'} - ${g.label}`);
        if (g.key === 'real_estate_equity') {
          parts.push(sh.table(reEquityCols, g.rows.map((r) => [r.label, r.categoryLabel || '', '', '', pct(r.ownershipPct), money(r.valueAdjusted), money(r.equity)]),
            { totalLabel: 'Total Real Estate Equity', sumCols: [6] }));
        } else {
          const row = sh.table(lineCols, lineRows(g), { totalLabel: `Total ${g.label}`, sumCols: [6] });
          totals.push(row);
          parts.push(row);
        }
        sh.blank();
      });
      sh.push([{ text: `Total ${investments.label || 'Investments'}`, s: S.bold }, {}, {}, {}, {}, {}, { f: parts.map((r) => ref(6, r)).join('+'), num: money(investments.total), s: S.numTotal }]);
      if (investments.note) sh.push([{ text: investments.note, s: S.muted }]);
      sh.blank();
    };
    groups.forEach((g) => {
      if (invKeys.has(g.key)) {
        if (!invDone) { drawInvestments(); invDone = true; }
        return;
      }
      sh.heading(g.label);
      totals.push(sh.table(lineCols, lineRows(g), { totalLabel: `Total ${g.label}`, sumCols: [6] }));
      sh.blank();
    });
    if (!invDone) drawInvestments();
    if (!groups.length) sh.push([{ text: 'Nothing listed.', s: S.muted }]);
    const amount = groups.reduce((s, g) => s + g.total, 0);
    sh.push([{ text: totalLabel, s: S.bold }, {}, {}, {}, {}, {}, totals.length ? { f: totals.map((r) => ref(6, r)).join('+'), num: money(amount), s: S.numGrand } : { num: 0, s: S.numGrand }]);
    return sh;
  };
  out.push(holdings('Assets', statement.assets, 'Total Assets (Excluding Real Estate)', inv));
  out.push(holdings('Liabilities', statement.liabilities, 'Total Liabilities (Excluding Real Estate Loans)'));

  // ── Schedule of real estate ───────────────────────────────────────────────
  const re = sheet('Real Estate');
  re.title('Schedule of Real Estate', `${sub}  ·  Market value and loan balance at the share owned`);
  const reCols = [{ label: 'Property' }, { label: 'Address' }, { label: 'Legal Owner' }, { label: 'Lender' }, { label: 'Owned %', pct: true }, { label: 'Market Value', num: true }, { label: 'Loan Balance', num: true }, { label: 'Equity', num: true }];
  statement.realEstate.forEach((g) => {
    re.heading(g.label);
    re.table(reCols, g.rows.map((r) => [r.label, r.details?.address || '', r.details?.legal_owner || '', r.details?.lender || '', pct(r.ownershipPct), money(r.valueAdjusted), money(r.loanAdjusted), money(r.equity)]),
      { totalLabel: `Total ${g.label}`, sumCols: [5, 6, 7] });
    re.blank();
  });
  if (!statement.realEstate.length) re.push([{ text: 'No real estate listed.', s: S.muted }]);
  out.push(re);

  // ── Schedule E and C ──────────────────────────────────────────────────────
  const sch = statement.schedules || { e: [], c: [] };
  if ((sch.e || []).length) {
    const e = sheet('Schedule E');
    e.title(`Schedule E - Rental Real Estate ${sch.year || ''}`.trim(), `${sub}  ·  From the entity's ledger for the calendar year`);
    sch.e.forEach((b) => {
      e.heading(`${b.label}${b.entity ? ` (entity ${b.entity})` : ''}${b.address ? ` - ${b.address}` : ''}`);
      e.push([{ text: 'Rents Received', s: S.text }, { num: money(b.income), s: S.num }]);
      const first = e.rows.length + 1;
      e.push([{ text: 'Expenses', s: S.bold }]);
      const expRow = e.table([{ label: 'IRS Line' }, { label: 'Amount', num: true }], b.lines.map((x) => [x.label, money(x.amount)]), { totalLabel: 'Total Expenses', sumCols: [1] });
      e.push([{ text: 'Net Income (Loss)', s: S.bold }, { f: `${ref(1, first - 1)}-${ref(1, expRow)}`, num: money(b.net), s: S.numGrand }]);
      e.push([{ text: `At ${pct(b.ownershipPct)}% owned`, s: S.muted }, { num: money(b.netAtShare), s: S.numTotal }]);
      e.blank();
    });
    out.push(e);
  }
  if ((sch.c || []).length) {
    const c = sheet('Schedule C');
    c.title(`Schedule C - Profit or Loss From Business ${sch.year || ''}`.trim(), `${sub}  ·  From the entity's ledger for the calendar year`);
    sch.c.forEach((b) => {
      c.heading(`${b.label}${b.entity ? ` (entity ${b.entity})` : ''}`);
      const gross = c.push([{ text: 'Gross Receipts', s: S.text }, { num: money(b.income), s: S.num }]);
      const cogs = c.push([{ text: 'Cost of Goods Sold', s: S.text }, { num: money(b.cogs), s: S.num }]);
      c.push([{ text: 'Gross Profit', s: S.bold }, { f: `${ref(1, gross)}-${ref(1, cogs)}`, num: money(b.income - b.cogs), s: S.numTotal }]);
      const gpRow = c.rows.length;
      c.push([{ text: 'Expenses (Part II)', s: S.bold }]);
      const expRow = c.table([{ label: 'IRS Line' }, { label: 'Amount', num: true }], b.lines.map((x) => [x.label, money(x.amount)]), { totalLabel: 'Total Expenses', sumCols: [1] });
      c.push([{ text: 'Net Profit (Loss)', s: S.bold }, { f: `${ref(1, gpRow)}-${ref(1, expRow)}`, num: money(b.net), s: S.numGrand }]);
      c.push([{ text: `At ${pct(b.ownershipPct)}% owned`, s: S.muted }, { num: money(b.netAtShare), s: S.numTotal }]);
      c.blank();
    });
    out.push(c);
  }

  // ── History and profile ───────────────────────────────────────────────────
  const h = sheet('History');
  h.title('Financial History', sub);
  const answered = (profile.history || []).filter((x) => x.answer);
  if (answered.length) h.table([{ label: 'Question' }, { label: 'Answer' }, { label: 'Note' }], answered.map((x) => [x.question, x.answer, x.note || '']));
  else h.push([{ text: 'No questions answered.', s: S.muted }]);
  if ((profile.executiveProfile || '').trim()) {
    h.blank();
    h.heading(`Executive Profile - ${profile.name || name}`);
    profile.executiveProfile.split(/\n/).forEach((t) => h.push([{ text: t, s: S.text }]));
  }
  out.push(h);
  // Oct 6 (Charmi, 10/04): Affiliated Entities and the co-borrower's executive profile (pfsAffiliatedExport.js).
  pfsExtraSheets(statement).forEach((x) => {
    const sh = sheet(x.name);
    sh.title(x.title, sub);
    if (x.cols) sh.table(x.cols, x.rows);
    if (x.text) x.text.split(/\n/).forEach((t) => sh.push([{ text: t, s: S.text }]));
    out.push(sh);
  });
  return out.map(({ name: n, rows }) => ({ name: n, rows }));
}

function sheetXml(rows) {
  const widths = [];
  const printed = (spec) => (spec?.text !== undefined ? spec.text : Number.isFinite(spec?.num) ? spec.num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : spec?.f ? '0,000,000.00' : '');
  rows.forEach((cells, rIdx) => {
    if (rIdx < 2) return;
    cells.forEach((spec, c) => { if (spec) widths[c] = Math.max(widths[c] || 0, String(printed(spec)).length); });
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(12, Math.round((w || 0) * 1.1 + 3)))}" customWidth="1"/>`).join('');
  const body = rows.map((cells, rIdx) => `<row r="${rIdx + 1}">${cells.map((spec, c) => (spec ? cell(c, rIdx + 1, spec) : '')).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${body}</sheetData>
<pageSetup orientation="${widths.length > 6 ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

/** The workbook bytes (Uint8Array) for one statement. */
export async function buildPfsWorkbook({ statement, preparedBy = '' }) {
  const sheets = pfsSheets({ statement, preparedBy });
  const name = statement.profile?.displayName || statement.profile?.name || 'Guarantor';
  const zip = new JSZip();
  const sheetName = (s) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(`Personal Financial Statement - ${name}`)}</dc:title><dc:creator>Greens Nexus</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Greens Nexus</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('xl/styles.xml', STYLES_XML);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
