import { PDFDocument, StandardFonts } from 'pdf-lib';
import { formatDate } from '../../lib/datetime';
import { BAND, BRAND, INK, MARGIN, MUTED, RULE, clean, fit } from './reportPdf';

// A personal financial statement as a PDF (Neil, Sep 25: "an enterprise grade,
// a professional PFS that comes out in a beautiful PDF"). The order is the one
// a lender reads: who the borrower is, what they own, what they owe, the
// schedule of real estate, the summary that ends in net worth, the standard
// questions, the executive profile, and a place to sign.
//
// Built in the browser from the statement the server computed, so the figures
// on paper are the figures that were kept on record when it was produced.

const W = 612;
const H = 792;
const ROW = 15;
const FLOOR = MARGIN + 8;
const KIND = { individual: 'Individual', joint: 'Joint', trust: 'Trust' };

const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const pct = (n) => `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

function wrap(font, size, text, width) {
  const out = [];
  clean(text).split(/\n/).forEach((para) => {
    let line = '';
    para.split(/\s+/).filter(Boolean).forEach((w) => {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
    });
    out.push(line);
  });
  return out;
}

async function embedPhoto(doc, dataUrl) {
  try {
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl || '');
    if (!m) return null;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return m[1].toLowerCase() === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null;   // a photo that cannot be read is left out, the statement still prints
  }
}

/** statement: what /pfs/.../statements returned. photo: the profile's data URL. */
export async function buildPfsPdf({ statement, photo = '', preparedBy = '' }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { profile, asOf } = statement;
  const name = profile.displayName || profile.name || 'Guarantor';
  doc.setTitle(clean(`Personal Financial Statement - ${name}`));
  doc.setCreator('Greens Nexus');
  const today = formatDate(new Date());
  const asOfText = formatDate(asOf);

  let page;
  let y;
  const newPage = (title) => {
    page = doc.addPage([W, H]);
    y = H - MARGIN;
    page.drawText('PERSONAL FINANCIAL STATEMENT', { x: MARGIN, y, size: 8, font: bold, color: BRAND });
    const who = fit(font, 8, `${name}  ${String.fromCharCode(0xb7)}  As of ${asOfText}`, 300);
    page.drawText(who, { x: W - MARGIN - font.widthOfTextAtSize(who, 8), y, size: 8, font, color: MUTED });
    y -= 24;
    if (title) { page.drawText(clean(title), { x: MARGIN, y, size: 16, font: bold, color: INK }); y -= 22; }
  };
  const room = (need, title) => { if (y - need < FLOOR) newPage(title ? `${title} (continued)` : ''); };
  const heading = (text) => {
    room(ROW * 3);
    y -= 6;
    page.drawText(clean(text).toUpperCase(), { x: MARGIN, y, size: 8.5, font: bold, color: MUTED });
    y -= 5;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 0.9, color: INK });
    y -= ROW - 2;
  };
  // A table: cols = [{ label, width, num }], rows = arrays of text. A row may
  // carry `sub`, a second, quieter line under it (a property's address).
  const table = (cols, rows, total, section) => {
    const draw = (cells, f, color) => {
      let x = MARGIN;
      cols.forEach((c, i) => {
        const t = fit(f, 9, cells[i] ?? '', c.width - 8);
        page.drawText(t, { x: c.num ? x + c.width - f.widthOfTextAtSize(t, 9) : x, y, size: 9, font: f, color });
        x += c.width;
      });
    };
    room(ROW * 3, section);
    let x = MARGIN;
    cols.forEach((c) => {
      const t = fit(bold, 7.5, c.label.toUpperCase(), c.width - 8);
      page.drawText(t, { x: c.num ? x + c.width - bold.widthOfTextAtSize(t, 7.5) : x, y, size: 7.5, font: bold, color: MUTED });
      x += c.width;
    });
    y -= 4;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 0.5, color: RULE });
    y -= ROW - 3;
    rows.forEach((r) => {
      room(r.sub ? 11 : 0, section);
      draw(r, font, INK);
      if (r.sub) {
        y -= 11;
        page.drawText(fit(font, 8, r.sub, W - MARGIN * 2 - 8), { x: MARGIN, y, size: 8, font, color: MUTED });
      }
      page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: W - MARGIN, y: y - 4 }, thickness: 0.3, color: RULE });
      y -= ROW;
    });
    if (total) {
      room(4, section);
      page.drawRectangle({ x: MARGIN, y: y - 4, width: W - MARGIN * 2, height: ROW, color: BAND });
      draw(total, bold, INK);
      y -= ROW + 8;
    }
  };

  // ── Cover ─────────────────────────────────────────────────────────────────
  page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: H - 12, width: W, height: 12, color: BRAND });
  y = H - 170;
  const img = await embedPhoto(doc, photo);
  if (img) {
    const size = 96;
    const scale = Math.min(size / img.width, size / img.height);
    page.drawImage(img, { x: MARGIN, y: y - img.height * scale + 20, width: img.width * scale, height: img.height * scale });
    y -= size + 8;
  }
  page.drawText('PERSONAL FINANCIAL STATEMENT', { x: MARGIN, y, size: 10, font: bold, color: BRAND });
  y -= 38;
  wrap(bold, 28, name, W - MARGIN * 2).slice(0, 3).forEach((t) => { page.drawText(t, { x: MARGIN, y, size: 28, font: bold, color: INK }); y -= 34; });
  page.drawText(`As of ${asOfText}`, { x: MARGIN, y, size: 13, font, color: INK });
  y -= 22;
  page.drawText(clean(`${KIND[profile.kind] || 'Individual'} statement  ${String.fromCharCode(0xb7)}  Prepared ${today}${preparedBy ? ` by ${preparedBy}` : ''}`), { x: MARGIN, y, size: 10, font, color: MUTED });
  y -= 60;
  // Net worth at a glance.
  [['Total Assets', statement.totals.assets], ['Total Liabilities', statement.totals.liabilities], ['Net Worth', statement.totals.netWorth]].forEach(([label, v], i) => {
    const f = i === 2 ? bold : font;
    if (i === 2) { page.drawLine({ start: { x: MARGIN, y: y + 13 }, end: { x: MARGIN + 300, y: y + 13 }, thickness: 0.9, color: INK }); }
    page.drawText(label, { x: MARGIN, y, size: 12, font: f, color: INK });
    const t = money(v);
    page.drawText(t, { x: MARGIN + 300 - f.widthOfTextAtSize(t, 12), y, size: 12, font: f, color: INK });
    y -= 22;
  });
  page.drawText('Confidential. Prepared for the lender named by the borrower; not to be shared further.', { x: MARGIN, y: MARGIN + 6, size: 8.5, font, color: MUTED });

  // ── Borrower ──────────────────────────────────────────────────────────────
  newPage('Borrower Information');
  const d = profile.details || {};
  const facts = [
    ['Name', name], ['Statement Type', KIND[profile.kind] || 'Individual'], ['Address', [d.address, d.city_state_zip].filter(Boolean).join(', ')],
    ['Phone', d.phone], ['Email', d.email], ['Date of Birth', d.date_of_birth ? formatDate(d.date_of_birth) : ''], ['Marital Status', d.marital_status],
    ['Employer', d.employer], ['Title', d.title], ['Social Security Number', d.ssn_last4 ? `XXX-XX-${d.ssn_last4}` : ''],
  ].filter(([, v]) => v);
  facts.forEach(([k, v]) => {
    room(0);
    page.drawText(clean(k), { x: MARGIN, y, size: 9.5, font, color: MUTED });
    page.drawText(fit(font, 9.5, v, W - MARGIN * 2 - 170), { x: MARGIN + 170, y, size: 9.5, font, color: INK });
    y -= ROW + 1;
  });
  if ((d.members || []).length) {
    heading('Parties to This Statement');
    d.members.forEach((m) => { room(0); page.drawText(fit(font, 9.5, `${m.name}${m.role ? ` - ${m.role}` : ''}`, W - MARGIN * 2), { x: MARGIN, y, size: 9.5, font, color: INK }); y -= ROW; });
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  const figures = [{ label: 'Description', width: 190 }, { label: 'Institution', width: 124 }, { label: 'Balance', width: 80, num: true }, { label: 'Owned', width: 40, num: true }, { label: 'Adjusted', width: 70, num: true }];
  const lineRows = (g) => g.rows.map((r) => [`${r.label}${r.accountRef ? `  (${r.accountRef})` : ''}`, r.institution, money(r.balance), pct(r.ownershipPct), money(r.adjusted)]);
  if (statement.assets.length) {
    newPage('Assets');
    statement.assets.forEach((g) => { heading(g.label); table(figures, lineRows(g), [`Total ${g.label}`, '', '', '', money(g.total)], 'Assets'); });
  }
  if (statement.liabilities.length) {
    newPage('Liabilities');
    statement.liabilities.forEach((g) => { heading(g.label); table(figures, lineRows(g), [`Total ${g.label}`, '', '', '', money(g.total)], 'Liabilities'); });
  }

  // ── Schedule of real estate ───────────────────────────────────────────────
  if (statement.realEstate.length) {
    newPage('Schedule of Real Estate');
    const cols = [{ label: 'Property', width: 130 }, { label: 'Legal Owner', width: 130 }, { label: 'Owned', width: 38, num: true }, { label: 'Market Value', width: 72, num: true }, { label: 'Loan Balance', width: 72, num: true }, { label: 'Equity', width: 62, num: true }];
    statement.realEstate.forEach((g) => {
      heading(g.label);
      const rows = g.rows.map((r) => {
        const cells = [r.label, r.details?.legal_owner || '', pct(r.ownershipPct), money(r.valueAdjusted), money(r.loanAdjusted), money(r.equity)];
        cells.sub = [r.details?.address, r.details?.property_type, r.details?.lender ? `Lender: ${r.details.lender}` : '', r.details?.interest_rate ? `Rate: ${r.details.interest_rate}` : ''].filter(Boolean).join('  -  ');
        return cells;
      });
      table(cols, rows, [`Total ${g.label}`, '', '', money(g.value), money(g.loan), money(g.value - g.loan)], 'Schedule of Real Estate');
    });
    room(ROW);
    page.drawText('Market value and loan balance are shown at the share owned.', { x: MARGIN, y, size: 8.5, font, color: MUTED });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  newPage('Summary');
  const two = [{ label: '', width: 384 }, { label: 'Amount', width: 120, num: true }];
  heading('Assets');
  table(two, statement.summary.assets.map((x) => [x.label, money(x.amount)]), ['Total Assets', money(statement.totals.assets)], 'Summary');
  heading('Liabilities');
  table(two, statement.summary.liabilities.map((x) => [x.label, money(x.amount)]), ['Total Liabilities', money(statement.totals.liabilities)], 'Summary');
  room(ROW * 2);
  y -= 4;
  page.drawLine({ start: { x: MARGIN, y: y + 14 }, end: { x: W - MARGIN, y: y + 14 }, thickness: 0.8, color: INK });
  page.drawLine({ start: { x: MARGIN, y: y + 11.5 }, end: { x: W - MARGIN, y: y + 11.5 }, thickness: 0.8, color: INK });
  page.drawText('Net Worth', { x: MARGIN, y, size: 12, font: bold, color: INK });
  const nw = money(statement.totals.netWorth);
  page.drawText(nw, { x: W - MARGIN - bold.widthOfTextAtSize(nw, 12), y, size: 12, font: bold, color: INK });
  y -= 30;

  // ── History, profile, signature ───────────────────────────────────────────
  const answered = (profile.history || []).filter((h) => h.answer);
  if (answered.length) {
    newPage('Financial History');
    answered.forEach((h) => {
      const lines = wrap(font, 9.5, h.question, W - MARGIN * 2 - 70);
      room(ROW * lines.length + (h.note ? ROW : 0));
      lines.forEach((t, i) => {
        page.drawText(t, { x: MARGIN, y, size: 9.5, font, color: INK });
        if (i === 0) { const a = clean(h.answer); page.drawText(a, { x: W - MARGIN - bold.widthOfTextAtSize(a, 9.5), y, size: 9.5, font: bold, color: INK }); }
        y -= ROW;
      });
      if (h.note) wrap(font, 9, h.note, W - MARGIN * 2 - 20).forEach((t) => { room(0); page.drawText(t, { x: MARGIN + 12, y, size: 9, font, color: MUTED }); y -= ROW - 2; });
      y -= 4;
    });
  }
  if ((profile.executiveProfile || '').trim()) {
    newPage('Executive Profile');
    wrap(font, 10, profile.executiveProfile, W - MARGIN * 2).forEach((t) => { room(0, 'Executive Profile'); if (t) page.drawText(t, { x: MARGIN, y, size: 10, font, color: INK }); y -= ROW; });
  }
  room(150);
  y -= 24;
  wrap(font, 9, 'I certify that the information in this statement is true, correct and complete as of the date shown, and I authorize the lender to verify it.', W - MARGIN * 2)
    .forEach((t) => { page.drawText(t, { x: MARGIN, y, size: 9, font, color: INK }); y -= ROW - 2; });
  y -= 44;
  const signers = (d.members || []).length && profile.kind !== 'individual' ? d.members.map((m) => m.name) : d.spouse ? [profile.name, d.spouse] : [name];
  signers.slice(0, 4).forEach((who) => {
    room(60);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + 260, y }, thickness: 0.6, color: INK });
    page.drawLine({ start: { x: MARGIN + 300, y }, end: { x: W - MARGIN, y }, thickness: 0.6, color: INK });
    page.drawText(fit(font, 9, who, 260), { x: MARGIN, y: y - 12, size: 9, font, color: MUTED });
    page.drawText('Date', { x: MARGIN + 300, y: y - 12, size: 9, font, color: MUTED });
    y -= 56;
  });

  // ── Footers ───────────────────────────────────────────────────────────────
  const total = doc.getPageCount();
  doc.getPages().forEach((p, i) => {
    if (i === 0) return;
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 8 }, end: { x: W - MARGIN, y: MARGIN - 8 }, thickness: 0.4, color: RULE });
    p.drawText('Confidential', { x: MARGIN, y: MARGIN - 22, size: 8, font, color: MUTED });
    const n = `Page ${i + 1} of ${total}`;
    p.drawText(n, { x: W - MARGIN - font.widthOfTextAtSize(n, 8), y: MARGIN - 22, size: 8, font, color: MUTED });
  });
  return doc.save();
}
