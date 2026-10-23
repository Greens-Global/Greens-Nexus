import { describe, it, expect } from 'vitest';
import { findBlanks, applyBlanks, findText, guessFill, splitPages, tokensFor } from './wordBlanks';

// The shapes a Word file comes in as (lib/docxToTiptap.js): label + empty
// cell tables, "Label:" lines, [   ] brackets, "Rs.     per month" gaps and
// signature lines with Date / Name lines under them.
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...runs) => ({ type: 'paragraph', content: runs.map(r => (typeof r === 'string' ? t(r) : r)) });
const cell = (text) => ({ type: 'tableCell', content: [text ? p(text) : { type: 'paragraph' }] });
const row = (...cells) => ({ type: 'tableRow', content: cells.map(cell) });
const table = (...rows) => ({ type: 'table', content: rows });

const DOC = {
  type: 'doc',
  content: [
    p('Contractor Onboarding'),
    table(row('Contractor Name', '', 'Company Name', ''), row('PAN Number', '', 'Date of Engagement', '')),
    table(row('Alternate Contact Name', '', 'Relationship', ''), row('Telephone Number', '', 'Email Address', '')),
    table(row('Type of Account:', '☐ Savings Account   ☐ Current Account')),
    p('Documents Required:'),
    { type: 'orderedList', content: [{ type: 'listItem', content: [p('PAN Card (copy)')] }] },
    p('Effective Date:    '),
    p('Contractual Monthly Payment  Rs.', '                ', 'per month.'),
    p('"Protected Group" means Company, [', '          ', '], and each of their affiliates.'),
    { type: 'pageBreak' },
    p('COMPANY:'),
    p('Signature:                 Date:'),
    p('Name:  '),
    p('Title:  '),
    p('CONTRACTOR'),
    p('By signing below, Contractor confirms the terms.'),
    p('Signature:                Date:'),
    p('Full Legal Name: '),
    p('Notary Name: '),
    p('Optional Witness Signature: '),
    p('12.5 Electronic Signatures, Stamp Paper, and Notarization'),
  ],
};

const by = (blanks, label) => blanks.find(b => b.label === label);

describe('findBlanks', () => {
  const blanks = findBlanks(DOC);

  it('finds the table blanks and guesses what fills them', () => {
    expect(by(blanks, 'Contractor Name')).toMatchObject({ kind: 'cell', fill: 'nexus', token: 'full_name' });
    expect(by(blanks, 'Company Name')).toMatchObject({ fill: 'nexus', token: 'company_legal' });
    expect(by(blanks, 'PAN Number')).toMatchObject({ fill: 'ask' });
    expect(by(blanks, 'Date of Engagement')).toMatchObject({ fill: 'nexus', token: 'start_date' });
    // the emergency contact table
    expect(by(blanks, 'Alternate Contact Name')).toMatchObject({ token: 'emergency_name' });
    expect(by(blanks, 'Relationship')).toMatchObject({ token: 'emergency_relationship' });
    expect(by(blanks, 'Telephone Number')).toMatchObject({ token: 'emergency_phone' });
    expect(by(blanks, 'Email Address')).toMatchObject({ fill: 'ask' });
    // tick boxes become a choice
    expect(by(blanks, 'Type of Account')).toMatchObject({ fill: 'ask', options: ['Savings Account', 'Current Account'] });
  });

  it('finds lines, gaps and brackets - and not list lead-ins or headings', () => {
    expect(by(blanks, 'Effective Date')).toMatchObject({ kind: 'line', token: 'start_date' });
    expect(blanks.find(b => b.kind === 'gap')).toMatchObject({ fill: 'nexus', token: 'salary' });
    expect(blanks.find(b => b.kind === 'bracket')).toMatchObject({ fill: 'same' });
    expect(by(blanks, 'Documents Required')).toBeUndefined();
    expect(blanks.some(b => /12\.5/.test(b.label))).toBe(false);
    expect(by(blanks, 'COMPANY')).toBeUndefined();
    expect(by(blanks, 'Notary Name')).toMatchObject({ fill: 'leave' });
    expect(by(blanks, 'Optional Witness Signature')).toMatchObject({ kind: 'line', fill: 'leave' });
  });

  it('turns signature lines into signature spots for the right signer', () => {
    const sigs = blanks.filter(b => b.kind === 'signature');
    expect(sigs.map(s => s.who)).toEqual(['company', 'employee']);
    expect(sigs[0].absorb).toHaveLength(1);                    // the "Name:" line under it
    expect(by(blanks, 'Name')).toBeUndefined();
    expect(by(blanks, 'Title')).toMatchObject({ token: 'signer.company.title' });
  });
});

