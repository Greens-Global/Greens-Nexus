// Runs the BUILT PDF and Word-import chunks (11/03/2026) - postbuild, after
// check-bundle-size.mjs. Three build-time rewrites in vite.config.js change
// what those chunks contain without changing what they do: pdf-lib uses the
// whiteboard engine's pako 2 (pdfLibSharesPako), mammoth's XML writer is a
// stub (mammothXmlWriterStub) and its symbol-font table is written compactly
// (compactDingbats). Vitest runs the packages as installed, so this is the
// check that what ships still works: it makes and reloads a PDF with a
// standard font through dist/assets/vendor-pdf-*, and converts a small Word
// file with a Wingdings symbol through dist/assets/vendor-docx-*. Plain Node,
// no browser; a failure fails the build like the size budget does.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/assets', import.meta.url));
const NM = fileURLToPath(new URL('../node_modules', import.meta.url));
const files = readdirSync(DIST);
const chunk = (prefix) => {
  const f = files.find((n) => n.startsWith(prefix) && n.endsWith('.js'));
  if (!f) throw new Error(`no ${prefix}*.js in dist/assets`);
  return join(DIST, f);
};
// The chunks export minified names; find the library objects by their shape.
const pick = (mod, test) => {
  for (const v of Object.values(mod)) {
    try { if (v && test(v)) return v; } catch { /* not it */ }
    if (typeof v === 'function' && !v.prototype?.constructor?.name) {
      try { const r = v(); if (r && test(r)) return r; } catch { /* not a lazy CommonJS wrapper */ }
    }
  }
  return null;
};

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

async function checkPdf() {
  const path = chunk('vendor-pdf-');
  check(/from\s*["']\.\/vendor-pako-/.test(readFileSync(path, 'utf8')), 'vendor-pdf does not import the shared vendor-pako chunk');
  // vendor-pdf also carries pdf.js, which wants a few browser classes when it
  // loads (and warns that Node should use its legacy build). Only pdf-lib is
  // exercised here, so empty stand-ins are enough.
  for (const name of ['DOMMatrix', 'Path2D', 'ImageData']) globalThis[name] ??= class {};
  const warn = console.warn;
  console.warn = () => {};
  let mod;
  try { mod = await import(pathToFileURL(path).href); } finally { console.warn = warn; }
  const PDFDocument = pick(mod, (v) => typeof v.create === 'function' && typeof v.load === 'function' && typeof v.prototype?.save === 'function');
  const StandardFonts = pick(mod, (v) => v.Helvetica === 'Helvetica' && v.ZapfDingbats === 'ZapfDingbats');
  if (!PDFDocument || !StandardFonts) { problems.push('pdf-lib not found in vendor-pdf'); return; }
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);   // inflates the font metrics
  page.drawText('Nexus bundle check', { x: 20, y: 100, size: 14, font });
  const bytes = await doc.save();                                   // deflates the content stream
  const text = Buffer.from(bytes).toString('latin1');
  check(text.startsWith('%PDF-') && text.includes('/FlateDecode'), 'the built pdf-lib wrote no compressed PDF');
  check((await PDFDocument.load(bytes)).getPageCount() === 1, 'the built pdf-lib could not read its own PDF back');
}

async function checkDocx() {
  const path = chunk('vendor-docx-');
  const src = readFileSync(path, 'utf8');
  check(src.includes('Writing Word files is not available in Nexus'), 'the mammoth xmlbuilder stub is missing from vendor-docx');
  check((src.match(/Dingbat hex/g) || []).length <= 2, 'the dingbat table shipped uncompacted');
  const mod = await import(pathToFileURL(path).href);
  const mammoth = pick(mod, (v) => typeof v.convertToHtml === 'function');
  const JSZip = pick(mod, (v) => typeof v === 'function' && typeof v.loadAsync === 'function');
  if (!mammoth || !JSZip) { problems.push('mammoth or JSZip not found in vendor-docx'); return; }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Checked </w:t></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p></w:body></w:document>');
  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  const { value } = await mammoth.convertToHtml({ arrayBuffer });
  // The expected symbol comes from the package's own (uncompacted) table.
  const table = (() => { const m = { exports: {} }; new Function('exports', 'module', readFileSync(join(NM, 'dingbat-to-unicode/dist/dingbats.js'), 'utf8'))(m.exports, m); return m.exports.default; })();
  const row = table.find((r) => r['Typeface name'] === 'Wingdings' && r['Dingbat dec'] === '252');
  const want = row ? String.fromCodePoint(Number(row['Unicode dec'])) : '';
  check(want && value === `<p>Checked ${want}</p>`, `the built mammoth converted the check file to ${JSON.stringify(value)}, expected <p>Checked ${want}</p>`);
}

try {
  await checkPdf();
  await checkDocx();
} catch (e) {
  problems.push(`threw: ${e?.stack || e}`);
}
if (problems.length) {
  console.error('\nBuilt PDF / Word-import chunks failed their check:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nSee the plugin that rewrote them in vite.config.js (pdfLibSharesPako, mammothXmlWriterStub, compactDingbats).');
  process.exit(1);
}
console.log('bundle rewrites OK: the built pdf-lib makes and reads a PDF, the built mammoth converts a Word file with a symbol');
