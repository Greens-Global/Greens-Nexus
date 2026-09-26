// Help search: a small, deterministic search engine over the written user
// guide (docsContent.js). Used by the header Help menu and by the ticket form's
// "Suggested Articles" block. No network, no model - plain code you can read.
//
// How it works
//   1. Index. Every DOCS entry is split into sections a person would actually
//      want to land on: the module itself, each walkthrough ("Workday > Request
//      Time Off"), each feature, the managers block and each tip. Every
//      section keeps its text in named fields with a weight, plus the anchor
//      SupportDocs uses to scroll to it. Built once, on first query. New or
//      rewritten entries in docsContent.js are indexed with no extra work.
//   2. Query. Text is lowercased, split into words, lightly stemmed ("requests",
//      "requesting", "requested" -> "request"), and stop words dropped. Known
//      phrases and synonyms ("pto", "vacation" -> "time off") turn each word
//      into a "concept" with alternatives.
//   3. Score. Each concept takes its best match across a section's fields
//      (field weight x match quality x how rare the word is), with bonuses for
//      the words sitting next to each other and for a title that covers the
//      whole query. Sections must cover enough of the query and clear a
//      minimum score, so junk returns nothing rather than noise.
import { DOCS } from './docsContent';

// ── Field weights ───────────────────────────────────────────────────────────
// Title/name > tagline > walkthrough title > feature name > body text. A child
// section also carries its module's name as low-weight context, so "workday
// time off" still finds the walkthrough.
export const FIELD_WEIGHTS = {
  name: 10,       // module name
  tagline: 6,     // one line under the module name
  wtitle: 5,      // walkthrough title
  fname: 4,       // feature name
  mtitle: 3,      // managers block title
  tip: 3,         // a "Good To Know" line: short, and usually the exact answer
  keywords: 4,    // curated search terms for a module (DOC_KEYWORDS below)
  context: 2,     // parent module name, on child sections
  kbtitle: 6,     // Knowledge Base document / course title
  kbsummary: 3,   // its purpose line or course description
  kbmeta: 2,      // type, departments, service, tags
  body: 1,        // steps, descriptions, purpose, gains, tips, points
};

// Match quality multipliers.
const Q_EXACT = 1;
const Q_SYNONYM = 0.85;
const Q_PREFIX = 0.7;   // last word still being typed
const Q_FUZZY = 0.75;   // one typo

// A section needs at least this much to be shown at all. Calibrated in
// docsSearch.test.js: real questions land well above it, junk far below.
export const MIN_SCORE = 3.5;
// Ticket suggestions sit inside a form, so they need to be surer.
export const TICKET_MIN_SCORE = 4;
// Results under this share of the best result's score are dropped as noise.
const REL_FLOOR = 0.4;

// Words that carry no meaning in a help query. Kept deliberately short; the
// rarity weighting already quiets common words like "click" and "open".
const STOP_WORDS = new Set((
  'a an the and or but if then so of to for from by with without at as into onto about ' +
  'is are was were be been being am do does did doing done have has had having ' +
  'i me my mine we us our you your yours he she it its they them their this that these those ' +
  'what which who whom whose when where why how can could would should will shall may might must ' +
  'no nor very just also too any some all each every there here than again ' +
  'please help need want wanted trying try get got getting im ive id ' +
  'anyone someone something thing things way able hi hello thanks thank ' +
  'today tomorrow yesterday tonight now currently still really suddenly anymore ever ' +
  'next last week weeks weekend morning afternoon asap urgent urgently quick quickly question'
).split(/\s+/));

// Short particles that only mean something inside a phrase ("time off",
// "clock in", "punch out"). Kept in the index so phrases can match; dropped
// from a query when they are left over on their own.
// Negations work the same way: "not working" is a phrase, a lone "cant" is not.
const PARTICLES = new Set(['in', 'on', 'off', 'out', 'up', 'down', 'over', 'back',
  'not', 'cant', 'cannot', 'wont', 'dont', 'isnt', 'doesnt', 'didnt', 'aint', 'never']);

