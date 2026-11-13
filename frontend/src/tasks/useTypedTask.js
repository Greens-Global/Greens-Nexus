// Type it the way you say it (11/13/2026): the task name boxes - Home's add
// row, My Day's, the phone quick-add - read the sentence Say It reads. "Call
// the HVAC vendor about the leak Friday, high priority, for Bob" typed into
// one of them shows what was understood as chips (TypedTaskChips.jsx) BEFORE
// Enter, and Enter creates the task through the box's own create path with
// the cleaned name and those fields.
//
// The rules are sayTask.js's, unchanged - on the device, no AI, no network
// call. What this adds for typing:
//   - Nothing is set silently. Only what stands as a chip when the person
//     presses Enter is applied; a box reads `title / dueOn / priority /
//     assigneeIds` from the same render that drew the chips.
//   - A chip's X means "that was part of the name": the kind goes into the
//     parser's `ignore`, its words stay in the name, and it does not come
//     back until the entry ends (the box is emptied - created or cancelled).
//   - Nothing understood = the name exactly as typed (no capital added, no
//     opener dropped), so a plain name behaves as it always did. A sentence
//     that is ALL date / priority / person ("tomorrow") is a name too.
//   - A field the person already set in the box's own form (`locked`) is
//     never read from the sentence, and a box may take only some kinds
//     (`kinds` - My Day reads no assignee: the list is the person's own).
//   - A list (two or more lines) is Add Several's (batchPaste.js), never read.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { parseSpokenTask } from './sayTask';
import { todayISO } from './lib';
import { formatDate, formatWeekday } from '../lib/datetime';
import { PRIORITY_META } from './theme';

export const TYPED_KINDS = ['date', 'priority', 'assignee'];

const nothing = (title) => ({ title, dueOn: '', priority: '', assigneeIds: [], chips: [] });

// The parser capitalizes the first letter (speech arrives lowercase). A name
// that starts where the typed text starts keeps the person's own first
// letter ("iPad case for Bob" stays "iPad case").
function keepTypedCase(typed, title) {
  const head = title.split(/\s/)[0];
  if (head && typed.slice(0, head.length).toLowerCase() === head.toLowerCase()) return typed.charAt(0) + title.slice(1);
  return title;
}

/**
 * readTypedTask(text, { people, myEmail, ignore, today })
 *   -> { title, dueOn, priority, assigneeIds, chips: [{ kind, words, value }] }
 * The pure half: `title` is what the task will be called, the other three
 * are '' / [] unless a chip carries them.
 */
export function readTypedTask(text, { people = [], myEmail = '', ignore = [], today } = {}) {
  const typed = String(text || '').trim();
  if (!typed || /[\r\n]/.test(typed)) return nothing(typed);
  const r = parseSpokenTask(typed, { people, myEmail, ignore, today: today || todayISO() });
  if (!r.matched.length || !r.title) return nothing(typed);
  return { title: keepTypedCase(typed, r.title), dueOn: r.dueOn, priority: r.priority, assigneeIds: r.assigneeIds, chips: r.matched };
}

const nameOf = (email, people, myEmail) => (email === myEmail ? 'You' : people.find((p) => p.email === email)?.name || email);

/** What a chip shows: "Fri 11/20/2026" / "High" / "Bob Smith". */
export function chipLabel(chip, { people = [], myEmail = '' } = {}) {
  if (chip.kind === 'date') return `${formatWeekday(chip.value, 'short')} ${formatDate(chip.value)}`;
  if (chip.kind === 'priority') return PRIORITY_META[chip.value]?.label || chip.value;
  return chip.value.map((e) => nameOf(e, people, myEmail)).join(', ');
}

/** The chip in full, for its Remove button and the screen reader:
 *  "due date Friday 11/20/2026" / "priority High" / "assignee Bob Smith". */
export function chipSpoken(chip, ctx) {
  if (chip.kind === 'date') return `due date ${formatWeekday(chip.value)} ${formatDate(chip.value)}`;
  if (chip.kind === 'priority') return `priority ${chipLabel(chip, ctx)}`;
  return `assignee ${chipLabel(chip, ctx)}`;
}

/** One line for the screen reader, '' when nothing was understood. */
export function understoodText(chips, ctx) {
  return chips.length ? `Understood: ${chips.map((c) => chipSpoken(c, ctx)).join(', ')}.` : '';
}

/**
 * useTypedTask(text, { people, myEmail, kinds, locked })
 *   -> { title, dueOn, priority, assigneeIds, chips, remove(kind), standDown() }
 * `kinds`: the kinds this box takes (all three by default). `locked`:
 * { date, priority, assignee } - true where the box's own field was set by
 * the person. `standDown()` stops reading for this entry (Say It filled it).
 */
export function useTypedTask(text, { people, myEmail = '', kinds = TYPED_KINDS, locked = null } = {}) {
  const [removed, setRemoved] = useState([]);
  // An emptied box is a new entry: what was removed may be read again.
  if (removed.length && !String(text || '').trim()) setRemoved([]);
  const ignoreKey = TYPED_KINDS.filter((k) => removed.includes(k) || !kinds.includes(k) || locked?.[k]).join(',');
  const read = useMemo(
    () => readTypedTask(text, { people: people || [], myEmail, ignore: ignoreKey ? ignoreKey.split(',') : [] }),
    [text, people, myEmail, ignoreKey],
  );
  return {
    ...read,
    remove: (kind) => setRemoved((cur) => (cur.includes(kind) ? cur : [...cur, kind])),
    standDown: () => setRemoved(TYPED_KINDS),
  };
}

/** Nexus People for a box that has none at hand (Home's add row) - the list
 *  Say It reads (usePeople(true): the curated directory), asked for only once
 *  the box is open. */
export function useTypedTaskPeople(active) {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    Promise.resolve(api.getPeopleDirectory?.(true)).then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, [active]);
  return people;
}
