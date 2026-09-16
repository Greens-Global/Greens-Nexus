// {{tokens}} written in Word become real merge fields on import.
//
// Sagar, Sep 17: "Is it possible to create the required variables dynamically
// automatically once the word text is pasted... so we don't have to manually
// remove the placeholders and insert [from] the library?"
//
// It is also a bug fix. An imported token arrives as ordinary TEXT, and the
// generator only substitutes mergeField NODES, so `Dear {{candidate.full_name}}`
// exported with the braces intact no matter what values were supplied -
// verified against the real exporter before this was written.
//
//     npx vitest run src/lib/extractVariables.test.js
import { describe, expect, it } from 'vitest';
import { extractVariables, inferFieldDef, inferLabel, inferType, mergeFieldDefs } from './extractVariables';

const para = (...content) => ({ type: 'paragraph', content });
const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const doc = (...content) => ({ type: 'doc', content });

const kindsOf = (node) => (node.content || []).map(n => n.type);
const tokensIn = (json) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mergeField') out.push(n.attrs.token);
    (n.content || []).forEach(walk);
  };
  walk(json);
  return out;
};

describe('finding the variables an imported document was written with', () => {
  it('turns a token into a real merge field', () => {
    const { json, tokens } = extractVariables(doc(para(text('Dear {{candidate.full_name}},'))));
    expect(tokens).toEqual(['candidate.full_name']);
    expect(kindsOf(json.content[0])).toEqual(['text', 'mergeField', 'text']);
    expect(tokensIn(json)).toEqual(['candidate.full_name']);
  });

  it('keeps the words either side of it', () => {
    const { json } = extractVariables(doc(para(text('Dear {{candidate.full_name}}, welcome.'))));
    const [before, , after] = json.content[0].content;
    expect(before.text).toBe('Dear ');
    expect(after.text).toBe(', welcome.');
  });

  it('keeps the formatting of the text around it', () => {
    // A bold sentence with a token in it must still be bold afterwards.
    const marks = [{ type: 'bold' }, { type: 'textStyle', attrs: { fontSize: '12.2pt' } }];
    const { json } = extractVariables(doc(para(text('Salary: {{offer.salary}} per year', marks))));
    const parts = json.content[0].content;
    expect(parts[0].marks).toEqual(marks);
    expect(parts[2].marks).toEqual(marks);
  });

  it('handles several tokens in one sentence, in order', () => {
    const { tokens } = extractVariables(doc(para(text(
      'between {{party_a.legal_name}} and {{party_b.legal_name}} on {{agreement.effective_date}}.'))));
    expect(tokens).toEqual(['party_a.legal_name', 'party_b.legal_name', 'agreement.effective_date']);
  });

  it('reports each distinct variable once, however often it is used', () => {
    const { tokens, json } = extractVariables(doc(
      para(text('{{party_a.legal_name}} agrees')),
      para(text('and {{party_a.legal_name}} confirms'))));
    expect(tokens).toEqual(['party_a.legal_name']);
    expect(tokensIn(json)).toHaveLength(2);      // both occurrences still replaced
  });

  it('tolerates the spaces people type inside the braces', () => {
    const { tokens } = extractVariables(doc(para(text('{{ offer.job_title }}'))));
    expect(tokens).toEqual(['offer.job_title']);
  });

  it('reaches tokens inside tables and lists', () => {
    const { tokens } = extractVariables(doc({
      type: 'table',
      content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [para(text('{{offer.salary}}'))] }] }],
    }));
    expect(tokens).toEqual(['offer.salary']);
  });

  it('leaves text that only looks like a token alone', () => {
    // Legal prose is full of braces and brackets; only a legal token name counts.
    const { json, tokens } = extractVariables(doc(para(text('See {{ not a token }} and [sic] and {}.'))));
    expect(tokens).toEqual([]);
    expect(json.content[0].content[0].text).toBe('See {{ not a token }} and [sic] and {}.');
  });

  it('finds a token the editor split across nodes', () => {
    // The real Offer Letter: autolink saw `candidate.city` as a hostname and
    // wrapped it in a link, leaving ['{{', 'candidate.city'(link), '}}, ...'].
    // Read node by node there is nothing to find, which is why the template
    // sat there with its braces showing.
    const { json, tokens } = extractVariables(doc(para(
      text('{{'),
      text('candidate.city', [{ type: 'link', attrs: { href: 'http://candidate.city' } }]),
      text('}}, {{candidate.state}} {{candidate.postal_code}}'),
    )));
    expect(tokens).toEqual(['candidate.city', 'candidate.state', 'candidate.postal_code']);
    expect(tokensIn(json)).toEqual(['candidate.city', 'candidate.state', 'candidate.postal_code']);
    // The stray link goes with the text it was on.
    const linkLeft = (json.content[0].content || []).some(
      n => (n.marks || []).some(mk => mk.type === 'link'));
    expect(linkLeft).toBe(false);
  });

  it('keeps the punctuation around a split token', () => {
    const { json } = extractVariables(doc(para(
      text('{{'), text('candidate.city', [{ type: 'link' }]), text('}}, ST 00000'))));
    const tail = json.content[0].content.filter(n => n.type === 'text').map(n => n.text).join('');
    expect(tail).toBe(', ST 00000');
  });

  it('leaves a document with no tokens untouched', () => {
    const input = doc(para(text('This Agreement is made today.')));
    expect(extractVariables(input).json).toEqual(input);
  });
});