// ── Company vocabulary ──────────────────────────────────────────────────────
// Each group is a set of ways people say the same thing, derived from what
// the guide actually covers. A query word or phrase in a group brings in the
// rest of the group as alternatives (at synonym quality). Multi-word entries
// are phrases. Add a group here when people search in words the docs don't use.
export const SYNONYM_GROUPS = [
  // Workday: time off and leave
  ['time off', 'pto', 'vacation', 'leave', 'day off', 'days off', 'holiday', 'sick', 'sick day', 'annual leave', 'absence', 'off work'],
  // Workday: clock
  ['punch', 'clock', 'clock in', 'clock out', 'punch in', 'punch out', 'time clock', 'timeclock', 'check in', 'check out', 'sign out of work', 'start shift', 'end shift'],
  ['break', 'lunch', 'lunch break', 'start break', 'end break'],
  // Workday: hours and pay
  ['time sheet', 'timesheet', 'timecard', 'time card', 'hours', 'paycheck', 'pay', 'payroll', 'paystub', 'pay stub', 'pay period', 'overtime', 'wage', 'salary'],
  ['shift', 'shifts', 'schedule', 'scheduled', 'roster', 'rota'],
  ['location', 'geofence', 'gps', 'site', 'on site', 'off site', 'remote'],
  // Item Management
  ['item', 'equipment', 'laptop', 'computer', 'monitor', 'device', 'hardware', 'tool', 'tools', 'phone', 'tablet', 'keyboard', 'mouse', 'charger', 'headset', 'vehicle', 'key', 'keys', 'asset', 'gear'],
  ['borrow', 'check out an item', 'checkout', 'checkouts', 'loan', 'rent', 'reserve', 'cart'],
  ['return', 'give back', 'hand back', 'bring back'],
  ['extend', 'extension', 'more time', 'keep longer', 'renew'],
  ['broken', 'dead', 'damaged', 'not working', 'stopped working', 'faulty', 'cracked', 'wont turn on', 'defective'],
  ['lost', 'missing', 'stolen', 'misplaced'],
  ['purchase request', 'buy', 'purchase', 'order', 'procure', 'new item'],
  ['warranty', 'serial', 'serial number', 'asset tag'],
  // Sign-in and access
  ['sign in', 'log in', 'login', 'logon', 'log on', 'signin', 'microsoft account', 'work account', 'mfa', 'two factor', '2fa', 'authenticator', 'locked out'],
  ['password', 'credential', 'credentials', 'passcode', 'vault', 'shared password'],
  ['access', 'permission', 'permissions', 'grant', 'granted', 'role', 'access group', 'missing module', 'not allowed', 'restricted'],
  ['act as', 'impersonate', 'see what someone sees', 'view as'],
  // Network
  ['network', 'vpn', 'wifi', 'wi fi', 'internet', 'connection', 'offline', 'outage', 'website down', 'site down', 'uptime'],
  // Support and tickets
  ['ticket', 'tickets', 'request help', 'support request', 'help desk', 'helpdesk', 'service desk', 'issue', 'problem', 'incident', 'case'],
  ['bug', 'error', 'glitch', 'crash', 'crashing', 'not loading', 'blank screen', 'something broken'],
  ['follow up', 'status of my ticket', 'update on my ticket', 'my open tickets', 'reply'],
  // Documents and signatures
  ['signature', 'sign', 'e sign', 'esign', 'nexus sign', 'signing', 'docusign', 'signed'],
  ['document', 'documents', 'contract', 'agreement', 'form', 'pdf', 'template'],
  ['file', 'files', 'folder', 'upload', 'egnyte', 'share drive', 'shared drive', 'download'],
  // Knowledge Base
  ['sop', 'sops', 'policy', 'policies', 'procedure', 'playbook', 'knowledge base', 'guide', 'handbook', 'manual', 'how to'],
  ['course', 'training', 'learn', 'lesson', 'quiz', 'onboarding'],
  // Tasks
  ['task', 'tasks', 'todo', 'to do', 'assignment', 'work item', 'action item'],
  ['project', 'projects', 'board', 'portfolio'],
  ['due date', 'deadline', 'overdue', 'late'],
  ['recurring', 'repeat', 'repeating', 'every week', 'every month'],
  // Alerts and profile
  ['notification', 'notifications', 'alert', 'alerts', 'bell', 'reminder', 'reminders'],
  ['email', 'emails', 'mail', 'inbox', 'outlook', 'email settings', 'unsubscribe'],
  ['profile', 'my profile', 'photo', 'picture', 'avatar', 'dark mode', 'theme', 'contact details', 'emergency contact', 'address', 'phone number'],
  ['search', 'find', 'look up', 'lookup', 'ctrl k'],
  ['dashboard', 'home', 'home page', 'widget', 'widgets'],
  ['link', 'links', 'bookmark', 'bookmarks', 'favorite', 'favorites', 'shortcut'],
  // People and HR
  ['employee', 'new hire', 'new employee', 'staff', 'coworker', 'colleague', 'onboard'],
  ['hiring', 'candidate', 'interview', 'recruit', 'recruiting', 'applicant', 'job opening'],
  ['org chart', 'reports to', 'manager', 'supervisor', 'boss', 'approver'],
  ['contact directory', 'directory', 'phone list', 'who to contact', 'people'],
  ['approve', 'approval', 'approvals', 'reject', 'deny', 'decline', 'pending'],
  // Money
  ['accounting', 'finance', 'numbers', 'cash', 'books', 'month end', 'month end close', 'financials'],
  ['capital call', 'distribution', 'investor', 'investors', 'commitment', 'deal'],
  // Property and construction
  ['property', 'properties', 'portfolio property', 'facility', 'building', 'storage facility'],
  ['inspection', 'inspections', 'compliance', 'as built', 'plans'],
  ['daily log', 'site log', 'rfi', 'submittal', 'submittals', 'milestone', 'construction', 'field crew'],
  // Marketing
  ['review', 'reviews', 'reputation', 'google review', 'rating'],
  ['ad', 'ads', 'advertising', 'ad budget', 'campaign', 'seo', 'leads'],
  // Monitoring
  ['monitoring', 'screenshot', 'screenshots', 'activity', 'tracking', 'enroll', 'enrolled computer'],
  // Misc problem words
  ['forgot', 'forget', 'forgotten', 'missed', 'miss', 'fix', 'correct', 'correction', 'wrong', 'mistake'],
  ['change', 'update', 'edit', 'modify', 'set up', 'customize'],
  ['tour', 'walkthrough', 'tutorial', 'getting started', 'new to nexus', 'first day'],
];

