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
    const t = token || (b.fill === 'nexus' && !HIRE_TOKENS.has(b.token) ? b.token : '')
      || (guess.fill === 'nexus' && !HIRE_TOKENS.has(guess.token) ? guess.token : '') || NEXUS_FIELDS[0][0];
    return { ...b, fill: 'nexus', token: t, ...(b.rule && t !== b.token ? { label: NEXUS_LABEL[t] || b.label } : {}) };
  }
  if (who === 'hire') {
    const t = token || (HIRE_TOKENS.has(b.token) ? b.token : '');
    return t ? { ...b, fill: 'nexus', token: t } : { ...b, fill: 'ask', token: b.kind === 'existing' ? b.token : undefined };
  }
  const fill = { you: 'hr', same: 'same', paper: 'leave' }[who] || 'leave';
  return { ...b, fill, token: b.kind === 'existing' ? b.token : undefined };
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

function placesOf(pars, pattern) {
  const re = new RegExp(pattern, 'g');
  const out = [];
  pars.forEach(({ path, text }) => {
    let k = 0;
    for (const m of text.matchAll(re)) {
      const from = Math.max(0, m.index - 50);
      out.push({ path, occurrence: k, context: clean(`${from ? '...' : ''}${text.slice(from, m.index + m[0].length + 50)}`.split('\u0001').join(' ')) });
      k += 1;
    }
  });
  return out;
}

/**
 * The sample values in a document with no variables, each as a blank of
 * kind 'text' ({match, pattern, places, label, fill, token, who, found,
 * became, rule}), plus a duties section ({kind:'section'}) when there is one.
 * `ctx` is the Hiring Setup uploadContext (company legal name, address,
 * phone, signatory, role names).
 */
export function findSamples(doc, ctx = {}) {
  const pars = paragraphs(doc);
  const claimed = [];
  const out = [];
  const take = (match, rule, def, pattern) => {
    let m = clean(match).replace(/[,;:]+$/, '');
    if (/\.$/.test(m) && !/\b(Inc|Corp|Ltd|Co|L\.L\.C)\.$/.test(m)) m = m.slice(0, -1);
    if (m.length < 2) return;
    const low = m.toLowerCase();
    // an explicit pattern (the first name) already keeps clear of the longer match
    if (!pattern && claimed.some(c => c.includes(low) || low.includes(c))) return;
    const pat = pattern || wordRe(m);
    const places = placesOf(pars, pat);
    if (!places.length) return;
    claimed.push(low);
    const b = { kind: 'text', match: m, pattern: pat, places, context: places[0].context, found: m, rule, ...def };
    out.push({ ...b, who: whoOf(b), became: becameOf(b) });
  };
  const nexus = (token, label) => ({ fill: 'nexus', token, label });
  const company = [ctx.companyLegal, ctx.companyName].map(clean).filter(Boolean);
  const companyPhone = digits(ctx.companyPhone);

  // 1 "Label: Value" lines with a real value
  pars.forEach(({ text }) => {
    const m = clean(text.split('\u0001').join(' ')).match(LABEL_VALUE);
    if (!m || BLANKISH.test(m[2]) || m[2].split(' ').length > 10) return;
    const [, label, raw] = m;
    const value = raw.replace(/[.;,]$/, '');
    if (company.some(c => c.toLowerCase() === value.toLowerCase())) return take(value, 'label', nexus('company_legal', 'Company Legal Name'));
    if (ctx.companyAddress && clean(ctx.companyAddress).toLowerCase() === value.toLowerCase()) return take(value, 'label', nexus('company_address', 'Company Address'));
    if (companyPhone && digits(value) === companyPhone) return;
    const canon = hireLabel(label);
    if (canon) return take(value, 'label', { fill: 'ask', label: canon.label });
    const g = guessFill(label);
    if (g.fill === 'leave' || (g.fill === 'ask' && !isPersonal(label))) return;   // "Re: Offer Of Employment" stays text
    take(value, 'label', { ...g, label: g.fill === 'nexus' ? (NEXUS_LABEL[g.token] || clean(label)) : clean(label), ...(g.fill === 'same' ? { value } : {}) });
  });

  // 2 the company's legal name
  company.forEach(c => take(c, 'company', nexus('company_legal', 'Company Legal Name')));
  pars.forEach(({ text }) => { for (const m of text.matchAll(LEGAL)) take(m[0], 'company', nexus('company_legal', 'Company Legal Name')); });
  const legal = out.filter(b => b.token === 'company_legal').map(b => b.match.toLowerCase());
  const legalAt = pars.findIndex(({ text }) => legal.some(l => text.toLowerCase().includes(l)));

  // 3 addresses: the company's near its name or at the top, anyone else's is the new hire's
  if (ctx.companyAddress) take(ctx.companyAddress, 'address', nexus('company_address', 'Company Address'));
  pars.forEach(({ text }, i) => {
    for (const m of text.matchAll(STREET)) {
      const near = i < 3 || (legalAt >= 0 && i > legalAt && i <= legalAt + 3);
      take(m[0], 'address', near && !out.some(b => b.token === 'company_address')
        ? nexus('company_address', 'Company Address') : nexus('address', 'Home Address'));
    }
  });

  // 4 the person's name, and their first name on its own
  pars.forEach(({ text }) => NAMES.forEach(re => {
    for (const m of text.matchAll(re)) {
      if (company.some(c => c.toLowerCase().includes(m[1].toLowerCase()))) continue;
      const before = out.length;
      take(m[1], 'name', nexus('full_name', 'Full Name'));
      if (out.length > before) {
        const [firstWord, ...rest] = m[1].split(/\s+/);
        take(firstWord, 'name', nexus('first_name', 'First Name'), `${wordRe(firstWord)}(?!\\s+${escapeRe(rest[0])})`);
      }
    }
  }));

  // 5 dates, by what is said just before them
  pars.forEach(({ text }, i) => {
    for (const m of text.matchAll(DATE)) {
      const lead = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
      const def = /start|commenc|join|effective/.test(lead) ? nexus('start_date', 'Start Date')
        : /expire|accept by|respond by|valid until/.test(lead) ? nexus('offer_expires', 'Offer Expires')
          : i < 3 && clean(text.split('\u0001').join(' ')).length <= m[0].length + 12 ? nexus('today', "Today's Date")
            : { fill: 'hr', label: 'Date' };
      take(m[0], 'date', def);
    }
  });

  // 6 money
  pars.forEach(({ text }) => { for (const m of text.matchAll(MONEY)) take(m[0], 'pay', nexus('salary', 'Pay')); });

  // 7 the job title
  pars.forEach(({ text }) => { for (const m of text.matchAll(TITLE)) take(m[1], 'title', nexus('job_title', 'Job Title')); });
  (ctx.roleNames || []).forEach(r => take(r, 'title', nexus('job_title', 'Job Title')));

  // 8 phone numbers (not the company's), 9 email
  pars.forEach(({ text }) => {
    for (const m of text.matchAll(PHONE)) if (!companyPhone || digits(m[0]) !== companyPhone) take(m[0], 'phone', nexus('phone', 'Phone'));
    for (const m of text.matchAll(EMAIL)) take(m[0], 'email', nexus('email', 'Personal Email'));
  });

  const section = findSection(doc);
  return [...out, ...(section ? [section] : [])];
}
