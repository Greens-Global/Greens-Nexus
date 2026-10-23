// From a Word file to a template, without hunting for blanks (Oct 14).
//
// Pranshu, after building the Admin Associate template by hand on dev: "adding
// a template is hell - adding a variable, then this, that". Every blank took
// four clicks, a new variable could not be created, and signature lines had to
// be found and swapped one by one. This finds them all in the imported Word
// document and proposes what fills each one; HR confirms in one table
// (components/WordTemplateWizard.jsx) and applyBlanks writes the template.
//
// What counts as a blank:
//   cell       a table label cell ("PAN Number") whose neighbour cell is empty
//              (or only tick boxes - "☐ Savings ☐ Current" becomes a choice)
//   line       "Effective Date:" / "Name: [      ]" / "Address: ______"
//   bracket    "[          ]" inside a sentence
//   gap        "Rs.        per month", "______" inside a sentence
//   signature  "Contractor Signature:", "Signature:   Date:", "By:" - becomes
//              a Signature Block; the "Date:" / "Name:" lines under it go,
//              because the block draws its own.
import { formKey } from './packetFlow';

export const textOf = (n) => (!n ? '' : n.type === 'text' ? (n.text || '') : (n.content || []).map(textOf).join(''));
const NBSP = /\u00a0/g;
export const clean = (s) => String(s || '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
const cleanLabel = (s) => clean(s).replace(/[:\s_]+$/, '').replace(/^[\s:_]+/, '');

// What Nexus fills by itself - the choices of "Nexus fills it".
export const NEXUS_FIELDS = [
  ['full_name', 'Full Name'], ['first_name', 'First Name'], ['last_name', 'Last Name'],
  ['address', 'Current Address'], ['phone', 'Phone'], ['email', 'Personal Email'],
  ['job_title', 'Job Title'], ['department', 'Department'], ['start_date', 'Start Date'],
  ['salary', 'Salary / Pay'], ['manager', 'Manager'], ['company_legal', 'Company Legal Name'],
  ['company', 'Company Name'], ['company_address', 'Company Address'], ['today', "Today's Date"],
  ['signer.company', 'Company Signer - Name'], ['signer.company.title', 'Company Signer - Title'],
  ['emergency_name', 'Emergency Contact - Name'], ['emergency_relationship', 'Emergency Contact - Relationship'],
  ['emergency_phone', 'Emergency Contact - Phone'],
  // What HR answers once on the offer (Neil, Oct 14) - every letter can print them.
  ['work_location', 'Work Location (From The Offer)'], ['work_schedule', 'Work Hours And Days'],
  ['worker_type', 'Hired As (Employee / Contractor)'], ['employment_type', 'Employment Type'],
  ['offer_expires', 'Offer Expires'],
  // Hiring Setup (Oct 23): the role's duties and who signs for the company.
  ['role_description', "The Role's Duties"], ['signatory', 'Signs For The Company - Name And Title'],
];
const NEXUS_KEYS = new Set(NEXUS_FIELDS.map(([k]) => k));

// Filled by hand on the printed copy (a notary page), never by Nexus.
const PAPER = /notar|witness|\bseal\b|stamp|franking|e-stamp|registration number|place of|purchased by|date of issue|state of issue|value\b|work e-?mail/;
// Asked of HR when they make the offer - it changes per hire, and only HR knows
// it (Neil, Oct 14: "you can't send an offer without answering these
// questions. Who has to answer those? HR has to").
const HR_ANSWERS = /probation|notice period|bonus|commission|incentive|allowance|benefit|leave entitlement|paid time off|\bpto\b|reimburse|equity|stock option|relocation/;
// An answer only Pay & Benefits sees - an ID or account number.
const PRIVATE = /account (number|no)|aadha+r|\bpan\b|\bssn\b|social security|passport|tax id|\btin\b|licen[cs]e (number|no)|\bupi\b/;
// HR's answer that is pay.
const PAYISH = /salary|wage|\bpay\b|payment|compensation|\bctc\b|stipend|\bfees?\b|bonus|commission|incentive|allowance|equity|stock|amount|\brate\b/;

// The new hire's own details under the names People files them by
// (hr_life_events._profile_from_answers), so "DOB" and "Date of Birth" are
// one {{date_of_birth}} that lands on their record. First match wins.
export const HIRE_LABELS = [
  [/account holder/, 'Account Holder Name', 'account_holder_name'],
  [/account type|type of account/, 'Account Type', 'account_type'],
  [/date of birth|\bdob\b|birth ?date/, 'Date Of Birth', 'date_of_birth'],
  [/\bgender\b/, 'Gender', 'gender'],
  [/\bpan\b/, 'PAN Number', 'pan_number'],
  [/aadha+r/, 'Aadhaar Number', 'aadhaar_number'],
  [/social security|\bssn\b/, 'Social Security Number', 'ssn'],
  [/national id/, 'National ID', 'national_id'],
  [/ifsc/, 'IFSC Code', 'ifsc_code'],
  [/routing/, 'Routing Number', 'routing_number'],
  [/bank name|name of (the )?bank/, 'Bank Name', 'bank_name'],
  [/account (number|no)/, 'Bank Account Number', 'bank_account_number'],
  [/business name|doing business as|\bdba\b|trade name/, 'Business Name', 'business_name'],
];
/** The canonical {label, token} for a new hire's own detail, or null. */
export function hireLabel(label) {
  const l = clean(label).toLowerCase();
  const hit = HIRE_LABELS.find(([re]) => re.test(l));
  return hit ? { label: hit[1], token: hit[2] } : null;
}

/** Whether a person's answer should be Private (Pay & Benefits only). */
export const guessPrivate = (label) => PRIVATE.test(clean(label).toLowerCase());
/** Whether an HR answer is pay - entered only by Pay & Benefits holders. */
export const guessPay = (label) => PAYISH.test(clean(label).toLowerCase());

// The person's own details - asked on the Details Form.
const PERSONAL = /\bpan\b|aadha+r|\bssn\b|social security|passport|account (number|no)|ifsc|\bupi\b|\bbank\b|branch|licen[cs]e|date of birth|\bdob\b|birth|gender|nationality|marital|blood|whatsapp|middle name|\bcity\b|\bstate\b|pin ?code|zip|postal|account holder|type of account|account type|18 or older/;

/** Whether a label names the person's own detail (asked on the Details Form). */
export const isPersonal = (label) => PERSONAL.test(clean(label).toLowerCase()) || !!hireLabel(label);

/** The best guess for a blank, from its label and where it sits. */
export function guessFill(label, ctx = {}) {
  const l = clean(label).toLowerCase();
  if (!l) return { fill: 'ask' };
  if (PAPER.test(l)) return { fill: 'leave' };
  if (ctx.emergency) {
    if (/e-?mail/.test(l)) return { fill: 'ask' };
    if (/relationship/.test(l)) return { fill: 'nexus', token: 'emergency_relationship' };
    if (/phone|telephone|mobile|number/.test(l) && !/e-?mail/.test(l)) return { fill: 'nexus', token: 'emergency_phone' };
    if (/name/.test(l)) return { fill: 'nexus', token: 'emergency_name' };
  }
  if (PERSONAL.test(l) || /business name|doing business|\bdba\b|trade name/.test(l)) return { fill: 'ask' };
  if (/client/.test(l)) return { fill: 'same' };
  if (/work location|place of work|location of work|primary location|office location|work site/.test(l)) return { fill: 'nexus', token: 'work_location' };
  if (/working hours|hours of work|work hours|work schedule|shift timing|timings/.test(l)) return { fill: 'nexus', token: 'work_schedule' };
  if (HR_ANSWERS.test(l)) return { fill: 'hr' };
  if (/first name|given name/.test(l)) return { fill: 'nexus', token: 'first_name' };
  if (/last name|surname|family name/.test(l)) return { fill: 'nexus', token: 'last_name' };
  if (/company.*address|business address|registered address|office address/.test(l)) return { fill: 'nexus', token: 'company_address' };
  if (/company|employer|organi[sz]ation/.test(l)) return { fill: 'nexus', token: 'company_legal' };
  if (/emergency|alternate contact/.test(l)) return { fill: 'nexus', token: 'emergency_name' };
  if (/e-?mail/.test(l)) return { fill: 'nexus', token: 'email' };
  if (/address/.test(l)) return { fill: 'nexus', token: 'address' };
  if (/\bname\b/.test(l)) return { fill: 'nexus', token: 'full_name' };
  if (/mobile|phone|telephone|contact number/.test(l)) return { fill: 'nexus', token: 'phone' };
  if (/effective date|start date|date of engagement|date of joining|joining date|commencement/.test(l)) return { fill: 'nexus', token: 'start_date' };
  if (/salary|payment|compensation|\bctc\b|remuneration|stipend|wage|\bpay\b|\bfees?\b|\brs\b|₹|\$|\binr\b|\busd\b/.test(l)) return { fill: 'nexus', token: 'salary' };
  if (/department/.test(l)) return { fill: 'nexus', token: 'department' };
  if (/^title$/.test(l) && ctx.companySigner) return { fill: 'nexus', token: 'signer.company.title' };
  if (/job title|designation|position|\brole\b|^title$/.test(l)) return { fill: 'nexus', token: 'job_title' };
  if (/manager|supervisor|reporting to|reports to/.test(l)) return { fill: 'nexus', token: 'manager' };
  if (/^date$/.test(l)) return { fill: 'nexus', token: 'today' };
  return { fill: 'ask' };
}

// A {{variable}} already in place (wordSamples existingTokens): textOf skips it, so it must not read as empty.
const hasField = (n) => !!n && (n.type === 'mergeField' || (n.content || []).some(hasField));
const isBlankText = (t) => !clean(t).replace(/[_.\-–—]/g, '').trim();
const BOXES = /[☐☑☒]/;

function boxChoices(t) {
  return String(t || '').split(BOXES).map(clean).filter(Boolean);
}

const SIGNATURE = /signature\s*:?[\s_]*(?:date\s*:?[\s_]*)?$/i;
const BY_LINE = /^\s*by\s*:?\s*[_\s]*$/i;
const ABSORB = /^(date|name|printed name|signature date)\s*:?\s*[[\]\s_]*$/i;
const LINE_LABEL = /^([^:]{2,80}?):\s*(?:\[[\s\u00a0]*\]|[_\s\u00a0]*)$/;
const BRACKET = /\[[\s\u00a0]*\]/g;
const GAP = /(?:(rs\.?|₹|\$|inr|usd)[\s\u00a0]{3,}(?:per\s+(?:month|year|annum|hour|week))?|_{3,})/gi;

const prevWords = (text, at, n = 6) => clean(text.slice(0, at)).split(' ').slice(-n).join(' ');

function whoSigns(label, blocks, i) {
  const l = clean(label).toLowerCase();
  if (/company|employer|representative|authori[sz]ed|director|manager|hr\b/.test(l)) return 'company';
  if (/contractor|employee|candidate|consultant|intern|associate/.test(l)) return 'employee';
  // "COMPANY" / "CONTRACTOR:" a few lines above decides
  for (let j = i - 1, seen = 0; j >= 0 && seen < 5; j--) {
    const t = clean(textOf(blocks[j])).toLowerCase();
    if (!t) continue;
    seen += 1;
    if (/^(company|employer)\b/.test(t) || /^by\s*:?$/.test(t)) return 'company';
    if (/^(contractor|employee|candidate)\b/.test(t)) return 'employee';
  }
  return BY_LINE.test(label) ? 'company' : 'employee';
}

/** Every blank and signature line in an imported document, in order, each
 *  with a guess. `doc` is the converter's {type:'doc', content}. */
export function findBlanks(doc) {
  const blocks = doc?.content || [];
  const out = [];
  const skip = new Set();
  let lastSigner = '';
  const nextText = (i) => {
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j].type !== 'paragraph') return { type: blocks[j].type, text: '' };
      const t = clean(textOf(blocks[j]));
      if (t) return { type: 'paragraph', text: t };
    }
    return { type: '', text: '' };
  };
  for (let i = 0; i < blocks.length; i++) {
    if (skip.has(i)) continue;
    const b = blocks[i];
    if (b.type === 'table') {
      const labels = (b.content || []).flatMap(r => (r.content || []).map(c => clean(textOf(c)).toLowerCase()));
      const emergency = labels.some(l => /emergency|alternate contact/.test(l));
      (b.content || []).forEach((row, r) => {
        const cells = row.content || [];
        cells.forEach((cell, c) => {
          const label = cleanLabel(textOf(cell));
          const next = cells[c + 1];
          if (!label || label.length > 70 || !next || hasField(next)) return;
          const nt = textOf(next);
          if (!isBlankText(nt) && !BOXES.test(nt)) return;
          const options = BOXES.test(nt) ? boxChoices(nt) : [];
          if (isBlankText(nt) === false && !options.length) return;
          if (!isBlankText(label) && BOXES.test(textOf(cell))) return;
          out.push({ kind: 'cell', at: [i, r, c + 1], label, options, context: label,
            ...(options.length ? { fill: 'ask' } : guessFill(label, { emergency })) });
        });
      });
      continue;
    }
    if (b.type !== 'paragraph') continue;
    const text = textOf(b);
    const t = clean(text);
    if (!t) continue;
    if ((SIGNATURE.test(t) && t.length < 80) || BY_LINE.test(t)) {
      const caption = cleanLabel(t.split(/signature/i)[0]).replace(/^by$/i, '');
      if (PAPER.test(caption.toLowerCase())) {          // a witness / notary line - filled on paper
        out.push({ kind: 'line', at: [i], label: cleanLabel(t), context: t, fill: 'leave' });
        continue;
      }
      const who = whoSigns(caption || t, blocks, i);
      const absorb = [];
      const under = [];                 // bare "[      ]" lines under the signature
      for (let j = i + 1; j < blocks.length && j <= i + 8; j++) {
        const nt = clean(textOf(blocks[j]));
        if (blocks[j].type !== 'paragraph') break;
        if (!nt) continue;
        if (ABSORB.test(nt)) { absorb.push(j); skip.add(j); continue; }
        if (/^\[[\s\u00a0]*\]$/.test(nt)) { under.push(j); skip.add(j); continue; }
        break;
      }
      lastSigner = who;
      out.push({ kind: 'signature', at: [i], label: caption || (who === 'company' ? 'Company' : 'Signature'),
        context: t, who, absorb, fill: 'sign' });
      // Under a company signature the bare lines are its title, then the
      // company - the name and date lines are drawn by the block itself.
      const UNDER = who === 'company' ? [['Signer Title', 'signer.company.title'], ['Company Name', 'company_legal']] : [];
      under.forEach((j, n) => {
        const [label, token] = UNDER[n] || ['Blank Line', ''];
        out.push({ kind: 'bracket', at: [j], occurrence: 0, label, context: `Line under the ${who === 'company' ? 'company' : 'person'}'s signature`,
          ...(token ? { fill: 'nexus', token } : { fill: 'leave' }) });
      });
      continue;
    }
    const line = t.match(LINE_LABEL);
    const after = nextText(i);
    const leadIn = line && (cleanLabel(line[1]).length > 40 || /List$/.test(after.type)
      || /^[([•\-–]|^\d+[.)]/.test(after.text) && !/^\[[\s\u00a0]*\]$/.test(after.text));
    // "COMPANY:" / "CONTRACTOR:" in capitals heads a signature section; "Company:" is a blank.
    const heading = line && /^(COMPANY|CONTRACTOR|EMPLOYEE|CLIENT|EMPLOYER)$/.test(cleanLabel(line[1]));
    if (line && !leadIn && !heading && !hasField(b)) {
      const label = cleanLabel(line[1]);
      out.push({ kind: 'line', at: [i], label, context: t,
        ...guessFill(label, { companySigner: lastSigner === 'company' }) });
      continue;
    }
    let k = 0;
    for (const m of text.matchAll(BRACKET)) {
      const before = prevWords(text, m.index);
      const label = before || 'Blank Line';
      const bare = !clean(text.replace(BRACKET, ''));
      out.push({ kind: 'bracket', at: [i], occurrence: k, label, context: t.slice(0, 140),
        fill: bare ? 'leave' : /:\s*$/.test(before) ? guessFill(before).fill : 'same',
        ...(/:\s*$/.test(before) && guessFill(before).token ? { token: guessFill(before).token } : {}) });
      k += 1;
    }
    k = 0;
    for (const m of text.matchAll(GAP)) {
      const before = prevWords(text, m.index);
      const label = m[1] ? `${before} ${m[1]}`.trim() : before || 'Blank';
      out.push({ kind: 'gap', at: [i], occurrence: k, label, context: t.slice(0, 140),
        ...(m[1] ? { fill: 'nexus', token: 'salary' } : guessFill(label)) });
      k += 1;
    }
  }
  return out.map((x, n) => ({ ...x, id: `b${n + 1}` }));
}

