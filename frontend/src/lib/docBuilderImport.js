// Document import (Phase 10, hardened Phase 16) — turns an uploaded Word/PDF/
// text file into either a TipTap JSON body (docx — see below) or an HTML
// string that the caller runs through generateJSON() with BODY_EXTENSIONS
// (docBuilderSchema.js) for everything else. This module stays UI/storage-
// agnostic: image bytes are handed to the caller-supplied `uploadImage`
// rather than uploaded here, so it doesn't need to know about Supabase, a
// document id, or any path convention.
//
// Format scope:
// - .docx: reads the raw OOXML directly (docxToTiptap.js) instead of going
//   through mammoth's HTML conversion — mammoth intentionally discards
//   direct (non-named-style) font family/size/color/highlight and paragraph
//   alignment, which is the actual cause of "the font/size changed on
//   import" for ordinary Word documents. The direct converter preserves
//   those, plus heading levels, bullet/numbered lists (incl. basic nesting),
//   tables (incl. cell shading), images, page breaks, and even the source
//   page size/orientation/margins (mapped onto this editor's Page Setup).
//   See docxToTiptap.js's own header comment for the honest, permanent list
//   of what this editor's schema still can't represent (footnotes, tracked
//   changes, multi-level numbering styles beyond bullet/decimal, etc.) — no
//   importer can close those without a different editor.
// - .pdf: best-effort TEXT ONLY (paragraphs/headings/bold heuristics) — PDF
//   isn't a flow-document format, so layout/tables/images/columns are not
//   recoverable here. Always carries a warning saying so.
// - .doc (legacy binary Word): rejected — no reader here (or mammoth) has
//   ever supported the old binary format. Same message SOP.jsx already uses
//   for the identical limitation.
// - .txt / unknown: blank-line-separated paragraphs.

const _importLimit = (name) => (/\.(pdf|docx?)$/i.test(name) ? 15 : 2) * 1024 * 1024;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extOf(name) {
  const n = (name || '').toLowerCase();
  return n.slice(n.lastIndexOf('.'));
}

async function importDocx(file, uploadImage) {
  const { convertDocxToTiptap } = await import('./docxToTiptap');
  try {
    const { body, pageSetup } = await convertDocxToTiptap(file, { uploadImage });
    return { json: body, pageSetup, warnings: [] };
  } catch (e) {
    // A malformed/unusual .docx (rare, but real — e.g. one written by a
    // non-Word tool with slightly off-spec XML) must not leave the user with
    // zero options. Mammoth's own, more forgiving HTML conversion is a
    // fallback here, at the cost of the font/size/color/alignment fidelity
    // this module exists to fix — better than a hard failure.
    const mammoth = await import('mammoth');
    let n = 0;
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        try {
          const bytes = await image.readAsArrayBuffer();
          const url = await uploadImage?.(bytes, image.contentType || 'image/png', ++n);
          return { src: url || '' };
        } catch {
          return { src: '' };
        }
      }),
    });
    const warnings = [
      'Used a simplified import for this file (its formatting was not fully readable) — fonts, sizes, and exact layout may not be fully preserved.',
      ...(result.messages || []).map(m => m.message).filter(Boolean),
    ];
    return { html: result.value, warnings };
  }
}

