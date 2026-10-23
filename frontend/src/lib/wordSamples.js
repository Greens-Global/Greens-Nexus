// Automatic variables on upload (Pranshu, Oct 23 - Hiring Setup decision 11).
//
// An offer letter, hiring packet document or job description uploaded as a
// Word file usually arrives as a filled-in SAMPLE: a real name, a date, a pay
// figure, the company's name. Nexus recognizes those values itself, makes the
// matching variables and puts them in place of the sample text; HR sees each
// one highlighted on the review screen (components/hiring/UploadReview.jsx)
// with what it became, and can change it or turn it back into text. A file
// that already has {{variables}} keeps them and is not guessed at.
//
// Deterministic rules only - no AI, no network. Every variable also says WHO
// fills it (decision 12): Nexus, You (HR on the offer), the New Hire (on their
// Nexus Sign Details Form, saved to their record), Same Every Time, or Paper.
import { NEXUS_FIELDS, clean, escapeRe, findSection, guessFill, hireLabel, isPersonal } from './wordBlanks';
import { extractVariables, tokensInDoc } from './extractVariables';

export { HIRE_LABELS } from './wordBlanks';

// Built-ins the new hire types on the intake form (hle.INTAKE_FIELDS), saved
// to People by _apply_hire_details. `email` stays Nexus: it has their email.
export const HIRE_TOKENS = new Set(['address', 'permanent_address', 'phone', 'preferred_name',
  'emergency_name', 'emergency_relationship', 'emergency_phone']);

export const WHO = [
  ['nexus', 'Nexus Fills It'], ['you', 'You Answer On The Offer'], ['hire', 'The New Hire Fills It'],
  ['same', 'Same Every Time'], ['paper', 'Leave Blank For Paper'],
];
export const WHO_COLOR = { nexus: '#dcfce7', you: '#dbeafe', hire: '#f3e8ff', same: '#e2e8f0', paper: '#f1f5f9' };
const NEXUS_LABEL = Object.fromEntries(NEXUS_FIELDS);

/** Who fills a blank: nexus | you | hire | same | paper. */
export function whoOf(b) {
  if (b.fill === 'nexus') return HIRE_TOKENS.has(b.token) ? 'hire' : 'nexus';
  return { hr: 'you', ask: 'hire', same: 'same', leave: 'paper' }[b.fill] || 'paper';
}

/** The blank after HR picks who fills it (and, for Nexus, which field). */
export function setWho(b, who, token) {
  if (who === 'nexus') {
    const guess = guessFill(b.label);
    // a new hire's built-in (phone, address) keeps its token: Nexus prints what they typed
    const t = token || (b.fill === 'nexus' ? b.token : '') || (guess.fill === 'nexus' ? guess.token : '') || NEXUS_FIELDS[0][0];
    return { ...b, fill: 'nexus', token: t, ...(b.rule && t !== b.token ? { label: NEXUS_LABEL[t] || b.label } : {}) };
  }
  if (who === 'hire') {
    const t = token || (HIRE_TOKENS.has(b.token) ? b.token : '');
    return t ? { ...b, fill: 'nexus', token: t } : { ...b, fill: 'ask', token: b.kind === 'existing' ? b.token : undefined };
  }
  const fill = { you: 'hr', same: 'same', paper: 'leave' }[who] || 'leave';
  // Same Every Time starts from the sample text it was found as
  const value = fill === 'same' && !b.value && b.kind === 'text' ? { value: b.found || b.match || '' } : {};
  return { ...b, fill, token: b.kind === 'existing' ? b.token : undefined, ...value };
}

/** What a blank became, in words ("Full Name"). */
export const becameOf = (b) => (b.fill === 'nexus' ? (b.label && b.rule ? b.label : NEXUS_LABEL[b.token] || b.label) : b.label);

/** The {{variables}} a file already has: literal {{token}} text becomes a
 *  merge field. Returns {doc, tokens}. */
export function existingTokens(doc) {
  const { json } = extractVariables(doc);
  return { doc: json, tokens: tokensInDoc(json) };
}

/** A kept variable as a blank: built-ins are Nexus's (or the new hire's). */
export function existingBlank(token, variables = []) {
  const v = (variables || []).find(x => x.token === token);
  const label = v?.label || token.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const fill = v?.source === 'builtin' ? { fill: 'nexus', token } : guessFill(label);
  return { kind: 'existing', orig: token, label, found: `{{${token}}}`, ...fill, token: fill.fill === 'nexus' ? fill.token : token };
}