const mf = (token) => ({ type: 'mergeField', attrs: { token } });

/** Replace the k-th match of `re` in a paragraph with a merge field, even when
 *  Word split the match across several runs. */
function replaceMatch(par, re, k, token) {
  const full = (par.content || []).map(r => (r.type === 'text' ? r.text || '' : '\u0001')).join('');
  const m = [...full.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))][k];
  if (m) replaceSpan(par, [m.index, m.index + m[0].length], mf(token));
}

/** Replace [start, end) of a paragraph's text (a non-text run counts as one
 *  character) with `node`, even when Word split the text across runs. */
function replaceSpan(par, span, node) {
  const runs = par.content || [];
  const ONE = '\u0001';
  const out = [];
  let pos = 0;
  let placed = false;
  for (const r of runs) {
    const t = r.type === 'text' ? r.text || '' : ONE;
    const start = pos;
    const end = pos + t.length;
    pos = end;
    if (r.type !== 'text' || end <= span[0] || start >= span[1]) { out.push(r); continue; }
    if (span[0] > start) out.push({ ...r, text: t.slice(0, span[0] - start) });
    if (!placed) { out.push(node); placed = true; }
    if (span[1] < end) out.push({ ...r, text: t.slice(span[1] - start) });
  }
  par.content = out.filter(r => r.type !== 'text' || r.text);
}

