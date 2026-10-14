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

const textOf = (n) => (!n ? '' : n.type === 'text' ? (n.text || '') : (n.content || []).map(textOf).join(''));
const NBSP = /\u00a0/g;
const clean = (s) => String(s || '').replace(NBSP, ' ').replace(/\s+/g, ' ').trim();
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
];
const NEXUS_KEYS = new Set(NEXUS_FIELDS.map(([k]) => k));

// Filled by hand on the printed copy (a notary page), never by Nexus.
const PAPER = /notar|witness|\bseal\b|stamp|franking|e-stamp|registration number|place of|purchased by|date of issue|state of issue|value\b|work e-?mail/;
// The person's own details - asked on the Details Form.
const PERSONAL = /\bpan\b|aadha+r|\bssn\b|social security|passport|account (number|no)|ifsc|\bupi\b|\bbank\b|branch|licen[cs]e|date of birth|\bdob\b|birth|gender|nationality|marital|blood|whatsapp|middle name|\bcity\b|\bstate\b|pin ?code|zip|postal|account holder|type of account|account type|18 or older/;

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
  if (PERSONAL.test(l)) return { fill: 'ask' };
  if (/client/.test(l)) return { fill: 'same' };
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
          if (!label || label.length > 70 || !next) return;
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
    if (line && !leadIn && !heading) {
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
  const runs = par.content || [];
  const ONE = '\u0001';
  const full = runs.map(r => (r.type === 'text' ? r.text || '' : ONE)).join('');
  const spans = [...full.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))]
    .map(m => [m.index, m.index + m[0].length]);
  const span = spans[k];
  if (!span) return;
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
    if (!placed) { out.push(mf(token)); placed = true; }
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
    if (b.fill === 'nexus') return b.token;
    if (b.fill !== 'ask' && b.fill !== 'same') return '';
    const key = clean(b.label).toLowerCase();
    if (byLabel.has(key)) return byLabel.get(key);
    // "Driver's Licence No. (if applicable)" -> drivers_licence_no
    let token = formKey(String(b.label).replace(/\([^)]*\)/g, ' ').replace(/'s\b/gi, 's')) || 'detail';
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
  blanks.forEach((b, n) => {
    const token = tokens[n];
    if (b.kind === 'signature') {
      if (b.fill !== 'sign') return;
      const role = b.who === 'company' ? 'company' : 'employee';
      signers.add(role);
      blocks[b.at[0]] = { type: 'signatureBlock', attrs: { role, label: /^(company|signature)$/i.test(b.label) ? '' : b.label, withName: true, withDate: true } };
      (b.absorb || []).forEach(j => remove.add(j));
      return;
    }
    if (!token) return;
    if (b.fill === 'ask' || b.fill === 'same') {
      const prev = defs.get(token);
      defs.set(token, {
        token, label: clean(b.label), required: false,
        type: b.options?.length ? 'dropdown' : /date|birth|\bdob\b/i.test(b.label) ? 'date' : 'text',
        ...(b.options?.length ? { options: b.options } : {}),
        default: b.fill === 'same' ? String(b.value || '') : (prev?.default || ''),
      });
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
    if (b.kind !== 'text' || !token || !b.match) return;
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

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
