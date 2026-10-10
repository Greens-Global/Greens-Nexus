// Contact Directory -> PDF (Neil, 10/10): a contact sheet of the people on
// screen - already filtered by company / office / quick chip / search - as a
// printable, shareable file. Name and title, email, mobile, office phone, who
// they report to and where they sit, grouped by department with the lead
// first; then the reporting line as an indented outline, which is the org
// chart in a form that prints. Mobile numbers are included: they are shown to
// everyone in the directory (Neil, 10/09 and 10/10), and what is on screen is
// what exports.
//
// Client-side, like the Task module's exports (tasks/exporting.js): the rows
// are already in the browser, and rebuilding the screen's filter state on the
// server would mean keeping two filter models in step. pdf-lib is imported
// on demand - it is ~350KB and most visits never export.
import { formatDateTime } from '../lib/datetime';
import { groupByDepartment, buildTree, splitTree, NO_DEPARTMENT } from './lib';

const PAGE_W = 792, PAGE_H = 612;      // US Letter, landscape
const MARGIN = 36;
const ROW_H = 24;
const HEAD_H = 18;
const SECTION_H = 20;
const FONT = 8.5, SMALL = 7.5, TITLE = 16;

// The standard Helvetica font encodes WinAnsi: printable ASCII plus Latin-1,
// so names like José, Müller or Zoë print as written. pdf-lib throws on
// anything else (emoji, most non-Latin scripts) rather than dropping it, so
// dashes, smart quotes and the ellipsis map to plain forms, other accented
// Latin letters (Ł, ş) lose their accent, and the rest is dropped - one odd
// title never fails the whole file.
export const ascii = (s) => String(s ?? '')
  .replace(/[‘’‛]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/…/g, '...')
  .replace(/\u00a0/g, ' ')
  .replace(/[^\x20-\x7E\u00A1-\u00FF]/g, (ch) => ch.normalize('NFD').replace(/[^\x20-\x7E]/g, ''));

