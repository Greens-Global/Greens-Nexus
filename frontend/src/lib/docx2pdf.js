// ── DOCX → PDF, entirely client-side ──────────────────────────────────────────
// mammoth turns the .docx into clean HTML, then a small flow-layout renderer
// writes it onto US-Letter pages with pdf-lib. Headings, paragraphs with
// bold/italic runs, bullet/numbered lists, simple tables and inline images
// survive; columns, text boxes and exotic Word layout do not (they come out as
// plain flowed text). Both libraries are dynamic imports so this stays out of
// the main bundle until someone actually uploads a Word file.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 56;
const USABLE = PAGE_W - MARGIN * 2;

// pdf-lib standard fonts are WinAnsi-only — swap smart punctuation, drop the rest.
const winAnsi = (s) => String(s)
  .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
  .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
  .replace(/[^\x00-\xFF]/g, '?');

export const isDocx = (fl) => !!fl && (/\.docx$/i.test(fl.name || '')
  || fl.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

// Inline nodes → styled runs [{text, bold, italic}]. Nested lists/tables are
// NOT descended into — they become their own blocks (else their text would be
// concatenated into the parent item with no separators).
function runsOf(node, bold = false, italic = false, out = []) {
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) { if (ch.textContent) out.push({ text: ch.textContent, bold, italic }); continue; }
    if (ch.nodeType !== 1) continue;
    const tag = ch.tagName;
    if (tag === 'BR') { out.push({ text: '\n', bold, italic }); continue; }
    if (tag === 'IMG' || tag === 'UL' || tag === 'OL' || tag === 'TABLE') continue; // lifted out as blocks
    runsOf(ch, bold || tag === 'STRONG' || tag === 'B', italic || tag === 'EM' || tag === 'I', out);
  }
  return out;
}

const imgsOf = (node) => [...node.querySelectorAll('img')].map(im => im.getAttribute('src')).filter(s => s && s.startsWith('data:'));

// Flatten the mammoth HTML body into layout blocks.
function blocksOf(body) {
  const blocks = [];
  const push = (b) => { if (b) blocks.push(b); };
  const pushList = (listEl, depth) => {
    [...listEl.children].filter(li => li.tagName === 'LI').forEach((li, n) => {
      imgsOf(li).forEach(src => push({ kind: 'img', src }));
      push({ kind: 'li', runs: runsOf(li), depth,
             marker: listEl.tagName === 'OL' ? `${n + 1}.` : depth ? '–' : '•' });
      // nested lists become indented items of their own, in place
      [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL')
        .forEach(sub => pushList(sub, depth + 1));
      [...li.children].filter(c => c.tagName === 'TABLE').forEach(t => pushTable(t));
    });
  };
  const pushTable = (el) => {
    const rows = [...el.querySelectorAll('tr')].map(tr =>
      [...tr.children].filter(c => /^T[DH]$/.test(c.tagName))
        .map(c => ({ runs: runsOf(c, c.tagName === 'TH') })));
    if (rows.length) push({ kind: 'table', rows });
    imgsOf(el).forEach(src => push({ kind: 'img', src })); // cell images, after the grid
  };
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        push({ kind: 'h', level: Math.min(4, +tag[1]), runs: runsOf(el, true) });
      } else if (tag === 'P') {
        imgsOf(el).forEach(src => push({ kind: 'img', src }));
        const runs = runsOf(el);
        push({ kind: 'p', runs });
      } else if (tag === 'UL' || tag === 'OL') {
        pushList(el, 0);
      } else if (tag === 'TABLE') {
        pushTable(el);
      } else if (tag === 'IMG') {
        const src = el.getAttribute('src');
        if (src && src.startsWith('data:')) push({ kind: 'img', src });
      } else {
        walk(el); // div/section wrappers — descend
      }
    }
  };
  walk(body);
  return blocks;
}

