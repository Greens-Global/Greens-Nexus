// Say It (Neil, Oct 30 2026): one spoken sentence becomes a task. "Call the
// HVAC vendor about the leak Friday, high priority, for Bob" fills the name,
// due date, priority and assignee; the person checks the form and taps
// Create - nothing is ever created by voice alone.
//
// Rules, not AI: this runs on the device with no network call (AI stays
// off - ai_switch.py). What it understands:
//   Dates     today, tonight, this evening, tomorrow, day after tomorrow,
//             <weekday> / on <weekday> (the next one AFTER today - "Friday"
//             said on a Friday is next week's), this <weekday> ("this
//             Friday" said on a Friday is today), next <weekday> (that day
//             in NEXT calendar week, Monday-Sunday), next week (next
//             Monday), this week / end of the week (the coming Friday), end
//             of the month, in N days / weeks (one to thirty, or digits; "a
//             week", "a couple of days"), month + day ("November 3rd", "Nov
//             3", "the 3rd of November"), US numbers ("11/3", "11/3/2026").
//             A bare weekday, a month + day and a number date count only
//             after due / by / on / before / until or where they end the
//             phrase ("the leak Friday, high priority") - "the Monday
//             meeting agenda" and "the March 3 invoice" are names ("this /
//             coming / next <weekday>" always count). Dates are read first,
//             so "lunch for May 5" is a date, not a person called May. A
//             date already gone (this year's March 2 in October) is left in
//             the name, never moved to next year - due dates are never in
//             the past (DateField noPast).
//   Priority  urgent / urgently where they end a phrase ("fix the gate,
//             urgent" - but "urgent care visit" stays the name), "it's an
//             emergency", asap, as soon as possible, right away -> Urgent;
//             high / medium (normal) / low priority.
//   Assignee  "for <name>", "assign(ed) (it) to <name>", "give it to
//             <name>", chained with "and <name>"; "me" / "myself" is the
//             speaker. A name counts only when it is a confident match in
//             Nexus People: a full name, or a first name exactly one person
//             has. Two people called Sam -> nobody is picked and the words
//             stay in the name. A first name alone is not a person when it
//             is a month or weekday word, is followed by a number, or names
//             a place ("for Austin site", "for May 5"). A possessive ("for
//             Sarah's birthday", "for Bob Smith's review") is what the task
//             is about, not who does it. A bare "to <name>" is NOT read as
//             the assignee: "send the report to Bob" means Bob gets the
//             report.
//   Openers   "remind me to", "I need to", "don't forget to", "add a task
//             to"... are dropped from the name.
// Every phrase it used is reported in `matched`, so the screen can show it
// as a chip and undo it (parse again with that kind in `ignore`).

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, couple: 2, few: 3,
};
const NUM_RE = '(\\d{1,2}|a couple of|a few|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)';
// Words a date phrase may lean on ("due Friday", "by tomorrow").
const LEAD = '(?:\\b(?:due|by|on|before|until|for)\\s+)?(?:the\\s+)?';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const num = (w) => {
  const k = String(w).toLowerCase().replace(/^a (couple|few) of$/, '$1').replace(/^a few$/, 'few');
  return /^\d+$/.test(k) ? Number(k) : NUM_WORDS[k] || 0;
};
const monthIndex = (w) => MONTHS.findIndex((m) => m.startsWith(String(w).toLowerCase().slice(0, 3)));
// Monday of the week `d` is in (weeks run Monday-Sunday).
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

// The next `dow` strictly after today.
function nextWeekday(today, dow) {
  const ahead = ((dow - today.getDay() + 7) % 7) || 7;
  return addDays(today, ahead);
}

// A real calendar date, or null (Feb 30).
function dateOf(y, m, d) {
  const out = new Date(y, m, d);
  return out.getMonth() === m && out.getDate() === d ? out : null;
}

function monthDay(today, m, d, y) {
  if (m < 0 || m > 11 || !d) return null;
  if (y) return dateOf(y < 100 ? 2000 + y : y, m, d);
  // Said without a year it is this year's - one already gone is a slip,
  // left in the name rather than moved to next year.
  return dateOf(today.getFullYear(), m, d);
}