// Groups pdfjs text items into rows (by Y proximity, using content-stream
// adjacency, which is reliable for pairing text WITHIN a row) and then
// SORTS those rows into true visual reading order before doing anything
// else. That sort is the fix for a real bug: pdfjs's content.items — and
// PDF generators in general (notably browser print-to-PDF, which can batch
// draw calls by font/color for stream efficiency rather than emit them in
// visual top-to-bottom order) — do not guarantee stream order matches
// visual order. Trusting stream order caused whole sections (e.g. every
// heading) to jump to the top of the import regardless of where they
// actually sit on the page. Sorting is a safe, idempotent fix: it can only
// correct already-correct order into itself, never make it worse.
//
// Rows with 2+ horizontally-separated segments (a wide gap between two
// pieces of text on the same line — e.g. a label and its value) are
// candidate table cells. A run of 2+ consecutive same-column-count rows on
// the same page becomes a real <table>, not scattered disconnected lines —
// this recovers the most common PDF "table" shape (simple label/value or
// grid reports) even though arbitrary PDF table layout in general is not
// recoverable (documented scope boundary, still true for anything more
// complex than this).
async function importPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;

  const rows = []; // { page, y, size, bold, segments: [{text, x, endX}] }
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let curRow = null;
    let pendingSplit = false; // set when a wide whitespace-only "filler" item just closed a column gap
    for (const item of content.items) {
      if (!item.str) continue;
      const size = Math.abs(item.transform[3]) || 10;
      const x = item.transform[4];
      const y = item.transform[5];
      const endX = x + (item.width || item.str.length * size * 0.5);
      // pdf.js's TextItem.fontName is an internal id (e.g. "g_d0_f1"), never
      // the PDF's actual font name — this can never match "Helvetica-Bold"
      // etc. regardless of whether the source text is really bold. Kept
      // anyway (harmless — it just never fires) rather than removed, in
      // case a future pdf.js version exposes the real name for some fonts.
      const bold = /bold/i.test(item.fontName || '');
      // pdfjs represents the horizontal gap between two drawString() calls as
      // a synthetic whitespace-only item whose OWN width spans the entire
      // gap (not a real space character's width) — e.g. drawString('label',
      // x=72) then drawString('value', x=300) produces a real "label" item,
      // then a fake " " item covering x=133..300, then the real "value" item
      // starting exactly where the filler ends. That filler's huge width was
      // silently absorbing the column gap before the real gap-check on the
      // next item ever saw it, merging label+value into one segment instead
      // of splitting into a real table column — this is the actual bug the
      // user's report exposed. A whitespace-only item much wider than a
      // plausible single space (> size*3) is that filler; treat it as a
      // column separator and don't fold its (meaningless) text in.
      const isWideFiller = item.str.trim() === '' && (item.width || 0) > size * 3;
      if (isWideFiller) {
        if (curRow && curRow.page === p && Math.abs(curRow.y - y) < size * 0.4) pendingSplit = true;
        continue;
      }
      if (curRow && curRow.page === p && Math.abs(curRow.y - y) < size * 0.4) {
        const last = curRow.segments[curRow.segments.length - 1];
        if (pendingSplit || x - last.endX > size * 1.5) {
          curRow.segments.push({ text: item.str, x, endX });
        } else {
          last.text += item.str;
          last.endX = endX;
        }
        pendingSplit = false;
        curRow.size = Math.max(curRow.size, size);
        curRow.bold = curRow.bold || bold;
      } else {
        curRow = { page: p, y, size, bold, segments: [{ text: item.str, x, endX }] };
        rows.push(curRow);
        pendingSplit = false;
      }
    }
  }
  if (!rows.length) return { html: '', warnings: ['No extractable text found in this PDF (it may be a scanned image).'] };

  // Restore real visual reading order — see the function comment above.
  rows.sort((a, b) => a.page - b.page || b.y - a.y);

  const blocks = []; // { type: 'table', rows } | { type: 'para', text, size, bold }
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.segments.length >= 2) {
      const cols = row.segments.length;
      let j = i + 1;
      while (j < rows.length && rows[j].page === row.page && rows[j].segments.length === cols) j++;
      if (j - i >= 2) {
        blocks.push({ type: 'table', rows: rows.slice(i, j) });
        i = j;
        continue;
      }
    }
    // Paragraph path: merge this row with following rows via vertical gap,
    // stopping at any multi-segment (table-candidate) row.
    let text = row.segments.map(s => s.text.trim()).join('  ');
    let size = row.size, bold = row.bold;
    let lastY = row.y;
    let rowSpan = 1;
    let k = i + 1;
    while (k < rows.length) {
      const nxt = rows[k];
      const gap = lastY - nxt.y;
      if (nxt.page !== row.page || nxt.segments.length >= 2 || !(gap > 0 && gap < nxt.size * 1.8)) break;
      text += ' ' + nxt.segments.map(s => s.text.trim()).join('  ');
      size = Math.max(size, nxt.size);
      bold = bold && nxt.bold;
      lastY = nxt.y;
      rowSpan++;
      k++;
    }
    blocks.push({ type: 'para', text: text.trim(), size, bold, rowSpan });
    i = k;
  }

  // Baseline "body text" size. A real document (esp. a signed-certificate-
  // style PDF: SHA-256 hash, audit-chain log, tiny disclaimers) often has far
  // more fine-print ROWS than visible body paragraphs even though the fine
  // print is visually a minor part of the page — sampling every row equally
  // (the old approach: a global median across every raw text item) let that
  // fine print drag the baseline down, so ordinary body text ended up
  // looking disproportionately large by comparison and got misclassified as
  // a heading (rendered bold+large by the browser — i.e. "everything turned
  // bold"). The reliable signal genuine body text has that fine print/labels/
  // headers almost never do: it WRAPS across multiple merged rows (rowSpan
  // >= 2) — a real paragraph of prose runs long enough to wrap, a footer
  // disclaimer or log line usually doesn't. Prefer the mode among only those
  // multi-row blocks; fall back to every block if the document has none
  // (e.g. it's all short lines). An absolute floor (must be bigger by a few
  // points, not just proportionally) is a second, independent safety net.
  const wrapped = blocks.filter(b => b.type === 'para' && b.text && b.rowSpan >= 2);
  const paraSizes = (wrapped.length ? wrapped : blocks.filter(b => b.type === 'para' && b.text)).map(b => Math.round(b.size * 2) / 2);
  const counts = new Map();
  for (const s of paraSizes) counts.set(s, (counts.get(s) || 0) + 1);
  let bodySize = 10;
  let bestCount = 0;
  for (const [s, c] of counts) { if (c > bestCount) { bestCount = c; bodySize = s; } }

  const html = blocks.map(b => {
    if (b.type === 'table') {
      const trs = b.rows.map(r => `<tr>${r.segments.map(s => `<td>${escapeHtml(s.text.trim())}</td>`).join('')}</tr>`).join('');
      return `<table>${trs}</table>`;
    }
    if (!b.text) return '';
    const text = escapeHtml(b.text);
    const body = b.bold ? `<strong>${text}</strong>` : text;
    if (b.size >= bodySize * 1.6 && b.size >= bodySize + 6) return `<h1>${body}</h1>`;
    if (b.size >= bodySize * 1.25 && b.size >= bodySize + 3) return `<h2>${body}</h2>`;
    return `<p>${body}</p>`;
  }).filter(Boolean).join('\n');

  return { html, warnings: ['PDF import reconstructs text and simple tables — exact layout, images, and complex/merged-cell tables are not preserved.'] };
}

async function importTxt(file) {
  const text = await file.text();
  const html = text.split(/\n\s*\n/).map(block => `<p>${escapeHtml(block.trim()).replace(/\n/g, '<br/>')}</p>`).join('\n');
  return { html, warnings: [] };
}

export async function importDocumentFile(file, { uploadImage } = {}) {
  if (!file) throw new Error('No file selected');
  const ext = extOf(file.name);
  if (file.size > _importLimit(file.name)) {
    throw new Error(`That file is too large — keep it under ${Math.round(_importLimit(file.name) / 1024 / 1024)} MB.`);
  }
  if (ext === '.docx') return importDocx(file, uploadImage);
  if (ext === '.doc') {
    throw new Error('Old .doc files aren’t supported — open it in Word, "Save As" .docx, and upload that.');
  }
  if (ext === '.pdf') return importPdf(file);
  return importTxt(file);
}