const COLUMNS = (multiCompany) => [
  { header: 'Name / Title', w: 24, get: (p) => p.name, sub: (p) => p.jobTitle },
  { header: 'Email', w: 24, get: (p) => p.email },
  { header: 'Mobile', w: 12, get: (p) => p.mobile },
  { header: 'Office Phone', w: 12, get: (p) => p.officePhone },
  { header: 'Reports To', w: 16, get: (p) => p.managerName || (p.managerEmail ? p.managerEmail : '') },
  { header: 'Office', w: 14, get: (p) => [p.location, [p.city, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' - ') },
  ...(multiCompany ? [{ header: 'Company', w: 12, get: (p) => p.companyName }] : []),
];

/** The PDF as bytes. `people` are the rows on screen; `scope` is a short
 * line naming the filters in force (empty when none). */
export async function directoryPdfBytes({ people, companyName = '', scope = '', generatedAt = new Date() }) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle('Contact Directory');
  doc.setProducer('Nexus');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const INK = rgb(0.12, 0.14, 0.18), DIM = rgb(0.42, 0.45, 0.5), FAINT = rgb(0.55, 0.58, 0.63);
  const BAND = rgb(0.95, 0.96, 0.97), ZEBRA = rgb(0.975, 0.978, 0.982);

  const fit = (text, width, f, size) => {
    let s = ascii(text);
    if (f.widthOfTextAtSize(s, size) <= width) return s;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}...`, size) > width) s = s.slice(0, -1);
    return `${s}...`;
  };

  const multiCompany = new Set(people.map((p) => p.companyName).filter(Boolean)).size > 1;
  const columns = COLUMNS(multiCompany);
  const totalW = PAGE_W - MARGIN * 2;
  const sum = columns.reduce((a, c) => a + c.w, 0);
  const widths = columns.map((c) => (c.w / sum) * totalW);

  let page = null, y = 0;
  const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const need = (h) => { if (!page || y - h < MARGIN + 18) newPage(); };

  const title = (text, sub) => {
    need(TITLE + 30);
    page.drawText(ascii(text), { x: MARGIN, y: y - TITLE, size: TITLE, font: bold, color: INK });
    if (sub) page.drawText(ascii(sub), { x: MARGIN, y: y - TITLE - 13, size: 9, font, color: DIM });
    y -= TITLE + (sub ? 26 : 14);
  };
  const columnHead = () => {
    need(HEAD_H + ROW_H);
    page.drawRectangle({ x: MARGIN, y: y - HEAD_H, width: totalW, height: HEAD_H, color: BAND });
    let x = MARGIN;
    columns.forEach((c, i) => {
      page.drawText(fit(c.header, widths[i] - 8, bold, FONT), { x: x + 4, y: y - HEAD_H + 6, size: FONT, font: bold, color: DIM });
      x += widths[i];
    });
    y -= HEAD_H;
  };

  // ── Page 1+: the contact sheet, grouped by department ───────────────────
  const when = formatDateTime(generatedAt);
  const count = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
  title(companyName ? `${companyName} - Contact Directory` : 'Contact Directory',
    [count, scope, `Generated ${when}`].filter(Boolean).join('  ·  '));

  const groups = groupByDepartment(people);
  groups.forEach((g) => {
    need(SECTION_H + HEAD_H + ROW_H);
    page.drawText(`${ascii(g.name)}  (${g.people.length})`, { x: MARGIN, y: y - SECTION_H + 6, size: 10, font: bold, color: INK });
    y -= SECTION_H;
    columnHead();
    g.people.forEach((p, ri) => {
      if (y - ROW_H < MARGIN + 18) { newPage(); columnHead(); }
      if (ri % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: totalW, height: ROW_H, color: ZEBRA });
      let x = MARGIN;
      columns.forEach((c, i) => {
        const main = c.get(p) || '';
        const sub = c.sub ? c.sub(p) : '';
        const lead = i === 0 && p.departmentRole === 'lead' ? '  (Lead)' : '';
        if (sub) {
          page.drawText(fit(main + lead, widths[i] - 8, i === 0 ? bold : font, FONT), { x: x + 4, y: y - 10, size: FONT, font: i === 0 ? bold : font, color: INK });
          page.drawText(fit(sub, widths[i] - 8, font, SMALL), { x: x + 4, y: y - ROW_H + 5, size: SMALL, font, color: DIM });
        } else {
          page.drawText(fit(main + lead, widths[i] - 8, i === 0 ? bold : font, FONT), { x: x + 4, y: y - ROW_H / 2 - 3, size: FONT, font: i === 0 ? bold : font, color: INK });
        }
        x += widths[i];
      });
      y -= ROW_H;
    });
    y -= 10;
  });

  // ── Reporting line: the org chart as an outline ────────────────────────
  const { trees, loose } = splitTree(buildTree(people));
  if (trees.length) {
    newPage();
    title('Reporting Line', 'Who reports to whom, top down. Indentation is one level of the organization chart.');
    const LINE = 14;
    const line = (p, depth) => {
      need(LINE);
      const x = MARGIN + depth * 16;
      if (depth > 0) page.drawText('-', { x: x - 9, y: y - LINE + 4, size: FONT, font, color: FAINT });
      const name = fit(p.name, Math.max(60, PAGE_W - MARGIN - x), bold, FONT);
      page.drawText(name, { x, y: y - LINE + 4, size: FONT, font: bold, color: INK });
      const rest = [p.jobTitle, p.department === NO_DEPARTMENT ? '' : p.department].filter(Boolean).join(' · ');
      const nx = x + bold.widthOfTextAtSize(name, FONT) + 6;
      if (rest && PAGE_W - MARGIN - nx > 40) {
        page.drawText(fit(rest, PAGE_W - MARGIN - nx, font, SMALL), { x: nx, y: y - LINE + 4, size: SMALL, font, color: DIM });
      }
      y -= LINE;
    };
    const walk = (n, depth) => { line(n.person, depth); n.children.forEach((c) => walk(c, depth + 1)); };
    trees.forEach((t) => { walk(t, 0); y -= 6; });
    if (loose.length) {
      need(SECTION_H + LINE);
      y -= 4;
      page.drawText(`Not connected (${loose.length}) - no manager on record, or one outside this list`, { x: MARGIN, y: y - SECTION_H + 6, size: 9, font: bold, color: DIM });
      y -= SECTION_H;
      loose.forEach((p) => line(p, 0));
    }
  }

  // Footer on every page, once the count is known.
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawText(`${ascii(companyName || 'Nexus')} Contact Directory  -  internal use  -  ${count}  -  ${when}  -  page ${i + 1} of ${pages.length}`,
      { x: MARGIN, y: MARGIN - 14, size: 8, font, color: FAINT });
  });
  return doc.save();
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);   // Safari cancels a download whose URL vanishes at once
}

export async function exportDirectoryPdf(spec) {
  const bytes = await directoryPdfBytes(spec);
  saveBlob(new Blob([bytes], { type: 'application/pdf' }), `contact-directory-${new Date().toISOString().slice(0, 10)}.pdf`);
}
