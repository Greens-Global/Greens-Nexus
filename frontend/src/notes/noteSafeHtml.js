// A note's HTML read back through the editor's own schema (Oct 30 2026).
//
//   normalizeHtml - what the editor would make of this HTML. The server's
//                   copy (sanitized: no checklist <label><input>, no link
//                   target/rel, no table style) and the editor's own
//                   getHTML() of the same words come out identical, so the
//                   merge compares words, not markup (notesMerge.js).
//   safeHtml      - the same with `strict` on: only the schema's tags, each
//                   attribute through the checked renderHTML in
//                   noteExtensions.js, clips only from our storage. For HTML
//                   shown outside the editor that did not come from the
//                   server's sanitizer (a clash's "Yours", Compare With Now
//                   against words typed live).
import { generateHTML, generateJSON } from '@tiptap/core';
import { buildExtensions } from './noteExtensions';

let loose = null;
let strict = null;

export function normalizeHtml(html, { strict: isStrict = false } = {}) {
  const exts = isStrict ? (strict ||= buildExtensions('', null, { strict: true })) : (loose ||= buildExtensions(''));
  try {
    return generateHTML(generateJSON(html || '', exts), exts);
  } catch {
    return '';
  }
}

export const safeHtml = (html) => normalizeHtml(html, { strict: true });