describe('applyBlanks', () => {
  it('writes variables and signature blocks, one variable per label', () => {
    const blanks = findBlanks(DOC).map(b => (b.kind === 'bracket' ? { ...b, value: 'Greens Global LLC' } : b));
    const { doc, fieldDefs, signers } = applyBlanks(DOC, blanks);
    const json = JSON.stringify(doc);
    for (const tok of ['full_name', 'company_legal', 'pan_number', 'start_date', 'salary', 'emergency_phone']) {
      expect(json).toContain(`"token":"${tok}"`);
    }
    expect(json).not.toContain('Rs.  ');                       // the gap is gone
    expect(json).toContain('"type":"signatureBlock"');
    expect(json).not.toContain('Name:  ');                      // absorbed into the block
    expect(signers.sort()).toEqual(['company', 'employee']);
    const client = fieldDefs.find(f => f.default === 'Greens Global LLC');
    expect(client).toBeTruthy();
    expect(fieldDefs.find(f => f.token === 'type_of_account')).toMatchObject({ type: 'dropdown', options: ['Savings Account', 'Current Account'] });
    // the original is untouched
    expect(JSON.stringify(DOC)).not.toContain('mergeField');
  });

  it('never names a custom variable after a built-in one', () => {
    expect(tokensFor([{ fill: 'ask', label: 'Salary' }, { fill: 'ask', label: 'Phone' }])).toEqual(['salary_value', 'phone_value']);
  });

  it('never names an asked blank email or work_email (the server fills those itself)', () => {
    expect(tokensFor([{ fill: 'ask', label: 'Email' }, { fill: 'ask', label: 'Work Email' }])).toEqual(['email_value', 'work_email_value']);
  });

  it('splits pages at Word page breaks', () => {
    const pages = splitPages(DOC);
    expect(pages).toHaveLength(2);
    expect(pages[1].json.content[0].content[0].text).toBe('COMPANY:');
  });

  it('fills the bare lines under a company signature with its title and company', () => {
    const doc = { type: 'doc', content: [p('COMPANY:'), p('By:'), p('Name: [          ]'), p('[          ]'), p('[          ]'), p('Date:')] };
    const blanks = findBlanks(doc);
    expect(blanks.map(b => [b.kind, b.label, b.token || b.fill])).toEqual([
      ['signature', 'Company', 'sign'], ['bracket', 'Signer Title', 'signer.company.title'], ['bracket', 'Company Name', 'company_legal']]);
    expect(blanks[0].absorb).toHaveLength(2);                      // Name: and Date:
  });

  it('names a variable without the notes in brackets', () => {
    expect(tokensFor([{ fill: 'ask', label: "Driver's Licence No. (if applicable)" }, { fill: 'ask', label: 'UPI ID (optional)' }]))
      .toEqual(['drivers_licence_no', 'upi_id']);
  });

  it('turns text HR picks into a variable - only in the places ticked, even across Word runs', () => {
    const doc = { type: 'doc', content: [
      p('Fully remote position based in Hyde', 'rabad, India.'),
      table(row('Location', 'Hyderabad office')),
      p('Travel to Hyderabad is not required.'),
    ] };
    const places = findText(doc, 'hyderabad');
    expect(places).toHaveLength(3);
    expect(places[1].context).toContain('Hyderabad office');
    const blank = { kind: 'text', match: 'Hyderabad', places: [places[0], places[1]], label: 'Office City', fill: 'same', value: 'Hyderabad' };
    const { doc: out, fieldDefs } = applyBlanks(doc, [blank]);
    const json = JSON.stringify(out);
    expect(json.match(/"token":"office_city"/g)).toHaveLength(2);
    expect(json).toContain('Travel to Hyderabad is not required.');      // the unticked place stays
    expect(json).not.toContain('Hyde"');                                  // the split run was replaced whole
    expect(fieldDefs).toEqual([expect.objectContaining({ token: 'office_city', default: 'Hyderabad' })]);
    expect(findText(doc, 'x')).toEqual([]);                               // too short to search
  });

  it('says who fills each variable - the person (private when it is an ID) or HR on the offer', () => {
    const doc = { type: 'doc', content: [p('PAN Number:   '), p('Bank Name:   '), p('Probation Period:   '), p('Joining Bonus:   '), p('Work Location:   ')] };
    const blanks = findBlanks(doc);
    expect(by(blanks, 'Probation Period')).toMatchObject({ fill: 'hr' });
    expect(by(blanks, 'Work Location')).toMatchObject({ fill: 'nexus', token: 'work_location' });
    const { fieldDefs } = applyBlanks(doc, blanks);
    const def = (t) => fieldDefs.find(f => f.token === t);
    expect(def('pan_number')).toMatchObject({ source: 'person', sensitive: true });
    expect(def('bank_name')).toMatchObject({ source: 'person', sensitive: false });
    expect(def('probation_period')).toMatchObject({ source: 'hr', pay: false });
    expect(def('joining_bonus')).toMatchObject({ source: 'hr', pay: true });
    // HR's own choice wins over the guess
    const changed = blanks.map(b => (b.label === 'Bank Name' ? { ...b, private: true } : b));
    expect(applyBlanks(doc, changed).fieldDefs.find(f => f.token === 'bank_name').sensitive).toBe(true);
  });

  it('guesses by label', () => {
    expect(guessFill('Personal Email Address')).toMatchObject({ token: 'personal_email' });
    expect(guessFill('Bank Account Number').fill).toBe('ask');
    expect(guessFill('Client(s) Name').fill).toBe('same');
    expect(guessFill('Notary Seal / Stamp').fill).toBe('leave');
  });
});
