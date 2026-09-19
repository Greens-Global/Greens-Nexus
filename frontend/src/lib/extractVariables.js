// Turn {{tokens}} written in Word into real merge fields, on import.
//
// Sagar, Sep 17: "Is it possible to create the required variables dynamically
// automatically once the word text is pasted for template creation... so we
// don't have to manually remove the placeholders and insert [from] the
// library?"
//
// This is also a BUG fix, not only a convenience. A token typed in Word and
// imported arrives as ordinary TEXT, and the generator only ever substitutes
// mergeField NODES - so `Dear {{candidate.full_name}}` rendered exactly that,
// braces and all, however many values you supplied. Anyone writing a template
// the way the requirements document itself writes them would have produced a
// document that silently never populated.
//
// Scope, deliberately narrow: only `{{token}}` is recognised. Square brackets
// and underscores are NOT treated as placeholders - a legal document is full of
// "[sic]", "(a)", and signature rules - so guessing there would corrupt real
// text. The one syntax the requirements use is the one syntax read here.
import { isValidToken, tokenGroup, groupLabel } from './mergeFieldTypes';

// {{ token }} - whitespace inside the braces is tolerated because people type it.
const TOKEN_IN_TEXT = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

// What a variable's name says it holds. Requirement 5's types, inferred from
// the FIELD name - the last segment - not the whole dotted token.
//
// Reading the whole token made the group swallow the field: every variable
// under `compensation.` matched "compensation" and became Currency, so
// `compensation.currency` (a code like INR) and `compensation.pay_frequency`
// ("Monthly") were both money boxes that refused every value typed into them.
//
// Order matters. The explicitly-textual names come FIRST, because "currency"
// as a field name is a code, not an amount, and a city is not an address.
const TYPE_HINTS = [
  [/^(currency|frequency|pay_frequency|period|term|type|status|code|state|city|country|postal_code|zip|zipcode|province|region)$/i, 'text'],
  [/email/i, 'email'],
  [/(^|_)(date|expiry|expires)(_|$)|_date$|^date$/i, 'date'],
  [/(^|_)(amount|salary|price|cost|fee|total|principal|compensation|value)(_|$)/i, 'currency'],
  [/(^|_)(address|street)(_|$)/i, 'address'],
  [/(^|_)(name|signatory|contact|borrower|lender|manager|witness)(_|$)|_name$|^name$/i, 'person'],
  [/(^|_)(count|quantity|qty|days|months|years|number)(_|$)/i, 'number'],
];

export function inferType(token) {
  const field = String(token || '').split('.').pop();
  for (const [re, type] of TYPE_HINTS) if (re.test(field)) return type;
  return 'text';
}

// "party_a.legal_name" -> "Party A - Legal Name". The group is kept because the
// wizard lists fields flat: two bare "Legal Name" boxes would be a coin toss.
export function inferLabel(token) {
  const tail = String(token).split('.').pop()
    .replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const group = tokenGroup(token);
  return group === 'general' ? tail : `${groupLabel(group)} - ${tail}`;
}

export const inferFieldDef = (token) => ({
  token,
  label: inferLabel(token),
  type: inferType(token),
  required: true,          // a placeholder is in the document to be filled
  description: '',
  category: tokenGroup(token),
  default: '',
  validation: {},
});

// Emits `joined[from..to)` as text nodes, giving each stretch the marks of the
// node it originally came from - so formatting either side of a token is
// exactly what it was.
function pushSlice(out, run, owner, joined, from, to) {
  let start = from;
  while (start < to) {
    const ri = owner[start];
    let end = start;
    while (end < to && owner[end] === ri) end += 1;
    const text = joined.slice(start, end);
    if (text) out.push({ ...run[ri], text });
    start = end;
  }
}

// Scans a whole inline RUN rather than one text node at a time.
//
// A token is routinely split across several text nodes: autolink sees
// `candidate.city` as a hostname and wraps it in a link, leaving the paragraph
// as ['{{', 'candidate.city'(link), '}}, …']. Reading nodes individually finds
// nothing in that, which is exactly what happened to the real Offer Letter.
// Joining the run first means a token is found however the editor happens to
// have chopped it up, and the marks inside it (that stray link) disappear with
// the text they were on.
function processInline(children, walk) {
  const out = [];
  const tokens = [];
  let i = 0;
  while (i < children.length) {
    if (children[i]?.type !== 'text' || typeof children[i].text !== 'string') {
      out.push(walk(children[i]));
      i += 1;
      continue;
    }
    const run = [];
    while (i < children.length && children[i]?.type === 'text' && typeof children[i].text === 'string') {
      run.push(children[i]);
      i += 1;
    }
    const joined = run.map((n) => n.text).join('');
    const owner = [];
    run.forEach((n, ri) => { for (let k = 0; k < n.text.length; k += 1) owner.push(ri); });

    TOKEN_IN_TEXT.lastIndex = 0;
    const pieces = [];
    let last = 0;
    let found = false;
    let m;
    while ((m = TOKEN_IN_TEXT.exec(joined)) !== null) {
      const token = m[1].toLowerCase();
      if (!isValidToken(token)) continue;        // "{{ not a token }}" stays as written
      found = true;
      if (m.index > last) pushSlice(pieces, run, owner, joined, last, m.index);
      pieces.push({ type: 'mergeField', attrs: { token } });
      if (!tokens.includes(token)) tokens.push(token);
      last = m.index + m[0].length;
    }
    if (!found) { out.push(...run); continue; }
    if (last < joined.length) pushSlice(pieces, run, owner, joined, last, joined.length);
    out.push(...pieces);
  }
  return { nodes: out, tokens };
}

/**
 * Replaces every {{token}} in a TipTap document with a real merge field.
 * Returns the rewritten document and the distinct tokens found, in the order
 * they appear - which is the order the wizard should ask for them.
 */
export function extractVariables(json) {
  const seen = [];
  const note = (t) => { if (!seen.includes(t)) seen.push(t); };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (!Array.isArray(node.content)) return node;
    const { nodes, tokens } = processInline(node.content, walk);
    tokens.forEach(note);
    return { ...node, content: nodes };
  };

  return { json: walk(json), tokens: seen };
}

/**
 * The field definitions a template needs for the tokens just found, without
 * disturbing any the author has already configured by hand.
 */
export function mergeFieldDefs(existing, tokens) {
  const known = new Set((existing || []).map((f) => f.token));
  const added = tokens.filter((t) => !known.has(t)).map(inferFieldDef);
  return { fieldDefs: [...(existing || []), ...added], added };
}
