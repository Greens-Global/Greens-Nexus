// Import From a Spreadsheet - the parts with no screen (Neil, 11/03/2026: the
// import gets a Company column). A CSV is read into one preview row per asset;
// the Company cell is matched to the companies this person can see by id or
// by name (case and spaces ignored) - never guessed: a name that matches no
// company, or more than one, is a row problem and the row is not imported.
// A blank cell leaves the asset with no company (it lands under "Needs a
// Company"). The server still checks every company on the row save
// (routers/property_assets._check_company).

import { normLabel } from './format.js';

/** The template's / the file's column for the asset's company. */
export const COMPANY_COLUMN = 'Company';

const squash = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');

/**
 * Match one Company cell. Returns { companyId, problem } - companyId '' for a
 * blank cell; problem null, or { label, hint } (Title Case label, sentence
 * case hint) when the cell cannot be used.
 */
export function matchCompany(companies, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { companyId: '', problem: null };
  const list = companies || [];
  const byId = list.find((c) => String(c.id) === text);
  const hits = byId ? [byId] : list.filter((c) => squash(c.name) && squash(c.name) === squash(text));
  if (!hits.length) {
    return { companyId: '', problem: { label: 'Unknown Company',
      hint: list.length
        ? `"${text}" is not a company in Nexus - use a name from the Company list, or leave it blank.`
        : 'No companies are available to you yet - leave the cell blank or try again later.' } };
  }
  if (hits.length > 1) {
    return { companyId: '', problem: { label: 'More Than One Match',
      hint: `"${text}" matches ${hits.length} companies - use the company's id instead.` } };
  }
  const hit = hits[0];
  if (hit.assignable === false) {
    return { companyId: '', problem: { label: 'Not One of Your Companies',
      hint: `You can put an asset only in a company you manage - "${hit.name}" is not one of them.` } };
  }
  return { companyId: hit.id, problem: null };
}

/**
 * Read parsed CSV rows (header first) against the class's field list.
 * Returns { items, hasCompanyColumn } - one item per data row:
 * { line (the spreadsheet row number), values (field key -> text), name,
 *   companyText, companyId, problems: [{ label, hint }] }.
 */
export function readImportRows(rows, fields, companies) {
  const header = (rows[0] || []).map((h) => normLabel(h));
  const fieldToColumn = {};
  fields.forEach((f) => {
    const idx = header.indexOf(normLabel(f.label));
    if (idx >= 0) fieldToColumn[f.k] = idx;
  });
  const companyCol = header.indexOf(normLabel(COMPANY_COLUMN));
  const cell = (row, ci) => (ci != null && ci >= 0 && row[ci] != null ? String(row[ci]).trim() : '');

  const items = rows.slice(1).map((row, i) => {
    const values = {};
    fields.forEach((f) => { values[f.k] = cell(row, fieldToColumn[f.k]); });
    const companyText = cell(row, companyCol);
    const problems = [];
    if (!values.name) problems.push({ label: 'No Name', hint: 'Rows without a name are not imported.' });
    const m = matchCompany(companies, companyText);
    if (m.problem) problems.push(m.problem);
    return { line: i + 2, values, name: values.name, companyText, companyId: m.companyId, problems };
  });
  return { items, hasCompanyColumn: companyCol >= 0 };
}