// [regex, (match, today) => Date | null, strict] - the first that matches
// wins. A strict rule counts only after due / by / on / before / until or
// where it ends the phrase (see `placed`).
const DATE_RULES = [
  [/\bday after tomorrow\b/, (_, t) => addDays(t, 2)],
  [/\b(?:today|tonight|this evening|this afternoon|this morning|end of (?:the )?day)\b/, (_, t) => t],
  [/\btomorrow(?: (?:morning|afternoon|evening|night))?\b/, (_, t) => addDays(t, 1)],
  [new RegExp(`\\bin ${NUM_RE} (days?|weeks?)\\b`), (m, t) => {
    const n = num(m[1]);
    return n ? addDays(t, m[2].startsWith('week') ? n * 7 : n) : null;
  }],
  [/\bnext week\b/, (_, t) => addDays(mondayOf(t), 7)],
  [/\b(?:this week|end of (?:the |this )?week)\b/, (_, t) => {
    const fri = addDays(mondayOf(t), 4);
    return fri >= t ? fri : addDays(fri, 7);
  }],
  [/\bend of (?:the |this )?month\b/, (_, t) => new Date(t.getFullYear(), t.getMonth() + 1, 0)],
  [new RegExp(`\\bnext (${WEEKDAYS.join('|')})\\b`), (m, t) => {
    const dow = WEEKDAYS.indexOf(m[1]);
    return addDays(addDays(mondayOf(t), 7), (dow + 6) % 7);
  }],
  // "this / coming <weekday>" always counts; a bare weekday is strict.
  [new RegExp(`\\b(this coming |coming |this )(${WEEKDAYS.join('|')})\\b`), (m, t) => {
    const dow = WEEKDAYS.indexOf(m[2]);
    return m[1] === 'this ' && dow === t.getDay() ? t : nextWeekday(t, dow);
  }],
  [new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`), (m, t) => nextWeekday(t, WEEKDAYS.indexOf(m[1])), true],
  [new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`), (m, t) => monthDay(t, monthIndex(m[1]), Number(m[2]), Number(m[3]) || 0), true],
  [new RegExp(`\\b(?:the )?(\\d{1,2})(?:st|nd|rd|th)? of ${MONTH_RE}\\b`), (m, t) => monthDay(t, monthIndex(m[2]), Number(m[1]), 0), true],
  [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m, t) => monthDay(t, Number(m[1]) - 1, Number(m[2]), Number(m[3]) || 0), true],
];

// A strict date phrase: led by a due word, or ending the phrase.
const STRONG_LEAD = /^(?:due|by|on|before|until)\b/;
function placed(lower, m) {
  if (STRONG_LEAD.test(m[0])) return true;
  return /^\s*(?:[,.;:!?]|$)/.test(lower.slice(m.index + m[0].length));
}