export async function docxToPdf(file) {
  const mammoth = await import('mammoth'); // same specifier the SOP importer uses
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');

  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const blocks = blocksOf(body);

  const doc = await PDFDocument.create();
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const fontOf = (r) => r.bold && r.italic ? F.bi : r.bold ? F.b : r.italic ? F.i : F.r;
  const ink = rgb(0.07, 0.09, 0.15), lineCol = rgb(0.72, 0.75, 0.78);

  let page = null, y = 0;
  const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const ensure = (h) => { if (!page || y - h < MARGIN) newPage(); };
  newPage();

  // Wrap styled runs into lines that fit `width`; returns [[{text,font,size}]].
  function wrapRuns(runs, size, width) {
    const lines = [[]]; let x = 0;
    for (const r of runs) {
      const font = fontOf(r);
      for (const tok of winAnsi(r.text).split(/(\n|\s+)/)) {
        if (!tok) continue;
        if (tok === '\n') { lines.push([]); x = 0; continue; }
        let w = font.widthOfTextAtSize(tok, size);
        if (x + w > width && x > 0 && tok.trim()) { lines.push([]); x = 0; }
        if (!tok.trim() && x === 0) continue; // no leading whitespace
        // hard-break a single token wider than the whole line
        let t = tok;
        while (w > width && t.length > 1) {
          let cut = t.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(t.slice(0, cut), size) > width) cut--;
          lines[lines.length - 1].push({ text: t.slice(0, cut), font, size });
          lines.push([]); x = 0;
          t = t.slice(cut); w = font.widthOfTextAtSize(t, size);
        }
        lines[lines.length - 1].push({ text: t, font, size });
        x += w;
      }
    }
    return lines.filter((l, i) => l.length || i < lines.length - 1);
  }

  const drawLines = (lines, x0, size, lh) => {
    for (const line of lines) {
      ensure(lh);
      let x = x0;
      for (const seg of line) {
        page.drawText(seg.text, { x, y: y - size * 0.8, size, font: seg.font, color: ink });
        x += seg.font.widthOfTextAtSize(seg.text, size);
      }
      y -= lh;
    }
  };

  for (const b of blocks) {
    if (b.kind === 'h') {
      const size = [0, 19, 15.5, 13, 12][b.level] || 12;
      const lines = wrapRuns(b.runs, size, USABLE);
      if (!lines.length) continue;
      ensure(size * 1.3 + 10); y -= 10;
      drawLines(lines, MARGIN, size, size * 1.3);
      y -= 4;
    } else if (b.kind === 'p') {
      const lines = wrapRuns(b.runs, 11, USABLE);
      if (!lines.length) { y -= 7; continue; } // empty paragraph = spacer
      drawLines(lines, MARGIN, 11, 16);
      y -= 6;
    } else if (b.kind === 'li') {
      const indent = 16 + (b.depth || 0) * 14;
      const lines = wrapRuns(b.runs, 11, USABLE - indent);
      if (!lines.length) continue;
      ensure(16);
      page.drawText(winAnsi(b.marker), { x: MARGIN + 2 + (b.depth || 0) * 14, y: y - 11 * 0.8, size: 11, font: F.r, color: ink });
      drawLines(lines, MARGIN + indent + 6, 11, 16);
      y -= 2;
    } else if (b.kind === 'table') {
      const cols = Math.max(1, ...b.rows.map(r => r.length));
      const colW = USABLE / cols, pad = 4, size = 9.5, lh = 12.5;
      const maxLines = Math.floor((PAGE_H - MARGIN * 2 - pad * 2) / lh); // a row can't exceed one page
      for (const row of b.rows) {
        const cellLines = row.map(c => wrapRuns(c.runs, size, colW - pad * 2).slice(0, maxLines));
        const rowH = Math.max(lh, ...cellLines.map(ls => ls.length * lh)) + pad * 2;
        ensure(rowH);
        const top = y;
        row.forEach((_, ci) => {
          page.drawRectangle({ x: MARGIN + ci * colW, y: top - rowH, width: colW, height: rowH,
            borderColor: lineCol, borderWidth: 0.7 });
          let cy = top - pad;
          for (const line of cellLines[ci]) {
            let x = MARGIN + ci * colW + pad;
            for (const seg of line) {
              page.drawText(seg.text, { x, y: cy - size * 0.8, size, font: seg.font, color: ink });
              x += seg.font.widthOfTextAtSize(seg.text, size);
            }
            cy -= lh;
          }
        });
        y -= rowH;
      }
      y -= 8;
    } else if (b.kind === 'img') {
      try {
        const [, mime, b64] = b.src.match(/^data:(image\/\w+);base64,(.*)$/) || [];
        if (!b64) continue;
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const emb = /png/i.test(mime) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        let w = Math.min(USABLE, emb.width * 0.72);
        let h = w * (emb.height / emb.width);
        if (h > PAGE_H - MARGIN * 2) { // scale-to-fit — never draw past the page edge
          h = PAGE_H - MARGIN * 2;
          w = h * (emb.width / emb.height);
        }
        ensure(h);
        page.drawImage(emb, { x: MARGIN, y: y - h, width: w, height: h });
        y -= h + 8;
      } catch { /* skip images pdf-lib can't decode */ }
    }
  }

  const bytes = await doc.save();
  return new File([bytes], (file.name || 'document').replace(/\.docx?$/i, '') + '.pdf',
    { type: 'application/pdf' });
}
