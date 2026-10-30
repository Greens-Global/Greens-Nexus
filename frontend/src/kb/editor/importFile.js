// Import As Is (Oct 29 2026): a Word or PDF file becomes Knowledge Base
// blocks with no AI. The browser reads the file with the same readers the
// Documents module uses (lib/docBuilderImport.js: Word keeps headings, lists,
// tables, bold and pictures in place; PDF keeps text and simple tables),
// pictures go to the private kb-media bucket, and POST /kb/import/convert
// turns the result into the page's block shape. The original file is
// uploaded too and attached at the end of the page. Nothing is saved as a
// page here - the caller opens the result as a draft or a lesson.
import { api } from '../../api';

export const IMPORT_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export const importKind = (name) => {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.docx')) return 'docx';
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.doc')) return 'doc';
  return '';
};

export const baseTitle = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function bytesToDataUrl(bytes, mime) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read a picture'));
    r.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

// Reads one Word or PDF file. Returns {blocks, title, words, images, tables, warnings}.
export async function importFileAsIs(file, { keepOriginal = true, onStep } = {}) {
  const kind = importKind(file?.name);
  if (kind === 'doc') throw new Error('Old .doc files are not supported. Open it in Word, Save As .docx, and import that.');
  if (!kind) throw new Error('Choose a Word (.docx) or PDF file.');
  if (file.size > IMPORT_MAX_BYTES) throw new Error('That file is larger than 15 MB. Split it, or compress its pictures.');

  const warnings = [];
  let skipped = 0;
  let failed = 0;
  const uploadImage = async (bytes, mime) => {
    const ct = String(mime || '').toLowerCase();
    if (!IMAGE_TYPES.includes(ct)) { skipped += 1; return ''; }
    try {
      const out = await api.kbUploadMedia(await bytesToDataUrl(bytes, ct), 'imports');
      return out?.url || '';
    } catch { failed += 1; return ''; }
  };

  onStep?.('Reading the file');
  const { importDocumentFile } = await import('../../lib/docBuilderImport');
  const read = await importDocumentFile(file, { uploadImage });
  (read.warnings || []).forEach((w) => warnings.push(w));
  let body = read.json;
  if (!body) {
    const [{ generateJSON }, { BODY_EXTENSIONS }] = await Promise.all([import('@tiptap/core'), import('../../lib/docBuilderSchema')]);
    body = generateJSON(read.html || '<p></p>', BODY_EXTENSIONS);
  }
  if (skipped) warnings.push(`${skipped} picture${skipped === 1 ? ' is' : 's are'} in a format the page cannot show (for example a Word drawing). Add ${skipped === 1 ? 'it' : 'them'} again as an image if needed.`);
  if (failed) warnings.push(`${failed} picture${failed === 1 ? '' : 's'} could not be uploaded.`);

  let original = null;
  if (keepOriginal) {
    onStep?.('Attaching the original file');
    try {
      const dataUrl = await bytesToDataUrl(await file.arrayBuffer(), MIME[kind]);
      const out = await api.kbUploadMedia(dataUrl, 'imports');
      if (out?.url) original = { url: out.url, name: file.name, size: file.size, mime: MIME[kind] };
    } catch { warnings.push('The original file could not be attached. The page content was still imported.'); }
  }

  onStep?.('Building the page');
  const res = await api.kbImportConvert({ body, title: baseTitle(file.name), original });
  if (!res?.words && !res?.images && kind === 'pdf') {
    warnings.push('This PDF has no text that can be selected. It is probably a scan: the file is attached, but type or paste the steps into the page.');
  }
  return { ...res, warnings };
}