/** The variable each blank fills, after HR's choices: one variable per label,
 *  so "PAN Number" in three places is one {{pan_number}}. */
export function tokensFor(blanks) {
  const byLabel = new Map();
  const used = new Set();
  return blanks.map(b => {
    // A {{variable}} the file already had keeps its name.
    if (b.kind === 'existing') return b.fill === 'leave' ? '' : b.fill === 'nexus' ? b.token : b.orig;
    if (b.fill === 'nexus') return b.token;
    if (b.fill !== 'ask' && b.fill !== 'same' && b.fill !== 'hr') return '';
    const canon = b.fill === 'ask' ? hireLabel(b.label) : null;
    const key = (canon ? canon.label : clean(b.label)).toLowerCase();
    if (byLabel.has(key)) return byLabel.get(key);
    // "Driver's Licence No. (if applicable)" -> drivers_licence_no
    let token = canon ? canon.token : formKey(String(b.label).replace(/\([^)]*\)/g, ' ').replace(/'s\b/gi, 's')) || 'detail';
    while (NEXUS_KEYS.has(token) || used.has(token)) token = `${token}_value`;
    used.add(token);
    byLabel.set(key, token);
    return token;
  });
}

/** The template content after HR's choices: {doc, fieldDefs, signers}. */
export function applyBlanks(doc, blanks) {
  const out = JSON.parse(JSON.stringify(doc));
  const blocks = out.content || [];
  const tokens = tokensFor(blanks);
  const remove = new Set();
  const defs = new Map();
  const signers = new Set();
  // Sample text Nexus recognized (lib/wordSamples.js), at the exact spans it
  // claimed, before anything below replaces blocks. Leave Blank For Paper
  // prints a line in place of the sample.
  const spans = new Map();
  blanks.forEach((b, n) => {
    if (b.kind !== 'text' || !b.rule) return;
    const node = tokens[n] ? mf(tokens[n]) : b.fill === 'leave' ? { type: 'text', text: '________' } : null;
    if (node) (b.places || []).forEach(pl => { const k = pl.path.join('.'); spans.set(k, [...(spans.get(k) || []), [pl.start, pl.end, node]]); });
  });
  spans.forEach((list, k) => {
    const par = nodeAt(out, k.split('.').map(Number));
    if (par && Array.isArray(par.content)) list.sort((a, b) => b[0] - a[0]).forEach(([s, e, node]) => replaceSpan(par, [s, e], node));
  });
  blanks.forEach((b, n) => {
    const token = tokens[n];
    if (b.kind === 'signature') {
      if (b.fill !== 'sign') return;
      const role = b.who || 'employee';     // employee | company, or (Hiring Setup) hr | signatory | manager
      signers.add(role);
      blocks[b.at[0]] = { type: 'signatureBlock', attrs: { role, label: /^(company|signature)$/i.test(b.label) ? '' : b.label, withName: true, withDate: true } };
      (b.absorb || []).forEach(j => remove.add(j));
      return;
    }
    // A duties section HR chose to print the role's duties in (Hiring Setup):
    // its body becomes one {{role_description}}; the heading stays.
    if (b.kind === 'section') {
      const [s, e] = b.at || [];
      if (b.answer !== 'inside' || !(e > s)) return;
      blocks[s + 1] = { type: 'paragraph', content: [mf('role_description')] };
      for (let j = s + 2; j <= e; j++) remove.add(j);
      return;
    }
    if (b.kind === 'existing' && b.fill === 'leave') { swapField(out, b.orig, { type: 'text', text: '________' }); return; }
    if (!token) return;
    if (b.fill === 'ask' || b.fill === 'same' || b.fill === 'hr') {
      const prev = defs.get(token);
      defs.set(token, {
        token, label: clean(b.label), required: false,
        type: b.options?.length ? 'dropdown' : /date|birth|\bdob\b/i.test(b.label) ? 'date' : 'text',
        ...(b.options?.length ? { options: b.options } : {}),
        default: b.fill === 'same' ? String(b.value || '') : (prev?.default || ''),
        // Who fills it (Oct 14): the person on their intake form, or HR on the offer.
        source: b.fill === 'ask' ? 'person' : b.fill === 'hr' ? 'hr' : '',
        ...(b.fill === 'ask' ? { sensitive: b.private ?? guessPrivate(b.label) } : {}),
        ...(b.fill === 'hr' ? { pay: b.pay ?? guessPay(b.label) } : {}),
      });
    }
    if (b.kind === 'existing') {                     // already in place - renamed only when HR picked a Nexus field
      if (token !== b.orig) swapField(out, b.orig, token);
      return;
    }
    if (b.kind === 'text' || !b.at) return;          // placed below, wherever it appears
    const target = blocks[b.at[0]];
    if (!target) return;
    if (b.kind === 'cell') {
      const cell = target.content?.[b.at[1]]?.content?.[b.at[2]];
      if (!cell) return;
      const first = (cell.content || []).find(x => x.type === 'paragraph') || { type: 'paragraph' };
      cell.content = [{ ...first, content: [mf(token)] }];
    } else if (b.kind === 'line') {
      const head = (target.content || []).find(r => r.type === 'text' && r.text?.trim());
      const label = clean(b.label);
      target.content = [{ ...(head || { type: 'text' }), text: `${label}: ` }, mf(token)];
    } else if (b.kind === 'bracket') {
      replaceMatch(target, BRACKET, b.occurrence, token);
    } else if (b.kind === 'gap') {
      replaceMatch(target, GAP, b.occurrence, token);
    }
  });
  // Text HR picked by hand ("Missed one?"): every chosen place it appears.
  blanks.forEach((b, n) => {
    const token = tokens[n];
    if (b.kind !== 'text' || b.rule || !token || !b.match) return;
    const re = new RegExp(escapeRe(b.match), 'gi');
    const byPar = new Map();
    (b.places || []).forEach(pl => {
      const key = pl.path.join('.');
      byPar.set(key, [...(byPar.get(key) || []), pl.occurrence]);
    });
    byPar.forEach((occ, key) => {
      const node = nodeAt(out, key.split('.').map(Number));
      if (!node || !Array.isArray(node.content)) return;
      // last first, so the earlier places keep their numbers
      [...occ].sort((a, b2) => b2 - a).forEach(k => replaceMatch(node, re, k, token));
    });
  });
  out.content = blocks.filter((_, i) => !remove.has(i));
  return { doc: out, fieldDefs: [...defs.values()], signers: [...signers] };
}

// Every {{from}} becomes {{to}} (a token), or a copy of the node `to`.
function swapField(node, from, to) {
  (node?.content || []).forEach((c, i) => {
    if (c.type === 'mergeField' && c.attrs?.token === from) node.content[i] = typeof to === 'string' ? { ...c, attrs: { ...c.attrs, token: to } } : { ...to };
    else swapField(c, from, to);
  });
}

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nodeAt = (root, path) => path.reduce((n, i) => (n && n.content ? n.content[i] : undefined), root);

/** Every place a piece of text appears in the document (paragraphs and
 *  headings anywhere - tables and lists included), for "Missed one?". */
export function findText(doc, query) {
  const q = String(query || '');
  if (q.trim().length < 2) return [];
  const re = new RegExp(escapeRe(q), 'gi');
  const out = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'paragraph' || node.type === 'heading') && Array.isArray(node.content)) {
      const text = node.content.map(r => (r.type === 'text' ? r.text || '' : '\u0001')).join('');
      let k = 0;
      for (const m of text.matchAll(re)) {
        const from = Math.max(0, m.index - 50);
        const around = `${from ? '...' : ''}${text.slice(from, m.index + m[0].length + 50)}`.split('\u0001').join(' ');
        out.push({ path, occurrence: k, context: clean(around) });
        k += 1;
      }
      return;
    }
    (node.content || []).forEach((c, i) => walk(c, [...path, i]));
  };
  walk(doc, []);
  return out;
}