describe('guessing what each variable is', () => {
  it('reads the type from the name', () => {
    expect(inferType('party_a.notice_email')).toBe('email');
    expect(inferType('agreement.effective_date')).toBe('date');
    expect(inferType('offer.salary')).toBe('currency');
    expect(inferType('principal.amount')).toBe('currency');
    expect(inferType('party_b.address')).toBe('address');
    expect(inferType('party_a.signatory_name')).toBe('person');
    expect(inferType('agreement.purpose')).toBe('text');
  });

  it('labels a variable so two parties can be told apart', () => {
    // The wizard lists fields flat - two bare "Legal Name" boxes is a coin toss.
    expect(inferLabel('party_a.legal_name')).toBe('Party A - Legal Name');
    expect(inferLabel('party_b.legal_name')).toBe('Party B - Legal Name');
    expect(inferLabel('full_name')).toBe('Full Name');
  });

  it('builds a definition the wizard can use as it stands', () => {
    const def = inferFieldDef('agreement.effective_date');
    expect(def).toMatchObject({
      token: 'agreement.effective_date',
      label: 'Agreement - Effective Date',
      type: 'date',
      required: true,
      category: 'agreement',
    });
  });
});

describe('adding them to the template', () => {
  it('adds only what is new', () => {
    const existing = [{ token: 'offer.salary', label: 'Annual Salary', type: 'currency', required: true }];
    const { fieldDefs, added } = mergeFieldDefs(existing, ['offer.salary', 'offer.start_date']);
    expect(added.map(d => d.token)).toEqual(['offer.start_date']);
    expect(fieldDefs).toHaveLength(2);
  });

  it('never overwrites a definition the author configured by hand', () => {
    const existing = [{ token: 'offer.salary', label: 'Annual Salary', type: 'currency',
                        required: false, description: 'Gross, before tax' }];
    const { fieldDefs } = mergeFieldDefs(existing, ['offer.salary']);
    expect(fieldDefs).toEqual(existing);
  });
});

describe("the real NDA's variables", () => {
  const NDA = doc(
    para(text('This Agreement is entered into as of {{agreement.effective_date}} by and between '),
         text('{{party_a.legal_name}}', [{ type: 'bold' }]),
         text(', a {{party_a.entity_type}} organized under the laws of {{party_a.jurisdiction}}, at {{party_a.address}} ("Party A");')),
    para(text('and {{party_b.legal_name}}, at {{party_b.address}} ("Party B").')),
    para(text('Notices to {{party_a.notice_email}} and {{party_b.notice_email}}.')),
  );

  it('finds every one of them', () => {
    const { tokens } = extractVariables(NDA);
    expect(tokens).toEqual([
      'agreement.effective_date', 'party_a.legal_name', 'party_a.entity_type',
      'party_a.jurisdiction', 'party_a.address', 'party_b.legal_name',
      'party_b.address', 'party_a.notice_email', 'party_b.notice_email',
    ]);
  });

  it('types them without anyone choosing', () => {
    const { tokens } = extractVariables(NDA);
    const byToken = Object.fromEntries(tokens.map(t => [t, inferFieldDef(t).type]));
    expect(byToken['agreement.effective_date']).toBe('date');
    expect(byToken['party_a.notice_email']).toBe('email');
    expect(byToken['party_a.address']).toBe('address');
    expect(byToken['party_a.legal_name']).toBe('person');
  });

  it('leaves no raw token behind in the document', () => {
    const { json } = extractVariables(NDA);
    const remaining = [];
    const walk = (n) => {
      if (n?.type === 'text' && /\{\{/.test(n.text)) remaining.push(n.text);
      (n?.content || []).forEach(walk);
    };
    walk(json);
    expect(remaining).toEqual([]);
  });
});
