// Record Cards on a board (Neil, 11/07/2026). A card is an ordinary box with
// a label, so it saves, syncs, exports and undoes like any shape; what makes
// it a card is `customData.nexusRecord = { ref }` on the box and the box's
// link (the engine's link button opens it - Board.jsx onRecordOpen). The
// server reads the ref for Mentioned In (record_links.scene_refs). A task
// card's last line says Open / Done and its due date; an editor opening the
// board brings that line up to date.
import { RECORD_META, safeRef, splitRef } from '../../recordLink';
import { recordHref } from '../../../lib/recordRef';
import { formatDate } from '../../../lib/datetime';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The words on a card. `state` (a task's) adds the status line. */
export function cardLabel({ kind, title, code }, state) {
  const label = (RECORD_META[kind] || RECORD_META.note).label;
  const head = code ? `${label} ${kind === 'ticket' ? `#${code}` : code}` : label;
  const lines = [head, clip(String(title || `Untitled ${label}`).replace(/\s+/g, ' ').trim(), 80)];
  if (kind === 'task' && state) lines.push([state.done ? 'Done' : 'Open', !state.done && state.dueOn ? `Due ${formatDate(state.dueOn)}` : ''].filter(Boolean).join(' · '));
  return lines.join('\n');
}

/** The one-box graph a picked row becomes (graph.js shape), sized to its
 *  lines so the status line is never cut (the label is the engine's 20px). */
export function cardGraph(row, state) {
  const label = cardLabel(row, state);
  const lines = label.split('\n');
  const longest = Math.max(...lines.map((l) => l.length));
  const w = Math.min(340, Math.max(200, Math.round(longest * 11 + 48)));
  return { nodes: [{ id: 'card', label, shape: 'step', w, h: lines.length * 26 + 34 }], edges: [] };
}

/** `built` with the box `boxId` marked as the card for `ref`. */
export function markCard(built, boxId, ref) {
  const r = safeRef(ref);
  return built.map((e) => (e.id === boxId && r
    ? { ...e, link: recordHref(r), customData: { ...(e.customData || {}), nexusRecord: { ref: r } } }
    : e));
}

/** The live task cards on a board: [{ box, text, taskId }]. */
export function taskCards(elements) {
  const els = (elements || []).filter((e) => e && !e.isDeleted);
  const textOf = new Map(els.filter((e) => e.type === 'text' && e.containerId).map((e) => [e.containerId, e]));
  return els.filter((e) => splitRef(e.customData?.nexusRecord?.ref || '').kind === 'task')
    .map((box) => ({ box, text: textOf.get(box.id), taskId: splitRef(box.customData.nexusRecord.ref).id }))
    .filter((c) => c.text);
}

/** The text elements whose status line changed, as newer versions (the live
 *  reconcile is newest version wins). `states`: { taskId: { title, code, done, dueOn } }. */
export function refreshedCards(elements, states) {
  const out = [];
  for (const { text, taskId } of taskCards(elements)) {
    const s = states?.[taskId];
    if (!s) continue;
    const words = cardLabel({ kind: 'task', title: s.title, code: s.code }, s);
    if (words === text.originalText || words === text.text) continue;
    out.push({ ...text, text: words, originalText: words, version: (text.version || 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
  }
  return out;
}