// A duties section (Hiring Setup, Oct 23): a heading or short line - a
// heading, bold, ending in ":" or numbered - that says duties,
// responsibilities, job description or scope of work, through the block
// before the next heading. {kind:'section', at:[start, end], label} or null.
const DUTIES = /duties|responsibilit|job description|scope of work/i;
const NUMBERED = /^(\d+(\.\d+)*[.)]?|[IVX]+\.|[A-Z][.)])\s+\S/;
const allBold = (b) => {
  const runs = (b.content || []).filter(r => r.type === 'text' && r.text?.trim());
  return runs.length > 0 && runs.every(r => (r.marks || []).some(m => m.type === 'bold'));
};
const headingLike = (b) => {
  if (b?.type === 'heading') return true;
  if (b?.type !== 'paragraph') return false;
  const t = clean(textOf(b));
  return !!t && t.length <= 60 && (allBold(b) || /:$/.test(t) || (NUMBERED.test(t) && !/[.;]$/.test(t)));
};
export function findSection(doc) {
  const blocks = doc?.content || [];
  for (let i = 0; i < blocks.length; i++) {
    const t = clean(textOf(blocks[i]));
    if (!headingLike(blocks[i]) || !DUTIES.test(t)) continue;
    let end = i;
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j];
      const bt = clean(textOf(b));
      if (b.type === 'pageBreak' || headingLike(b) || SIGNATURE.test(bt) || BY_LINE.test(bt)) break;
      end = j;
    }
    while (end > i && !clean(textOf(blocks[end]))) end -= 1;   // trailing empty lines stay
    const label = t.replace(/^(\d+(\.\d+)*[.)]?|[IVX]+\.|[A-Z][.)])\s+/, '').replace(/:$/, '').trim();
    if (end > i) return { kind: 'section', at: [i, end], label, context: t };
  }
  return null;
}

/** Real pages at Word's own page breaks - the editor's shape. */
export function splitPages(doc) {
  const segs = [[]];
  for (const n of doc?.content || []) {
    if (n.type === 'pageBreak') segs.push([]);
    else segs[segs.length - 1].push(n);
  }
  const kept = segs.filter(s => s.some(n => n.type !== 'paragraph' || textOf(n).trim()));
  return (kept.length ? kept : [[{ type: 'paragraph' }]]).map((content, i) => ({ id: `pg_${Date.now().toString(36)}${i}`, json: { type: 'doc', content } }));
}
