// Wrap Up (Neil, 11/12/2026): a meeting board turned into a Note people can
// read and send. Until now a board ended as a picture - nothing came out of
// the stickies, the votes and the comments but a PNG. Wrap Up reads the
// board by RULES, never AI (Nexus's AI is off, and none is needed):
//
//   - each section (sections.js) is a heading, in the order Present reads them
//   - each sticky in it is a point, with who wrote it and its votes
//   - what sits in no section goes under Other
//   - the items with votes lead, most votes first
//   - comment threads still open are Open Questions, replies under them
//   - stickies made into tasks are listed as links to the tasks
//   - the board itself is embedded at the top, so the Note opens it
//
// Votes are only what Show Results stamped on the board: a vote still under
// way is private to each voter (meet.js) and never appears here. Private
// Writing's hidden stickies are not on the board at all until revealed.
//
// Engine-free and pure: elements in, { title, html, counts } out. The HTML is
// the Notes editor's own (headings, lists, the boardEmbed and recordLink
// anchors routers/notes.py keeps); Board.jsx makes the Note and shares it
// with the same people as the board.
import { stickyParts, stickyWords } from './stickies';
import { pinParts, threadOf } from './threads';
import { sections, sectionOf, sectionName } from './sections';
import { splitRef } from '../recordLink';
import { formatDate, formatTime } from '../../lib/datetime';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const first = (n) => one(n).split(' ')[0] || '';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const votesOf = (e) => {
  const v = e?.customData?.nexusVotes;
  const count = Number(v?.count) || 0;
  return count > 0 ? { count, names: (Array.isArray(v.names) ? v.names : []).map(first).filter(Boolean) } : null;
};
const voteWords = (v) => `${plural(v.count, 'Vote')}${v.names.length ? ` - ${v.names.join(', ')}` : ''}`;

/** What the board holds, as plain data: { groups: [{ name, items }], top, questions, tasks }. */
export function wrapUpData(elements) {
  const els = (elements || []).filter((e) => e && !e.isDeleted);
  const frames = sections(els);
  const textOf = new Map(els.filter((e) => e.type === 'text' && e.containerId).map((e) => [e.containerId, e]));
  const items = [];
  for (const p of stickyParts(els).values()) {
    const words = stickyWords(p);
    if (!words) continue;
    const ref = splitRef(p.box.customData?.nexusRecord?.ref || '');
    items.push({ id: p.box.id, words, by: one(p.box.customData.nexusSticky.name), votes: votesOf(p.box), x: p.box.x, y: p.box.y,
      section: sectionOf(els, p.box, frames), taskId: ref.kind === 'task' ? ref.id : '' });
  }
  // A plain box people voted on counts too - its result would otherwise be lost.
  for (const e of els) {
    if (e.customData?.nexusSticky || e.customData?.nexusComment || !votesOf(e)) continue;
    const words = one(textOf.get(e.id)?.originalText || textOf.get(e.id)?.text);
    if (words) items.push({ id: e.id, words, by: '', votes: votesOf(e), x: e.x, y: e.y, section: sectionOf(els, e, frames), taskId: '' });
  }
  const read = (a, b) => a.y - b.y || a.x - b.x;
  const groups = frames.map((f) => ({ name: sectionName(f), items: items.filter((i) => i.section === f.id).sort(read) })).filter((g) => g.items.length);
  const loose = items.filter((i) => !i.section).sort(read);
  if (loose.length) groups.push({ name: groups.length ? 'Other' : 'Notes', items: loose });
  const top = items.filter((i) => i.votes).sort((a, b) => b.votes.count - a.votes.count || read(a, b));
  const questions = [...pinParts(els).values()]
    .map((p) => ({ number: Number(p.box.customData.nexusComment) || 0, thread: threadOf(p) }))
    .filter((q) => !q.thread.resolved && one(q.thread.text))
    .sort((a, b) => a.number - b.number)
    .map((q) => ({ text: one(q.thread.text), by: one(q.thread.name), replies: q.thread.replies.map((r) => ({ text: one(r.text), by: one(r.name) })).filter((r) => r.text) }));
  const tasks = items.filter((i) => i.taskId).sort(read).map((i) => ({ id: i.taskId, words: i.words }));
  return { groups, top, questions, tasks, stickies: items.length };
}