// Problems people search for that a module's page answers without using the
// same words (the guide says "report it dead", people type "broken"). Keyed by
// DOCS id; an id that no longer exists is simply ignored. Kept here, not in
// docsContent.js, so the guide stays plain prose.
export const DOC_KEYWORDS = {
  'getting-started': 'sign in log in login password microsoft account mfa locked out menu navigate find search bell notifications profile photo dark mode new to nexus first day tour',
  workday: 'pto vacation sick leave time off paycheck paystub pay stub timesheet timecard hours clock in clock out punch forgot to punch missed punch wrong punch break lunch shift schedule location',
  'item-management': 'laptop computer monitor phone equipment device broken damaged dead lost stolen return borrow checkout loan extension new laptop order',
  support: 'help ticket problem issue broken not working bug error contact it hr facilities follow up status reply',
  tickets: 'ticket queue sla assign resolve agent desk',
  'credential-vault': 'password shared password login credentials vault reveal',
  it: 'wifi vpn internet network outage website down offline',
  'knowledge-base': 'policy sop handbook procedure training course sign off',
  documents: 'sign signature esign contract agreement template pdf',
  files: 'egnyte folder upload download share file',
  people: 'hr employee new hire hiring candidate org chart leave approve time off',
  settings: 'access permission role grant module act as audit',
  dashboard: 'home widget links bookmarks shortcut',
  tasks: 'task todo project assignment due date recurring',
};

