// What the ticket form starts with when a question is handed over from help
// (Ask Nexus, "I Need To..." - Help Center, Oct 2026): the question as the
// title (shortened at a word) and in full as the description.
export function ticketSeedFor(question, extra = {}) {
  const q = String(question || '').trim();
  const subject = q.length > 120 ? `${q.slice(0, 117).replace(/\s+\S*$/, '')}...` : q;
  return { subject, description: q, ...extra };
}

/** Plain text -> the description editor's HTML, one paragraph per line. */
export function seedHtml(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return t.split(/\n+/).map((line) => `<p>${esc(line)}</p>`).join('');
}