const PRIORITY_RULES = [
  // "urgent" only where it ends a phrase ("fix the gate, urgent") - "urgent
  // care appointment" is a name.
  [/\b(?:(?:it'?s|it is|this is|make it|with)\s+)?(?:urgent(?:ly)?(?=\s*$|\s*[,.;:!?]|\s+(?:for|by|due|on|and|before|please|today|tomorrow)\b)|asap|as soon as possible|right away)\b/, 'urgent'],
  // "emergency" alone is too often the subject ("call the emergency line").
  [/\b(?:it'?s|it is|this is)\s+an?\s+emergency\b/, 'urgent'],
  [/\b(?:(?:it'?s|it is|this is|make it|with|as)\s+)?(?:an?\s+)?(?:high[- ]priority|priority high|top priority)\b/, 'high'],
  [/\b(?:(?:it'?s|it is|this is|make it|with|as)\s+)?(?:an?\s+)?(?:(?:medium|normal)[- ]priority|priority (?:medium|normal))\b/, 'medium'],
  [/\b(?:(?:it'?s|it is|this is|make it|with|as)\s+)?(?:an?\s+)?(?:low[- ]priority|priority low)\b/, 'low'],
];

const OPENERS = /^(?:(?:please|okay|ok|so)[,\s]+)?(?:remind me to|i need to|i have to|i've got to|we need to|need to|don't forget to|do not forget to|make sure to|add a task to|create a task to|new task to|new task|task to)[:,]?\s+/i;

const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
const bare = (w) => String(w || '').replace(/[.,!?;:]+$/, '');

// Who a spoken name is: a full name, else a first name exactly one person
// has. { person, used } | { ambiguous } | null.
function matchPerson(words, people) {
  const one = clean(bare(words[0]));
  if (!one) return null;
  if (words.length >= 2 && !/[.,!?;:]$/.test(words[0])) {
    const two = clean(`${bare(words[0])} ${bare(words[1])}`);
    const full = people.filter((p) => clean(p.name) === two);
    if (full.length === 1) return { person: full[0], used: 2 };
  }
  const firsts = people.filter((p) => clean(p.name).split(' ')[0] === one);
  if (firsts.length === 1) return { person: firsts[0], used: 1 };
  return firsts.length > 1 ? { ambiguous: true } : null;
}

// A first name alone that is really a date or a place: "for May 5", "for
// Friday", "for Austin site".
const NOT_A_NAME = new RegExp(`^(?:${[...MONTHS, ...WEEKDAYS].join('|')})$`);
const PLACE_WORDS = /^(?:site|office|store|shop|location|property|building|warehouse|branch|plant|yard|campus|facility|project|account|job|team|crew|area|unit)$/i;

// One name at `text`'s start: { email, length } or null.
function personAt(text, people, myEmail) {
  const tokens = text.match(/^\s*(\S+)(\s+\S+)?/);
  if (!tokens) return null;
  const words = [tokens[1], (tokens[2] || '').trim()].filter(Boolean);
  if (/^(me|myself)[.,!?;:]?$/i.test(words[0])) {
    if (!myEmail) return null;
    return { email: myEmail, length: text.indexOf(words[0]) + bare(words[0]).length };
  }
  const hit = matchPerson(words, people);
  if (!hit || hit.ambiguous) return null;
  const last = bare(words[hit.used - 1]);
  // A possessive ("for Sarah's birthday", "for Bob Smith's review") is what
  // the task is about.
  if (/'s$/i.test(last)) return null;
  if (hit.used === 1 && words[1] && /'s$/i.test(bare(words[1]))
    && people.some((p) => clean(p.name) === clean(`${bare(words[0])} ${bare(words[1]).replace(/'s$/i, '')}`))) return null;
  if (hit.used === 1 && !/[.,!?;:]$/.test(words[0])) {
    const next = bare(words[1] || '');
    if (NOT_A_NAME.test(clean(words[0])) || /^\d/.test(next) || PLACE_WORDS.test(next)) return null;
  }
  const at0 = text.indexOf(words[0]);
  const end = hit.used === 2 ? text.indexOf(words[1], at0 + words[0].length) + bare(words[1]).length : at0 + bare(words[0]).length;
  return { email: hit.person.email, length: end };
}

function findAssignees(text, people, myEmail, free = () => true) {
  const re = /\b(?:for|assign(?:ed)?(?:\s+(?:it|this))?\s+to|give\s+(?:it|this)\s+to)\s+/gi;
  let m;
  while ((m = re.exec(text))) {
    let pos = m.index + m[0].length;
    const first = personAt(text.slice(pos), people, myEmail);
    if (!first || !free(m.index, pos + first.length)) continue;
    const emails = [first.email];
    pos += first.length;
    for (;;) {
      const and = text.slice(pos).match(/^\s*,?\s*and\s+/i);
      if (!and) break;
      const next = personAt(text.slice(pos + and[0].length), people, myEmail);
      if (!next) break;
      emails.push(next.email);
      pos += and[0].length + next.length;
    }
    return { start: m.index, end: pos, emails: [...new Set(emails)] };
  }
  return null;
}

/**
 * parseSpokenTask(text, { people, today, myEmail, ignore })
 *   -> { title, dueOn, priority, assigneeIds, matched: [{ kind, words, value }] }
 * dueOn is YYYY-MM-DD (or ''), priority '' when none was said, assigneeIds []
 * when nobody was. `ignore` lists kinds ('date' | 'priority' | 'assignee')
 * to leave in the name - how the screen undoes a chip.
 */
export function parseSpokenTask(text, { people = [], today, myEmail = '', ignore = [] } = {}) {
  const raw = String(text || '').trim();
  const out = { title: '', dueOn: '', priority: '', assigneeIds: [], matched: [] };
  if (!raw) return out;
  const day = fromIso(today || iso(new Date()));
  const skip = new Set(ignore);
  const cuts = [];   // [start, end) spans taken out of the name
  const lower = raw.toLowerCase();
  const free = (s, e) => !cuts.some(([a, b]) => s < b && e > a);
  const take = (kind, s, e, value) => {
    cuts.push([s, e]);
    out.matched.push({ kind, words: raw.slice(s, e).trim(), value });
  };

  // Dates first: "lunch for May 5" is a date, not a person called May.
  if (!skip.has('date')) {
    for (const [re, fn, strict] of DATE_RULES) {
      const g = new RegExp(LEAD + re.source, 'g');
      let m;
      let hit = false;
      while ((m = g.exec(lower))) {
        if (!m[0]) { g.lastIndex += 1; continue; }
        if (!free(m.index, m.index + m[0].length) || (strict && !placed(lower, m))) continue;
        const d = fn(re.exec(m[0]), day);
        if (!d || d < day) continue;
        out.dueOn = iso(d);
        take('date', m.index, m.index + m[0].length, out.dueOn);
        hit = true;
        break;
      }
      if (hit) break;
    }
  }
  if (!skip.has('priority')) {
    for (const [re, value] of PRIORITY_RULES) {
      const m = re.exec(lower);
      if (m && free(m.index, m.index + m[0].length)) { out.priority = value; take('priority', m.index, m.index + m[0].length, value); break; }
    }
  }
  if (!skip.has('assignee')) {
    const a = findAssignees(raw, people, myEmail, free);
    if (a) { out.assigneeIds = a.emails; take('assignee', a.start, a.end, a.emails); }
  }

  let title = raw;
  for (const [a, b] of [...cuts].sort((x, y) => y[0] - x[0])) title = `${title.slice(0, a)} ${title.slice(b)}`;
  title = title
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(OPENERS, '')
    .replace(/[,;:]\s*(?=[,;:.!?]|$)/g, '')
    .replace(/^[,;:.\s]+|[,;:\s]+$/g, '');
  // Connecting words left hanging at the end ("call Bob and", "pay it by").
  for (let i = 0; i < 3; i += 1) title = title.replace(/[,\s]+(?:and|by|on|due|with|for|it'?s)$/i, '').replace(/[,;:\s]+$/, '');
  title = title.replace(/[.!]+$/, '').trim();
  out.title = title.charAt(0).toUpperCase() + title.slice(1);
  return out;
}