// ── Text utilities ──────────────────────────────────────────────────────────
const APOSTROPHES = /[\u2018\u2019\u02bc']/g;

/** Lowercase and split into raw words. "Can't" -> "cant", "Wi-Fi" -> "wi", "fi". */
export function words(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}

const DOUBLE_OK = new Set(['ll', 'ss', 'zz', 'ff']);

/** Light, predictable English stemmer: plurals, -ing, -ed, trailing -e. */
export function stem(w) {
  let s = w;
  if (s.length <= 3 || /^\d+$/.test(s)) return s;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (/(ches|shes|xes|zes)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);

  if (s.endsWith('ied') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('ing') && s.length >= 6) s = undouble(s.slice(0, -3));
  else if (s.endsWith('ed') && s.length >= 5) s = undouble(s.slice(0, -2));

  if (s.endsWith('e') && s.length > 4) s = s.slice(0, -1);
  return s;
}
function undouble(s) {
  const tail = s.slice(-2);
  if (tail.length === 2 && tail[0] === tail[1] && !DOUBLE_OK.has(tail) && /[b-df-hj-np-tv-z]/.test(tail[0])) {
    return s.slice(0, -1);
  }
  return s;
}

/** Words -> stems, keeping particles (they are needed for phrases). */
function stems(text) {
  return words(text).filter((w) => !STOP_WORDS.has(w)).map(stem);
}

/** True when a and b are at most one edit apart (insert, delete, substitute, or swap two neighbors). */
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    // substitution, or adjacent transposition
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // one insertion/deletion
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function slug(text) {
  return words(text).join('-').slice(0, 60) || 'section';
}

/** DOM id SupportDocs gives a section, so search results can scroll to it. */
export function sectionDomId(docId, anchor) {
  return anchor ? `doc-${docId}--${anchor}` : `doc-${docId}`;
}
export const walkthroughAnchor = (title) => `w-${slug(title)}`;
export const featureAnchor = (name) => `f-${slug(name)}`;
export const TIPS_ANCHOR = 'tips';
export const MANAGER_ANCHOR = 'manager';

// ── Index ───────────────────────────────────────────────────────────────────
function field(name, text) {
  const toks = stems(text);
  return { name, weight: FIELD_WEIGHTS[name], toks, set: new Set(toks) };
}

function trimSentence(text, max = 90) {
  if (!text || text.length <= max) return text || '';
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max)}...`;
}

/** Every searchable section of the guide. Exported for tests. */
export function buildSections(docs = DOCS) {
  const out = [];
  for (const d of docs) {
    const base = { docId: d.id, docName: d.name, group: d.group, view: d.view || null, sub: d.sub || null };
    out.push({
      ...base, kind: 'module', anchor: null, title: d.name,
      snippet: d.tagline || '',
      // Expanded inline, a module shows what it is for and what it covers.
      body: [d.tagline, ...(d.gains || [])].filter(Boolean),
      covers: (d.walkthroughs || []).map((w) => w.title),
      fields: [
        field('name', d.name),
        field('tagline', d.tagline),
        field('body', [d.purpose, ...(d.gains || []), d.where].join(' ')),
        field('keywords', [DOC_KEYWORDS[d.id] || '', ...(d.keywords || [])].join(' ')),
      ],
    });
    for (const w of d.walkthroughs || []) {
      out.push({
        ...base, kind: 'walkthrough', anchor: walkthroughAnchor(w.title), title: w.title,
        snippet: trimSentence(w.steps?.[0]), body: w.steps || [],
        fields: [field('wtitle', w.title), field('context', d.name), field('body', (w.steps || []).join(' '))],
      });
    }
    for (const f of d.features || []) {
      out.push({
        ...base, kind: 'feature', anchor: featureAnchor(f.name), title: f.name,
        snippet: trimSentence(f.desc), body: [f.desc].filter(Boolean),
        fields: [field('fname', f.name), field('context', d.name), field('body', f.desc)],
      });
    }
    if (d.manager?.points?.length) {
      out.push({
        ...base, kind: 'manager', anchor: MANAGER_ANCHOR, title: d.manager.title,
        snippet: trimSentence(d.manager.points[0]), body: d.manager.points,
        fields: [field('mtitle', d.manager.title), field('context', d.name), field('body', d.manager.points.join(' '))],
      });
    }
    (d.tips || []).forEach((t) => {
      out.push({
        ...base, kind: 'tip', anchor: TIPS_ANCHOR, title: trimSentence(t, 70), snippet: '', body: [t],
        fields: [field('tip', t), field('context', d.name)],
      });
    });
  }
  out.forEach((s, i) => { s.id = `${s.docId}:${s.anchor || 'top'}:${i}`; });
  return out;
}

// Synonym groups as stem sequences, plus a lookup from each stem sequence to
// the groups it belongs to.
function buildSynonyms() {
  // An entry that loses words to stop words ("reports to" -> "report") would
  // hijack a common word, so only entries that survive intact are kept.
  const groups = SYNONYM_GROUPS.map((g) => g.map((p) => stems(p))
    .filter((s, i) => s.length && (s.length > 1 || words(g[i]).length === 1)));
  const byKey = new Map();
  groups.forEach((g, gi) => g.forEach((seq) => {
    const k = seq.join(' ');
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(gi);
  }));
  const maxLen = Math.max(...groups.flat().map((s) => s.length));
  return { groups, byKey, maxLen };
}

// ── Knowledge Base corpus ───────────────────────────────────────────────────
// Documents and courses from the Knowledge Base (/knowledge-base/documents and
// /courses, exactly as the server returns them to this person), indexed with
// the same tokenizer, synonyms, weights and floors as the guide. Only what a
// reader would find in the library itself: approved documents and published
// courses. Drafts, items in review and archived documents are left out even
// when the list endpoint returns them (it does, to managers and authors).
const KB_BODY_CHARS = 4000;   // the opening of a long document says what it is about

const kbText = (v) => (Array.isArray(v) ? v.join(' ') : String(v || ''));

/** Knowledge Base rows -> search sections. Exported for tests. */
export function buildKbSections(kbDocs = [], kbCourses = []) {
  const out = [];
  for (const d of Array.isArray(kbDocs) ? kbDocs : []) {
    if (!d || !d.id || !d.title || d.status !== 'approved') continue;
    const purpose = kbText(d.body?.purpose);
    out.push({
      source: 'kb', kind: 'kb-doc', kbId: d.id, docId: `kb:${d.id}`, docName: 'Knowledge Base',
      group: 'Knowledge Base', view: 'sop', sub: null, anchor: null,
      title: d.title, snippet: trimSentence(purpose || [d.doc_type, kbText(d.departments)].filter(Boolean).join(' - ')),
      body: purpose ? [purpose] : [], meta: [d.doc_code, d.doc_type].filter(Boolean).join(' - '),
      fields: [
        field('kbtitle', d.title),
        field('kbsummary', purpose),
        field('kbmeta', [d.doc_type, kbText(d.departments), d.service, kbText(d.tags)].join(' ')),
        field('body', kbText(d.content_text).slice(0, KB_BODY_CHARS)),
      ],
    });
  }
  for (const c of Array.isArray(kbCourses) ? kbCourses : []) {
    if (!c || !c.id || !c.title || c.status !== 'published') continue;
    const desc = kbText(c.description);
    out.push({
      source: 'course', kind: 'course', kbId: c.id, docId: `course:${c.id}`, docName: 'Course',
      group: 'Knowledge Base', view: 'sop', sub: 'lms', anchor: null,
      title: c.title, snippet: trimSentence(desc), body: [desc, ...(Array.isArray(c.overview) ? c.overview : [])].filter(Boolean),
      meta: [c.course_code, c.est_minutes ? `${c.est_minutes} min` : '', c.lesson_count ? `${c.lesson_count} lessons` : ''].filter(Boolean).join(' - '),
      fields: [
        field('kbtitle', c.title),
        field('kbsummary', desc),
        field('kbmeta', kbText(c.departments)),
        field('body', kbText(c.overview)),
      ],
    });
  }
  return out;
}

function buildIndex(docs, extra = []) {
  const guide = buildSections(docs);
  guide.forEach((x) => { x.source = 'guide'; });
  const sections = [...guide, ...extra];
  // Document frequency per stem, for rarity weighting.
  const df = new Map();
  for (const s of sections) {
    const seen = new Set();
    for (const f of s.fields) for (const t of f.set) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = sections.length;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / n));
  // Raw word -> stem, for prefix matching on the word being typed.
  const rawVocab = new Map();
  for (const d of docs) {
    const text = [d.name, d.tagline, d.purpose, ...(d.gains || []),
      ...(d.walkthroughs || []).flatMap((w) => [w.title, ...(w.steps || [])]),
      ...(d.features || []).flatMap((f) => [f.name, f.desc]),
      ...(d.manager?.points || []), ...(d.tips || []), DOC_KEYWORDS[d.id] || '', ...(d.keywords || [])].join(' ');
    for (const w of words(text)) if (!rawVocab.has(w)) rawVocab.set(w, stem(w));
  }
  for (const x of extra) {
    for (const w of words(`${x.title} ${x.snippet}`)) if (!rawVocab.has(w)) rawVocab.set(w, stem(w));
  }
  const maxIdf = Math.log(1 + N);
  return { docs, sections, idf, maxIdf, vocab: df, rawVocab, syn: buildSynonyms() };
}

let cached = null;
// Guide + Knowledge Base, keyed on the corpus object so it is built once per
// fetch (see makeKbCorpus) and dropped with it.
const withKb = new WeakMap();
/** The index for DOCS, built on first use. Pass `docs` to index something else (tests). */
export function getIndex(docs = DOCS, kb = null) {
  if (docs !== DOCS) return buildIndex(docs, kb?.sections || []);
  if (kb) {
    if (!withKb.has(kb)) withKb.set(kb, buildIndex(DOCS, kb.sections));
    return withKb.get(kb);
  }
  if (!cached) cached = buildIndex(DOCS);
  return cached;
}

/** Wrap fetched Knowledge Base rows as a corpus searchDocs can take (`kb`). */
export function makeKbCorpus(kbDocs, kbCourses) {
  return { sections: buildKbSections(kbDocs, kbCourses) };
}

// ── Query parsing ───────────────────────────────────────────────────────────
// A concept is one idea from the query with its alternative spellings:
//   { label, alts: [{ seq: [stems], q }] }
function parseQuery(text, index) {
  const str = String(text || '');
  const raw = words(str);
  // Is the person still typing the last word? (no trailing space or punctuation)
  const endsMidWord = /[a-z0-9]$/i.test(str);
  const { groups, byKey, maxLen } = index.syn;

  // 1. Tokens, with one-typo correction for longer words that neither the
  //    guide nor the vocabulary knows ("vacaton" -> "vacation").
  const toks = [];
  raw.forEach((w, i) => {
    if (STOP_WORDS.has(w)) return;
    const last = i === raw.length - 1;
    let st = stem(w);
    let fuzzy = false;
    const known = index.vocab.has(st) || byKey.has(st);
    // The word still being typed is only corrected when nothing starts with it.
    const typingPrefix = last && endsMidWord && [...index.rawVocab.keys()].some((v) => v.startsWith(w));
    if (!known && w.length >= 5 && !typingPrefix) {
      const fix = correct(st, w, index);
      if (fix) { st = fix; fuzzy = true; }
    }
    toks.push({ raw: w, stem: st, last, fuzzy });
  });

  // 2. Concepts: the longest known phrase starting at each token wins
  //    ("clock out" before "clock"), and brings its synonym group along.
  const concepts = [];
  let i = 0;
  while (i < toks.length) {
    let matched = null;
    for (let n = Math.min(maxLen, toks.length - i); n >= 1; n -= 1) {
      const key = toks.slice(i, i + n).map((t) => t.stem).join(' ');
      if (byKey.has(key)) { matched = { n, key }; break; }
    }
    const n = matched ? matched.n : 1;
    const span = toks.slice(i, i + n);
    i += n;
    const lastTok = span[span.length - 1];
    const typing = lastTok.last && endsMidWord;
    const q = span.some((t) => t.fuzzy) ? Q_FUZZY : Q_EXACT;
    if (!matched) {
      const t = span[0];
      if (PARTICLES.has(t.raw)) continue;                 // leftover "in", "off", "not"
      if (t.raw.length < 2 && !/\d/.test(t.raw)) continue; // stray letters
    }
    const own = matched ? matched.key.split(' ') : [lastTok.stem];
    const alts = [{ seq: own, q }];
    const seen = new Set([own.join(' ')]);
    if (matched) {
      for (const gi of byKey.get(matched.key)) {
        for (const seq of groups[gi]) {
          const k = seq.join(' ');
          if (!seen.has(k)) { seen.add(k); alts.push({ seq, q: q * Q_SYNONYM }); }
        }
      }
    }
    // 3. The word being typed also matches the words it starts ("vacat").
    if (typing && own.length === 1 && lastTok.raw.length >= 2) {
      let added = 0;
      for (const [w, st] of index.rawVocab) {
        if (added >= 12) break;
        if (seen.has(st) || !w.startsWith(lastTok.raw)) continue;
        seen.add(st); added += 1;
        alts.push({ seq: [st], q: Q_PREFIX });
      }
      // ...and the synonym words it starts ("vaca" -> the time off group).
      if (lastTok.raw.length >= 3) {
        for (const [k, gis] of byKey) {
          if (k.includes(' ') || k === own[0] || !k.startsWith(lastTok.raw)) continue;
          for (const gi of gis) {
            for (const seq of groups[gi]) {
              const key = seq.join(' ');
              if (!seen.has(key)) { seen.add(key); alts.push({ seq, q: Q_PREFIX * Q_SYNONYM }); }
            }
          }
        }
      }
    }
    concepts.push({ label: span.map((t) => t.raw).join(' '), alts });
  }
  return concepts;
}

// Closest known stem one edit away: synonym words first (they carry a whole
// group), then the guide's own words, most common first. Null when none.
function correct(st, rawWord, index) {
  for (const k of index.syn.byKey.keys()) {
    if (!k.includes(' ') && k.length >= 4 && (withinOneEdit(st, k) || withinOneEdit(rawWord, k))) return k;
  }
  let best = null; let bestDf = 0;
  for (const [v, n] of index.vocab) {
    if (v.length >= 4 && n > bestDf && (withinOneEdit(st, v) || withinOneEdit(rawWord, v))) { best = v; bestDf = n; }
  }
  return best;
}

// ── Scoring ─────────────────────────────────────────────────────────────────
function containsSeq(toks, seq) {
  if (seq.length === 1) return -1;
  outer: for (let i = 0; i + seq.length <= toks.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) if (toks[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -2;
}

// How informative a match is, 0..1. A single word is as rare as the guide
// makes it ("click" is everywhere, "geofence" is not). A phrase is judged by
// its rarest word plus a bump: "log in" is specific even though "in" is not.
function seqRarity(seq, index) {
  let best = 0;
  for (const t of seq) best = Math.max(best, index.idf.get(t) || index.maxIdf);
  const r = best / index.maxIdf;
  return seq.length > 1 ? Math.min(1, r + 0.2) : r;
}

/** Best match of one concept in one field: { score, pos } or null. */
function matchInField(concept, f, index) {
  let best = null;
  for (const alt of concept.alts) {
    const { seq } = alt;
    let hit = false; let pos = -1; let quality = alt.q;
    if (seq.length === 1) {
      if (f.set.has(seq[0])) { hit = true; pos = f.toks.indexOf(seq[0]); }
    } else if (seq.every((t) => f.set.has(t))) {
      // Every word of a phrase is there; full credit only when adjacent.
      const at = containsSeq(f.toks, seq);
      hit = true;
      if (at >= 0) pos = at; else { quality *= 0.55; pos = f.toks.indexOf(seq[0]); }
    }
    if (!hit) continue;
    const score = f.weight * quality * (0.5 + 0.5 * seqRarity(seq, index));
    if (!best || score > best.score) best = { score, pos, len: seq.length };
  }
  return best;
}

function scoreSection(section, concepts, index, coverageWeight = 0.6) {
  let total = 0;
  let matched = 0;
  const hitsByField = new Map();   // field name -> [{ ci, pos, len }]
  concepts.forEach((c, ci) => {
    let best = 0; let extra = 0;
    for (const f of section.fields) {
      const m = matchInField(c, f, index);
      if (!m) continue;
      if (m.score > best) { extra += best; best = m.score; } else extra += m.score;
      if (!hitsByField.has(f.name)) hitsByField.set(f.name, []);
      hitsByField.get(f.name).push({ ci, pos: m.pos, len: m.len });
    }
    if (best > 0) {
      matched += 1;
      // A little credit for the concept showing up in more than one field.
      total += best + Math.min(extra, best) * 0.15;
    }
  });
  if (!matched) return null;

  // Adjacency: consecutive query concepts found next to each other in a field.
  for (const [fname, hits] of hitsByField) {
    const w = FIELD_WEIGHTS[fname];
    for (let k = 0; k + 1 < concepts.length; k += 1) {
      const a = hits.find((h) => h.ci === k); const b = hits.find((h) => h.ci === k + 1);
      if (a && b && b.pos >= 0 && a.pos >= 0 && b.pos - (a.pos + a.len) >= 0 && b.pos - (a.pos + a.len) <= 1) {
        total += w * 0.5;
      }
    }
  }

  // The section's own title answers the whole query ("request time off").
  const titleField = section.fields[0];
  if (['name', 'wtitle', 'fname', 'mtitle', 'tip', 'kbtitle'].includes(titleField.name)) {
    const inTitle = new Set((hitsByField.get(titleField.name) || []).map((h) => h.ci));
    if (concepts.length && inTitle.size === concepts.length) total *= 1.35;
  }

  const coverage = matched / concepts.length;
  return { score: total * (1 - coverageWeight + coverageWeight * coverage), matched, coverage };
}

function enoughCoverage(matched, n) {
  if (n <= 2) return matched >= 1;
  if (n <= 4) return matched >= Math.ceil(n / 2);
  return matched >= Math.max(2, Math.ceil(n * 0.3));
}

/**
 * Search the guide.
 * @param {string} text what the person typed
 * @param {object} [opts]
 * @param {number} [opts.limit=8] most results to return
 * @param {(docId: string) => boolean} [opts.allow] keep only docs the person can open
 * @param {number} [opts.perDoc=3] most results from any one module
 * @param {number} [opts.minScore=MIN_SCORE] relevance floor
 * @returns {Array<{id, docId, docName, kind, title, anchor, snippet, body, view, sub, score}>}
 */
export function searchDocs(text, opts = {}) {
  const { limit = 8, allow, perDoc = 3, minScore = MIN_SCORE, docs, kb = null, sources = null,
    coverage = enoughCoverage, coverageWeight = 0.6 } = opts;
  const index = getIndex(docs, kb);
  const concepts = parseQuery(text || '', index);
  if (!concepts.length) return [];
  const scored = [];
  for (const s of index.sections) {
    if (sources && !sources.includes(s.source)) continue;
    // Guide pages follow the left menu's access rule; Knowledge Base rows were
    // already scoped by the server to what this person may read.
    if (allow && s.source === 'guide' && !allow(s.docId)) continue;
    const r = scoreSection(s, concepts, index, coverageWeight);
    if (!r || r.score < minScore || !coverage(r.matched, concepts.length)) continue;
    scored.push({ s, score: r.score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title));
  // Drop the long tail: anything far weaker than the best answer is noise
  // next to it, even when it clears the absolute floor.
  const floor = scored.length ? scored[0].score * REL_FLOOR : 0;
  const perDocCount = new Map();
  const seenTitles = new Set();
  const out = [];
  for (const { s, score } of scored) {
    if (score < floor) break;
    const n = perDocCount.get(s.docId) || 0;
    const key = `${s.docId}|${s.title}`;
    if (n >= perDoc || seenTitles.has(key)) continue;
    perDocCount.set(s.docId, n + 1);
    seenTitles.add(key);
    out.push({
      id: s.id, docId: s.docId, docName: s.docName, group: s.group, kind: s.kind, title: s.title,
      anchor: s.anchor, snippet: s.snippet, body: s.body, covers: s.covers || [], view: s.view, sub: s.sub,
      source: s.source || 'guide', kbId: s.kbId || null, meta: s.meta || '',
      score: Math.round(score * 10) / 10,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Sections about raising a ticket are no answer to someone already raising one.
const isTicketSelfReference = (r) => (r.docId === 'support' || r.docId === 'tickets')
  && (r.kind === 'module' || /\btickets?\b/i.test(r.title));

/**
 * Suggestions for a ticket being written. The title says what the problem is,
 * so it leads; the opening of the description adds weight to matches it
 * agrees with (the rest is usually detail). Stricter floor than typeahead,
 * since these sit inside a form.
 */
export function suggestForTicket(subject, description, opts = {}) {
  const { limit = 3, ...rest } = opts;
  const subj = String(subject || '').trim();
  const desc = words(description || '').slice(0, 30).join(' ');
  if (subj.length < 3 && desc.length < 12) return [];
  // Ticket titles carry filler ("next week", "on the 3rd floor"), so one
  // strong idea is enough for a short title; the higher floor keeps it honest.
  const coverage = (matched, n) => (n <= 3 ? matched >= 1 : matched >= Math.max(2, Math.ceil(n * 0.25)));
  const search = (q) => searchDocs(`${q} `, { limit: 8, minScore: TICKET_MIN_SCORE, coverage, coverageWeight: 0.3, ...rest })
    .filter((r) => !isTicketSelfReference(r));
  const merged = new Map();
  if (subj) for (const r of search(subj)) merged.set(r.id, r);
  if (desc) {
    for (const r of search(desc)) {
      const prev = merged.get(r.id);
      merged.set(r.id, prev ? { ...prev, score: prev.score + r.score * 0.6 } : { ...r, score: r.score * 0.6 });
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const floor = Math.max(TICKET_MIN_SCORE, (ranked[0]?.score || 0) * 0.45);
  return ranked.filter((r) => r.score >= floor).slice(0, limit);
}

/** The guide entry for an app view id (e.g. "myhr" -> Workday), or null. */
export function docForView(view) {
  if (!view) return null;
  return DOCS.find((d) => d.view === view) || null;
}

/** Label for where a result comes from. */
export const SOURCE_LABEL = { guide: 'Guide', kb: 'Knowledge Base', course: 'Course' };

/** "Workday > Request Time Off" style breadcrumb for a result. */
export function resultPath(r) {
  if (r.source === 'kb' || r.source === 'course') return `${SOURCE_LABEL[r.source]} > ${r.title}`;
  if (r.kind === 'module') return r.docName;
  if (r.kind === 'tip') return `${r.docName} > Good To Know`;
  return `${r.docName} > ${r.title}`;
}
