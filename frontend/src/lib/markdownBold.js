// Markdown bold typed as plain text ("a **b** c") - a template pasted or
// imported from an AI draft or a .txt kept the asterisks, and hiring packets
// printed them (Neil, Oct 22). Only a pair on the same text, hugging
// non-space text, is bold; a lone or spaced-out asterisk stays as written.
// Same rule as the server's services/doc_export.split_md_bold.
const MD_BOLD_RE = /\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*/g;

/** [[segment, bold], ...] for `text` with its **pairs** taken out. */
export function splitMdBold(text) {
  if (!text || !text.includes('**')) return [[text, false]];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MD_BOLD_RE)) {
    if (m.index > last) out.push([text.slice(last, m.index), false]);
    out.push([m[1], true]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push([text.slice(last), false]);
  return out.length ? out : [[text, false]];
}

/** A TipTap text node split on its **pairs** - the pairs gain a bold mark. */
export function boldTextNode(node) {
  const parts = splitMdBold(node.text || '');
  if (parts.length === 1 && !parts[0][1]) return [node];
  const hasBold = (node.marks || []).some(m => m.type === 'bold');
  return parts.map(([text, bold]) => ({
    ...node, text,
    ...(bold && !hasBold ? { marks: [...(node.marks || []), { type: 'bold' }] } : {}),
  }));
}
