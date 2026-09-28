import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatDate } from '../../lib/datetime';
import { bookLabel, canPickBook, cellText, dimsText, entityText, periodText } from './reportModel';

// A reporting package as one PDF (Neil, Sep 25): a lender opens this, so it
// has to read like a statement from an accounting firm - a cover with the
// contents, then each statement on its own pages with the company, the
// statement name, the entity and the period at the top, amounts in a ruled
// column, section totals, and a page number on every page.
//
// Built in the browser from the same result the screen draws (runReport), so
// what is sent out is what was on screen. Letter paper; a statement with a
// comparison (four figure columns) turns landscape, and one with a column per
// month, entity or vendor gets a sheet as wide as its columns need, in the
// same proportions, so it still prints to fit.

export const INK = rgb(0.09, 0.11, 0.16);
export const MUTED = rgb(0.42, 0.45, 0.52);
export const RULE = rgb(0.80, 0.82, 0.87);
export const BAND = rgb(0.955, 0.962, 0.978);
export const BRAND = rgb(0.169, 0.271, 0.882);
export const MARGIN = 54;
const ROW = 15;
const FLOOR = MARGIN + 8;

// The standard PDF fonts hold Latin-1 only; anything else would throw. Dashes,
// curly quotes, the ellipsis, the bullet and the no-break space become their
// plain forms (by character code, so this file stays plain text), and
// whatever is still outside Latin-1 is dropped.
const PLAIN = { 0x2013: '-', 0x2014: '-', 0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"', 0x2026: '...', 0x2022: String.fromCharCode(0xb7), 0xa0: ' ' };
export const clean = (v) => Array.from(String(v ?? ''), (ch) => {
  const code = ch.codePointAt(0);
  if (PLAIN[code] !== undefined) return PLAIN[code];
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) ? ch : '';
}).join('');