const point = (i) => `<li>${esc(i.words)}${i.by ? ` - ${esc(i.by)}` : ''}${i.votes ? ` (${esc(voteWords(i.votes))})` : ''}</li>`;

/**
 * The Note a board wraps up into, or null when the board has nothing to say
 * yet (no words on a sticky, no open comment). `board` = { id, title,
 * thumbUrl }; `by` = who pressed it; `now` a Date.
 */
export function wrapUpNote(elements, board = {}, { by = '', now = new Date() } = {}) {
  const d = wrapUpData(elements);
  if (!d.stickies && !d.questions.length) return null;
  const name = one(board.title) || 'Untitled Board';
  const out = [];
  if (board.id) {
    // A block of its own, as Insert Board writes it (BoardEmbed.jsx) - never inside a paragraph.
    out.push(`<a data-type="boardEmbed" data-note="${esc(board.id)}"${board.thumbUrl ? ` data-thumb="${esc(board.thumbUrl)}"` : ''} title="${esc(name)}">${esc(name)}</a>`);
  }
  const parts = [plural(d.stickies, 'sticky', 'stickies')];
  if (d.groups.length > 1) parts.push(plural(d.groups.length, 'section'));
  if (d.questions.length) parts.push(plural(d.questions.length, 'open question'));
  if (d.tasks.length) parts.push(plural(d.tasks.length, 'task'));
  out.push(`<p>Wrapped up ${esc(formatDate(now))} at ${esc(formatTime(now))}${by ? ` by ${esc(one(by))}` : ''}: ${esc(parts.join(', '))}.</p>`);
  if (d.top.length) {
    out.push('<h2>Most Votes</h2>');
    out.push(`<ul>${d.top.map((i) => `<li><strong>${esc(plural(i.votes.count, 'Vote'))}</strong> - ${esc(i.words)}${i.votes.names.length ? ` (${esc(i.votes.names.join(', '))})` : ''}</li>`).join('')}</ul>`);
  }
  for (const g of d.groups) {
    out.push(`<h2>${esc(g.name)}</h2>`);
    out.push(`<ul>${g.items.map(point).join('')}</ul>`);
  }
  if (d.questions.length) {
    out.push('<h2>Open Questions</h2>');
    out.push(`<ul>${d.questions.map((q) => `<li>${esc(q.text)}${q.by ? ` - ${esc(q.by)}` : ''}${q.replies.length
      ? `<ul>${q.replies.map((r) => `<li>${esc(r.text)}${r.by ? ` - ${esc(r.by)}` : ''}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`);
  }
  if (d.tasks.length) {
    out.push('<h2>Tasks Made</h2>');
    out.push(`<ul>${d.tasks.map((t) => `<li><a data-type="recordLink" data-ref="task:${esc(t.id)}" title="${esc(t.words.slice(0, 120))}">${esc(t.words.slice(0, 120))}</a></li>`).join('')}</ul>`);
  }
  return {
    title: `${name} - Wrap Up ${formatDate(now)}`.slice(0, 200),
    html: out.join(''),
    counts: { stickies: d.stickies, sections: d.groups.length, questions: d.questions.length, tasks: d.tasks.length, voted: d.top.length },
  };
}

/** Who a Wrap Up is shared with: the same people as the board, each as they
 *  may use the board - never the person who made it (they own the Note). */
export function wrapUpPeople(note, me) {
  const mine = String(me || '').toLowerCase();
  const out = new Map();
  const owner = String(note?.owner || '').toLowerCase();
  if (owner && owner !== mine) out.set(owner, 'edit');
  for (const s of note?.sharedWith || []) {
    const email = String(s?.email || '').toLowerCase();
    if (email && email !== mine && !out.has(email)) out.set(email, s.can === 'edit' ? 'edit' : 'read');
  }
  return [...out].map(([email, can]) => ({ email, can }));
}

/** The Note an earlier Wrap Up of this board made (its card on the board carries the mark), else ''. */
export function wrapUpCard(elements) {
  for (const e of elements || []) {
    if (!e || e.isDeleted || !e.customData?.nexusWrapUp) continue;
    const ref = splitRef(e.customData?.nexusRecord?.ref || '');
    if (ref.kind === 'note' && ref.id) return ref.id;
  }
  return '';
}