// ── finding sample values ─────────────────────────────────────────────────
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const DATE = new RegExp(`\\b(?:\\d{1,2}/\\d{1,2}/\\d{4}|(?:${MONTHS})\\.? \\d{1,2},? \\d{4}|\\d{1,2} (?:${MONTHS}),? \\d{4}|\\d{4}-\\d{2}-\\d{2})\\b`, 'g');
const MONEY = /(?:[$₹]\s?\d[\d,]*(?:\.\d+)?|\b(?:Rs\.?|INR|USD)\s?\d[\d,]*(?:\.\d+)?)(?:\s*(?:per|\/)\s*(?:year|annum|month|week|hour))?/g;
const LEGAL = /\b(?:[A-Z][\w&'.-]*\s){0,4}[A-Z][\w&'.-]*,?\s(?:L\.L\.C\.|LLC|Inc\.?|Corp\.?|Corporation|Pvt\.? Ltd\.?|Private Limited|Ltd\.?|Limited|LLP)(?![A-Za-z])/g;
const STREET = /\b\d{1,6}\s+(?:[A-Z0-9][\w.'-]*\s+){0,6}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Lane|Ln|Way|Suite)\b\.?.{0,80}?\b\d{5,6}(?:-\d{4})?\b/g;
const NAME = "(?:(?:Mr|Ms|Mrs|Dr)\\.?\\s+)?([A-Z][a-z'-]+(?:\\s+[A-Z][a-z'-]+){1,2})";
const NAMES = [new RegExp(`\\bDear\\s+${NAME}`, 'g'), new RegExp(`\\bTo:\\s*${NAME}`, 'g'), new RegExp(`\\bbetween\\b[^\\u0001]{0,120}?\\band\\s+${NAME}`, 'g')];
const TITLE = /\b(?:position of|role of|as an?|as our|Title:|Designation:)\s+([A-Z][\w&/-]*(?:\s+[A-Z][\w&/-]*){0,4})/g;
const PHONE = /(?:\+\d{1,3}[\s-]?\d{5}[\s-]?\d{5}|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+\w/g;
const LABEL_VALUE = /^([A-Za-z][A-Za-z ()'/&.-]{1,40}):\s*(\S.{0,79})$/;
const BLANKISH = /^[\s_.\-[\]]*$/;
const digits = (s) => String(s || '').replace(/\D/g, '');
// whole-token match: never inside a longer word or number
const wordRe = (s) => `(?<![\\w])${escapeRe(s)}(?![\\w])`;

function paragraphs(doc) {
  const out = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'paragraph' || node.type === 'heading') && Array.isArray(node.content)) {
      const text = node.content.map(r => (r.type === 'text' ? r.text || '' : '\u0001')).join('');
      if (clean(text.split('\u0001').join(' '))) out.push({ path, text });
      return;
    }
    (node.content || []).forEach((c, i) => walk(c, [...path, i]));
  };
  walk(doc, []);
  return out;
}

const contextAt = (text, start, end) => {
  const from = Math.max(0, start - 50);
  return clean(`${from ? '...' : ''}${text.slice(from, end + 50)}`.split('\u0001').join(' '));
};

// A label from the words just before a value: "a signing bonus of $5,000" -> "Signing Bonus".
const STOP = new Set('a an the of is are was be will on at to for by in and or your you our we with from as per its their this that'.split(' '));
function leadLabel(text, at, fallback, suffix = '') {
  const words = text.slice(Math.max(0, at - 60), at).replace(/[^A-Za-z' ]/g, ' ').split(/\s+/).filter(w => /[A-Za-z]/.test(w));
  if (at > 60) words.shift();                       // cut mid-word
  while (words.length && STOP.has(words[words.length - 1].toLowerCase())) words.pop();
  const w = words.slice(-3);
  while (w.length && STOP.has(w[0].toLowerCase())) w.shift();
  const base = w.map(x => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' ');
  if (!base) return fallback;
  return suffix && !new RegExp(`\\b${suffix}\\b`, 'i').test(base) ? `${base} ${suffix}` : base;
}

/**
 * The sample values in a document with no variables, each as a blank of
 * kind 'text' ({match, places: [{path, start, end, context}], label, fill,
 * token, who, found, became, rule}), plus a duties section
 * ({kind:'section'}) when there is one. `ctx` is the Hiring Setup
 * uploadContext (company legal name, address, phone, signatory, role names).
 *
 * The first rule that claims a text span wins: a value is dropped only when
 * the spot it was found at overlaps a span an earlier rule matched, or sits
 * inside a longer value. A longer value found later takes back the places
 * of a shorter one inside it ("Fresno, CA" inside the company address).
 */
export function findSamples(doc, ctx = {}) {
  const pars = paragraphs(doc);
  const claims = [];                                // {pi, start, end, len, primary, owner}
  const out = [];
  const labels = new Set();
  const uniq = (label) => {
    let l = label;
    for (let n = 2; labels.has(l.toLowerCase()); n++) l = `${label} ${n}`;
    labels.add(l.toLowerCase());
    return l;
  };
  // `pi`: the paragraph the rule found it in (undefined: anywhere - a ctx value)
  const take = (match, rule, def, pi) => {
    let m = clean(match).replace(/[,;:]+$/, '');
    if (/\.$/.test(m) && !/\b(Inc|Corp|Ltd|Co|L\.L\.C)\.$/.test(m)) m = m.slice(0, -1);
    if (m.length < 2) return;
    const re = new RegExp(wordRe(m).replace(/ /g, '\\s+'), 'g');
    const hits = [];
    pars.forEach(({ text }, i) => { for (const x of text.matchAll(re)) hits.push({ pi: i, start: x.index, end: x.index + x[0].length }); });
    const over = (h, c) => h.pi === c.pi && h.start < c.end && c.start < h.end;
    const blocked = (h) => claims.some(c => over(h, c) && (c.primary || c.len >= m.length));
    const free = hits.filter(h => !blocked(h));
    const primary = free.find(h => pi === undefined || h.pi === pi);
    if (!primary) return;
    // a longer value takes back a shorter one's other places inside it
    for (let j = claims.length - 1; j >= 0; j--) {
      const c = claims[j];
      if (!free.some(h => over(h, c))) continue;
      c.owner.places = c.owner.places.filter(pl => pl !== c.place);
      claims.splice(j, 1);
    }
    const b = { kind: 'text', match: m, found: m, rule, ...def, places: [] };
    if (b.label && b.fill !== 'nexus') b.label = uniq(b.label);
    free.forEach(h => {
      const place = { path: pars[h.pi].path, start: h.start, end: h.end, context: contextAt(pars[h.pi].text, h.start, h.end) };
      b.places.push(place);
      claims.push({ ...h, len: m.length, primary: h === primary, owner: b, place });
    });
    out.push(b);
  };
  const nexus = (token, label) => ({ fill: 'nexus', token, label });
  const company = [ctx.companyLegal, ctx.companyName].map(clean).filter(Boolean);
  const companyPhone = digits(ctx.companyPhone);

  // 1 "Label: Value" lines with a real value
  pars.forEach(({ text }, pi) => {
    const m = clean(text.split('\u0001').join(' ')).match(LABEL_VALUE);
    if (!m || BLANKISH.test(m[2]) || m[2].split(' ').length > 10) return;
    const [, label, raw] = m;
    const value = raw.replace(/[.;,]$/, '');
    const here = (def) => take(value, 'label', def, pi);
    if (company.some(c => c.toLowerCase() === value.toLowerCase())) return here(nexus('company_legal', 'Company Legal Name'));
    if (ctx.companyAddress && clean(ctx.companyAddress).toLowerCase() === value.toLowerCase()) return here(nexus('company_address', 'Company Address'));
    if (companyPhone && digits(value) === companyPhone) return;
    const canon = hireLabel(label);
    if (canon) return here({ fill: 'ask', label: canon.label });
    const g = guessFill(label);
    if (g.fill === 'leave' || (g.fill === 'ask' && !isPersonal(label))) return;   // "Re: Offer Of Employment" stays text
    here({ ...g, label: g.fill === 'nexus' ? (NEXUS_LABEL[g.token] || clean(label)) : clean(label), ...(g.fill === 'same' ? { value } : {}) });
  });

  // 2 the company's legal name
  company.forEach(c => take(c, 'company', nexus('company_legal', 'Company Legal Name')));
  pars.forEach(({ text }, pi) => { for (const m of text.matchAll(LEGAL)) take(m[0], 'company', nexus('company_legal', 'Company Legal Name'), pi); });
  const legal = out.filter(b => b.token === 'company_legal').map(b => b.match.toLowerCase());
  const legalAt = pars.findIndex(({ text }) => legal.some(l => text.toLowerCase().includes(l)));

  // 3 addresses: the company's near its name or at the top, anyone else's is the new hire's
  if (ctx.companyAddress) take(ctx.companyAddress, 'address', nexus('company_address', 'Company Address'));
  pars.forEach(({ text }, i) => {
    for (const m of text.matchAll(STREET)) {
      const near = i < 3 || (legalAt >= 0 && i > legalAt && i <= legalAt + 3);
      take(m[0], 'address', near && !out.some(b => b.token === 'company_address')
        ? nexus('company_address', 'Company Address') : nexus('address', 'Home Address'), i);
    }
  });

  // 4 the person's name, and their first name on its own (not the one inside the full name)
  pars.forEach(({ text }, pi) => NAMES.forEach(re => {
    for (const m of text.matchAll(re)) {
      if (company.some(c => c.toLowerCase().includes(m[1].toLowerCase()))) continue;
      const before = out.length;
      take(m[1], 'name', nexus('full_name', 'Full Name'), pi);
      if (out.length > before) take(m[1].split(/\s+/)[0], 'name', nexus('first_name', 'First Name'));
    }
  }));

  // 5 dates, by what is said just before them; any other date is HR's, named by the words before it
  pars.forEach(({ text }, i) => {
    for (const m of text.matchAll(DATE)) {
      const lead = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
      const def = /start|commenc|join|effective/.test(lead) ? nexus('start_date', 'Start Date')
        : /expire|accept by|respond by|valid until/.test(lead) ? nexus('offer_expires', 'Offer Expires')
          : i < 3 && clean(text.split('\u0001').join(' ')).length <= m[0].length + 12 ? nexus('today', "Today's Date")
            : { fill: 'hr', label: leadLabel(text, m.index, 'Date', 'Date') };
      take(m[0], 'date', def, i);
    }
  });

  // 6 money: the pay is the salary-like amount (or the first); the same amount again is the pay too,
  // any other amount is HR's answer named by the words before it ("Signing Bonus")
  const money = pars.flatMap(({ text }, pi) => [...text.matchAll(MONEY)].map(m => ({ m, pi, text })));
  const payish = ({ m, text }) => /(?:per|\/)\s*(?:year|annum|month|week|hour)$/i.test(m[0])
    || /salary|wage|\bpay\b|compensation|\bctc\b|stipend|\bfees?\b|remuneration/i.test(text.slice(Math.max(0, m.index - 60), m.index));
  const amount = (s) => digits(s.replace(/(?:per|\/).*$/i, ''));
  const pay = money.find(payish) || money[0];
  money.forEach(({ m, pi, text }) => take(m[0], 'pay', amount(m[0]) === amount(pay.m[0]) ? nexus('salary', 'Pay')
    : { fill: 'hr', label: leadLabel(text, m.index, 'Amount'), pay: true }, pi));

  // 7 the job title, right after "position of" / "as a" ... (a known role name when it starts there)
  const roles = [...(ctx.roleNames || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  pars.forEach(({ text }, pi) => {
    for (const m of text.matchAll(TITLE)) {
      const role = roles.find(r => m[1].toLowerCase().startsWith(r.toLowerCase()) && !/\w/.test(m[1][r.length] || ''));
      take(role ? m[1].slice(0, role.length) : m[1], 'title', nexus('job_title', 'Job Title'), pi);
    }
  });

  // 8 phone numbers (not the company's), 9 email
  pars.forEach(({ text }, pi) => {
    for (const m of text.matchAll(PHONE)) if (!companyPhone || digits(m[0]) !== companyPhone) take(m[0], 'phone', nexus('phone', 'Phone'), pi);
    for (const m of text.matchAll(EMAIL)) take(m[0], 'email', nexus('email', 'Personal Email'), pi);
  });

  const section = findSection(doc);
  const samples = out.filter(b => b.places.length).map(b => ({ ...b, context: b.places[0].context, who: whoOf(b), became: becameOf(b) }));
  return [...samples, ...(section ? [section] : [])];
}