export function fit(font, size, text, width) {
  let t = clean(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

/**
 * statements: [{ title, result, entities }] - result from runReport().
 * cover: false leaves the cover out (one statement exported on its own).
 * Returns the PDF bytes (Uint8Array).
 */
export async function buildPackagePdf({ name, description = '', org = '', preparedBy = '', statements, cover: withCover = true }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(clean(name));
  doc.setAuthor(clean(org || 'Greens Global'));
  doc.setCreator('Greens Nexus');
  const today = formatDate(new Date());
  const company = org || statements.find((s) => s.result?.org)?.result.org || 'Greens Global';

  // ── Cover (filled in at the end, when the page numbers are known) ────────
  const cover = withCover ? doc.addPage([612, 792]) : null;
  const contents = [];   // { title, sub, page }

  // ── Statements ────────────────────────────────────────────────────────────
  statements.forEach(({ title, result, entities }) => {
    const { config, def, columns, rows } = result;
    const wide = columns.length > 3;
    const many = columns.length > 6;
    const figW = (c) => (c.type === 'pct' ? 70 : c.type === 'date' ? 84 : many ? 88 : wide ? 104 : 112);
    const figures = columns.reduce((s, c) => s + figW(c), 0);
    // The account names keep at least 230 points; the sheet grows past that.
    const need = MARGIN * 2 + 230 + figures;
    const size = !wide ? [612, 792] : need <= 792 ? [792, 612] : [need, Math.round((need * 612) / 792)];
    const W = size[0];
    const H = size[1];
    const labelW = W - MARGIN * 2 - figures;
    const sub = [entityText(config, entities), periodText(config), canPickBook(config) ? `${bookLabel(config.book)} basis` : ''].filter(Boolean);
    const filters = dimsText(config);
    let page;
    let y;
    let first = true;

    const head = () => {
      page = doc.addPage(size);
      y = H - MARGIN;
      page.drawText(clean(company).toUpperCase(), { x: MARGIN, y, size: 8.5, font: bold, color: BRAND });
      y -= 20;
      page.drawText(fit(bold, 16, title || def.label, W - MARGIN * 2), { x: MARGIN, y, size: 16, font: bold, color: INK });
      if (!first) page.drawText('(continued)', { x: MARGIN + bold.widthOfTextAtSize(fit(bold, 16, title || def.label, W - MARGIN * 2), 16) + 8, y, size: 9, font, color: MUTED });
      y -= 15;
      page.drawText(fit(font, 9.5, sub.join('  ·  '), W - MARGIN * 2), { x: MARGIN, y, size: 9.5, font, color: MUTED });
      if (filters.length) {
        y -= 12;
        page.drawText(fit(font, 8.5, `Filtered by ${filters.join('; ')}`, W - MARGIN * 2), { x: MARGIN, y, size: 8.5, font, color: MUTED });
      }
      y -= 18;
      // Column headings.
      page.drawText('ACCOUNT', { x: MARGIN, y, size: 7.5, font: bold, color: MUTED });
      let x = MARGIN + labelW;
      columns.forEach((c) => {
        const w = figW(c);
        const t = fit(bold, 7.5, c.label.toUpperCase(), w - 8);
        page.drawText(t, { x: x + w - bold.widthOfTextAtSize(t, 7.5), y, size: 7.5, font: bold, color: MUTED });
        x += w;
      });
      y -= 5;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 0.9, color: INK });
      y -= ROW - 3;
      if (first) contents.push({ title: title || def.label, sub: sub.join('  ·  '), page: doc.getPageCount() });
      first = false;
    };
    // A row may sit as low as FLOOR, just above the footer rule; `extra` is the
    // space that has to be free under it (a section heading keeps two rows).
    const room = (extra) => { if (y - extra < FLOOR) head(); };

    head();
    rows.forEach((r, i) => {
      const heavy = r.kind !== 'account';
      // A section heading never sits alone at the foot of a page.
      room(r.kind === 'section' ? ROW * 2 + 4 : r.kind === 'account' ? 0 : 8);
      if (r.kind === 'subtotal' || r.kind === 'grand' || r.kind === 'margin') {
        y -= 3;
        page.drawLine({ start: { x: MARGIN, y: y + ROW - 3 }, end: { x: W - MARGIN, y: y + ROW - 3 }, thickness: 0.7, color: INK });
        if (r.kind === 'grand') page.drawLine({ start: { x: MARGIN, y: y + ROW - 5.5 }, end: { x: W - MARGIN, y: y + ROW - 5.5 }, thickness: 0.7, color: INK });
        y -= 2;
      }
      if (r.kind === 'section') {
        if (i > 0) y -= 4;
        page.drawRectangle({ x: MARGIN, y: y - 4, width: W - MARGIN * 2, height: ROW, color: BAND });
      }
      const f = heavy ? bold : font;
      const fs = many ? 8.5 : 9.5;
      if (r.kind === 'account') {
        const indent = r.section ? 12 : 0;
        let x = MARGIN + indent;
        if (r.code) {
          page.drawText(clean(r.code), { x, y, size: fs, font, color: MUTED });
          x += font.widthOfTextAtSize(clean(r.code), fs) + 8;
        }
        page.drawText(fit(font, fs, r.title, MARGIN + labelW - x - 8), { x, y, size: fs, font, color: INK });
      } else {
        page.drawText(fit(f, fs, r.label, labelW - 8), { x: MARGIN + (r.kind === 'section' ? 4 : 0), y, size: fs, font: f, color: INK });
      }
      let x = MARGIN + labelW;
      columns.forEach((c, k) => {
        const w = figW(c);
        const t = clean(cellText(r, c, r.values[k]));
        if (t) page.drawText(t, { x: x + w - f.widthOfTextAtSize(t, fs), y, size: fs, font: f, color: INK });
        x += w;
      });
      if (r.kind === 'account') page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: W - MARGIN, y: y - 4 }, thickness: 0.3, color: RULE });
      y -= ROW;
    });
  });

  // ── Cover ─────────────────────────────────────────────────────────────────
  const total = doc.getPageCount();
  if (cover) drawCover();

  function drawCover() {
  let y = 792 - 150;
  cover.drawRectangle({ x: 0, y: 792 - 12, width: 612, height: 12, color: BRAND });
  cover.drawText(clean(company).toUpperCase(), { x: MARGIN, y, size: 10, font: bold, color: BRAND });
  y -= 40;
  // The package name, wrapped onto as many lines as it needs.
  const words = clean(name).split(/\s+/);
  let line = '';
  const lines = [];
  words.forEach((w) => {
    const next = line ? `${line} ${w}` : w;
    if (bold.widthOfTextAtSize(next, 28) > 612 - MARGIN * 2 && line) { lines.push(line); line = w; } else line = next;
  });
  if (line) lines.push(line);
  lines.slice(0, 4).forEach((t) => { cover.drawText(t, { x: MARGIN, y, size: 28, font: bold, color: INK }); y -= 34; });
  if (description) { y -= 2; cover.drawText(fit(font, 12, description, 612 - MARGIN * 2), { x: MARGIN, y, size: 12, font, color: MUTED }); y -= 20; }
  y -= 8;
  cover.drawText(`Prepared ${today}${preparedBy ? ` by ${clean(preparedBy)}` : ''}`, { x: MARGIN, y, size: 10, font, color: MUTED });
  y -= 46;
  cover.drawText('CONTENTS', { x: MARGIN, y, size: 8.5, font: bold, color: MUTED });
  y -= 8;
  cover.drawLine({ start: { x: MARGIN, y }, end: { x: 612 - MARGIN, y }, thickness: 0.9, color: INK });
  y -= 22;
  contents.forEach((c, i) => {
    if (y < MARGIN + 40) return;
    cover.drawText(`${i + 1}.`, { x: MARGIN, y, size: 11, font, color: MUTED });
    cover.drawText(fit(bold, 11, c.title, 612 - MARGIN * 2 - 70), { x: MARGIN + 22, y, size: 11, font: bold, color: INK });
    const p = String(c.page);
    cover.drawText(p, { x: 612 - MARGIN - font.widthOfTextAtSize(p, 11), y, size: 11, font, color: INK });
    y -= 14;
    cover.drawText(fit(font, 9, c.sub, 612 - MARGIN * 2 - 70), { x: MARGIN + 22, y, size: 9, font, color: MUTED });
    y -= 20;
  });
  }

  // ── Footers ───────────────────────────────────────────────────────────────
  doc.getPages().forEach((p, i) => {
    if (cover && i === 0) return;
    const { width } = p.getSize();
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 8 }, end: { x: width - MARGIN, y: MARGIN - 8 }, thickness: 0.4, color: RULE });
    const n = `Prepared ${today}   ${String.fromCharCode(0xb7)}   Page ${i + 1} of ${total}`;
    const nw = font.widthOfTextAtSize(n, 8);
    p.drawText(n, { x: width - MARGIN - nw, y: MARGIN - 22, size: 8, font, color: MUTED });
    p.drawText(fit(font, 8, name, width - MARGIN * 2 - nw - 24), { x: MARGIN, y: MARGIN - 22, size: 8, font, color: MUTED });
  });
  return doc.save();
}
