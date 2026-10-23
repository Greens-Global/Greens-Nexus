import { describe, it, expect } from 'vitest';
import { findSamples, existingTokens, existingBlank, whoOf, whoLabels, setWho, HIRE_TOKENS } from './wordSamples';
import { applyBlanks, tokensFor, findBlanks } from './wordBlanks';

// Automatic variables on upload (Oct 23): a filled-in sample letter becomes a
// template - Nexus finds the sample values, makes the variables and says who
// fills each one; HR can change any of them or turn one back into text.
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...runs) => ({ type: 'paragraph', content: runs.map(r => (typeof r === 'string' ? t(r) : r)) });
const bold = (text) => p(t(text, [{ type: 'bold' }]));

const CTX = { companyLegal: 'Greens Global, LLC', companyName: 'Greens Global', companyAddress: '123 Main St, Fresno, CA 93721',
  companyPhone: '(559) 555-0100', signatoryName: 'Raj Patel', signatoryTitle: 'President', roleNames: ['Accountant', 'Project Manager'] };

const LETTER = { type: 'doc', content: [
  p('Greens Global, LLC'),                                         // 0
  p('123 Main St, Fresno, CA 93721 - (559) 555-0100'),             // 1
  p('10/23/2026'),                                                 // 2
  p('Jane Smith, 45 Oak Avenue, Clovis, CA 93611'),                // 3
  p('Dear Jane Smith,'),                                           // 4
  p('We are pleased to offer you the position of Accountant, starting 11/02/2026, at $85,000 per year.'),   // 5
  p('Jane, please call us back. Your phone on file is (559) 555-2233.'),   // 6
  p('Date of Birth: 04/12/1990'),                                  // 7
  bold('Duties And Responsibilities'),                             // 8
  p('Keep the books.'),                                            // 9
  p('Close the month.'),                                           // 10
  bold('Signatures'),                                              // 11
  p('Employee Signature:'),                                        // 12
] };

const byToken = (list, token) => list.find(b => b.token === token);

describe('findSamples', () => {
  const found = findSamples(LETTER, CTX);

  it('recognizes the sample values and what each one becomes', () => {
    expect(byToken(found, 'full_name')).toMatchObject({ kind: 'text', match: 'Jane Smith', who: 'nexus', became: 'Full Name' });
    expect(byToken(found, 'full_name').places).toHaveLength(2);           // both places it appears
    expect(byToken(found, 'first_name')).toMatchObject({ match: 'Jane' });
    expect(byToken(found, 'first_name').places).toHaveLength(1);          // not the one inside "Jane Smith"
    expect(byToken(found, 'start_date')).toMatchObject({ match: '11/02/2026', became: 'Start Date' });
    expect(byToken(found, 'salary')).toMatchObject({ match: '$85,000 per year', became: 'Pay' });
    expect(byToken(found, 'company_legal')).toMatchObject({ match: 'Greens Global, LLC', became: 'Company Legal Name' });
    expect(byToken(found, 'company_address')).toMatchObject({ match: '123 Main St, Fresno, CA 93721' });
    expect(byToken(found, 'job_title')).toMatchObject({ match: 'Accountant' });
    expect(byToken(found, 'today')).toMatchObject({ match: '10/23/2026' });
  });

  it('puts the new hire\'s own details in the new hire group', () => {
    expect(byToken(found, 'address')).toMatchObject({ who: 'hire', became: 'Home Address' });
    expect(byToken(found, 'address').match).toContain('45 Oak Avenue');
    expect(byToken(found, 'phone')).toMatchObject({ match: '(559) 555-2233', who: 'hire' });
    expect(found.some(b => b.match === '(559) 555-0100')).toBe(false);    // the company's own phone stays text
    const dob = found.find(b => b.label === 'Date Of Birth');
    expect(dob).toMatchObject({ fill: 'ask', who: 'hire', match: '04/12/1990' });
    expect(tokensFor([dob])).toEqual(['date_of_birth']);                // the name People files it under
  });

  it('finds the duties section', () => {
    expect(found.find(b => b.kind === 'section')).toMatchObject({ at: [8, 10], label: 'Duties And Responsibilities' });
  });

  it('leaves a file that already has variables alone', () => {
    const doc = { type: 'doc', content: [p('Dear {{full_name}}, you start on {{ start_date }}.'), p('Notice: {{notice_period}}')] };
    const { doc: json, tokens } = existingTokens(doc);
    expect(tokens).toEqual(['full_name', 'start_date', 'notice_period']);
    expect(JSON.stringify(json)).toContain('"type":"mergeField"');
    expect(JSON.stringify(json)).not.toContain('{{');
    const vars = [{ token: 'full_name', label: 'Full name', source: 'builtin' }, { token: 'start_date', label: 'Start date', source: 'builtin' }];
    const kept = tokens.map(x => existingBlank(x, vars));
    expect(kept.map(whoOf)).toEqual(['nexus', 'nexus', 'you']);         // Notice Period is HR's answer
    expect(tokensFor(kept)).toEqual(['full_name', 'start_date', 'notice_period']);
  });
});

describe('who fills it', () => {
  it('maps the five choices onto the blank fields', () => {
    const b = { kind: 'text', label: 'Home Address', fill: 'nexus', token: 'address', rule: 'address' };
    expect(HIRE_TOKENS.has('address')).toBe(true);
    expect(whoOf(b)).toBe('hire');
    expect(setWho(b, 'you')).toMatchObject({ fill: 'hr' });
    expect(setWho(b, 'same')).toMatchObject({ fill: 'same' });
    expect(setWho(b, 'paper')).toMatchObject({ fill: 'leave' });
    expect(setWho({ ...b, fill: 'hr', token: undefined }, 'hire')).toMatchObject({ fill: 'ask' });
    expect(setWho(b, 'nexus', 'company_address')).toMatchObject({ fill: 'nexus', token: 'company_address', label: 'Company Address' });
  });
});

describe('applyBlanks with samples', () => {
  const found = findSamples(LETTER, CTX);

  it('turns each sample into a variable at every place, and the duties section into the role\'s duties', () => {
    const blanks = found.map(b => (b.kind === 'section' ? { ...b, answer: 'inside' } : b));
    const { doc, fieldDefs } = applyBlanks(LETTER, blanks);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Jane Smith');
    expect(json.match(/"token":"full_name"/g)).toHaveLength(2);
    expect(json).toContain('"token":"first_name"');
    expect(json).toContain('"token":"salary"');
    expect(json).toContain('"token":"company_legal"');
    expect(json).not.toContain('Keep the books');
    expect(json).toContain('"token":"role_description"');
    expect(doc.content[9]).toEqual({ type: 'paragraph', content: [{ type: 'mergeField', attrs: { token: 'role_description' } }] });
    expect(doc.content[10].content[0].text).toBe('Signatures');      // the next heading is kept
    expect(fieldDefs).toEqual([expect.objectContaining({ token: 'date_of_birth', source: 'person', type: 'date' })]);
  });

  it('keeps the section text when the duties go on their own page or nowhere', () => {
    ['page', 'none'].forEach(answer => {
      const { doc } = applyBlanks(LETTER, found.map(b => (b.kind === 'section' ? { ...b, answer } : b)));
      expect(JSON.stringify(doc)).toContain('Keep the books');
    });
  });

  it('Turn Back Into Text leaves the original text', () => {
    const { doc } = applyBlanks(LETTER, found.filter(b => b.token !== 'salary'));
    expect(JSON.stringify(doc)).toContain('$85,000 per year');
  });

  it('a renamed label changes the token; a new hire label uses the canonical token', () => {
    const line = 'Notice: 30 days. PAN: ABCDE1234F';
    const at = (s) => [{ path: [0], start: line.indexOf(s), end: line.indexOf(s) + s.length }];
    const notice = { kind: 'text', match: '30 days', places: at('30 days'), label: 'Notice Period', fill: 'hr', rule: 'label' };
    const renamed = { ...notice, label: 'Notice Window' };
    const pan = { kind: 'text', match: 'ABCDE1234F', places: at('ABCDE1234F'), label: 'PAN', fill: 'ask', rule: 'label' };
    expect(tokensFor([notice, pan])).toEqual(['notice_period', 'pan_number']);
    expect(tokensFor([renamed])).toEqual(['notice_window']);
    const doc = { type: 'doc', content: [p(line)] };
    const out = applyBlanks(doc, [renamed, pan]);
    expect(JSON.stringify(out.doc)).toContain('"token":"notice_window"');
    expect(out.fieldDefs.map(f => [f.token, f.source])).toEqual([['notice_window', 'hr'], ['pan_number', 'person']]);
  });
});

describe('signatures and who signs', () => {
  it('writes the chosen signer onto the block and returns the signer keys', () => {
    const doc = { type: 'doc', content: [p('Employee Signature:'), p('COMPANY'), p('By: ________'), p('Date:')] };
    const blanks = findBlanks(doc).map(b => (b.kind === 'signature' && b.who === 'company' ? { ...b, who: 'signatory' } : b));
    const out = applyBlanks(doc, blanks);
    expect(out.doc.content.map(n => n.attrs?.role)).toEqual(['employee', undefined, 'signatory']);
    expect(out.signers).toEqual(['employee', 'signatory']);
  });
});

// Review findings (Oct 23): claims are text spans, distinct values stay distinct.
describe('findSamples claims spans, not strings', () => {
  const run = (pars, ctx = CTX) => {
    const doc = { type: 'doc', content: pars.map(x => p(x)) };
    const found = findSamples(doc, ctx);
    return { found, text: applyBlanks(doc, found).doc.content.map(n => n.content.map(r => (r.type === 'text' ? r.text : `{{${r.attrs.token}}}`)).join('')) };
  };

  it('the same pay again, a short value inside a later address, a first name inside an email', () => {
    expect(run(['Your salary of $85,000 per year is paid monthly.', 'In total you will earn $85,000 in your first year.']).text)
      .toEqual(['Your salary of {{salary}} is paid monthly.', 'In total you will earn {{salary}} in your first year.']);
    expect(run(['Work Location: Fresno, CA', 'Our office is at 123 Main St, Fresno, CA 93721.']).text)
      .toEqual(['Work Location: {{work_location}}', 'Our office is at {{company_address}}.']);
    expect(run(['Dear Jane Smith,', 'Write to jane.smith@gmail.com.', 'Jane, welcome.']).text)
      .toEqual(['Dear {{full_name}},', 'Write to {{email}}.', '{{first_name}}, welcome.']);
  });

  it('a bonus, another role and two plain dates are their own variables', () => {
    const { found, text } = run(['Your salary is $85,000 per year and a signing bonus of $5,000.',
      'You will report to the Project Manager.', 'Your review is on 01/15/2027 and benefits begin 03/01/2027.']);
    expect(text[0]).toBe('Your salary is {{salary}} and a signing bonus of {{signing_bonus}}.');
    expect(found.find(b => b.match === '$5,000')).toMatchObject({ fill: 'hr', label: 'Signing Bonus', pay: true, who: 'you' });
    expect(text[1]).toBe('You will report to the Project Manager.');
    expect(text[2]).toBe('Your review is on {{review_date}} and benefits begin {{benefits_begin_date}}.');
  });

  it('a known role name is taken from the title phrase only', () => {
    expect(run(['We offer you the position of Project Manager At Greens.']).text).toEqual(['We offer you the position of {{job_title}} At Greens.']);
  });
});

describe('review choices on a sample', () => {
  const found = findSamples(LETTER, CTX);
  const name = byToken(found, 'full_name');

  it('Leave Blank For Paper prints a line, not the sample', () => {
    const { doc } = applyBlanks(LETTER, found.map(b => (b === name ? setWho(b, 'paper') : b)));
    expect(JSON.stringify(doc)).not.toContain('Jane Smith');
    expect(doc.content[4].content.map(r => r.text).join('')).toBe('Dear ________,');
  });

  it('Same Every Time starts from the found text; Nexus keeps a new hire built-in', () => {
    expect(setWho(name, 'same')).toMatchObject({ fill: 'same', value: 'Jane Smith' });
    expect(setWho(byToken(found, 'phone'), 'nexus')).toMatchObject({ fill: 'nexus', token: 'phone', label: 'Phone' });
  });
});

// Round 2 (P6/P7): promotion letters and separation documents have their own rules and words.
describe('findSamples on a promotion letter', () => {
  const PROMO = { type: 'doc', content: [
    p('Dear Jane Smith,'),                                                                                    // 0
    p('We are pleased to confirm your promotion, effective November 2, 2026, from the position of Accountant to Senior Accountant.'),   // 1
    p('Your new salary will be $95,000 per year.'),                                                          // 2
    bold('Responsibilities'),                                                                                 // 3
    p('Lead the monthly close.'),                                                                             // 4
    p('Employee Signature:'),                                                                                 // 5
  ] };
  const found = findSamples(PROMO, CTX, 'promotion');

  it('finds the name, effective date, old and new title, pay and the duties section', () => {
    expect(byToken(found, 'full_name')).toMatchObject({ match: 'Jane Smith' });
    expect(byToken(found, 'effective_date')).toMatchObject({ match: 'November 2, 2026', who: 'nexus' });
    expect(byToken(found, 'old_title')).toMatchObject({ match: 'Accountant' });
    expect(byToken(found, 'new_title')).toMatchObject({ match: 'Senior Accountant' });
    expect(byToken(found, 'salary')).toMatchObject({ match: '$95,000 per year' });
    expect(byToken(found, 'start_date')).toBeUndefined();
    expect(byToken(found, 'job_title')).toBeUndefined();
    expect(found.find(b => b.kind === 'section')).toMatchObject({ at: [3, 4], label: 'Responsibilities' });
    const text = applyBlanks(PROMO, found).doc.content[1].content.map(r => (r.type === 'text' ? r.text : `{{${r.attrs.token}}}`)).join('');
    expect(text).toBe('We are pleased to confirm your promotion, effective {{effective_date}}, from the position of {{old_title}} to {{new_title}}.');
  });

  it('"from A to B" pay: A is HR\'s current pay, B the new pay', () => {
    const doc = { type: 'doc', content: [p('Your pay changes from $80,000 per year to $95,000 per year.')] };
    const f = findSamples(doc, CTX, 'promotion');
    expect(f.find(b => b.match === '$80,000 per year')).toMatchObject({ fill: 'hr', label: 'Current Pay', pay: true, who: 'you' });
    expect(byToken(f, 'salary')).toMatchObject({ match: '$95,000 per year' });
  });

  it('the new hire built-ins are Nexus\'s on a promotion, and the words are the employee\'s', () => {
    expect(whoOf({ fill: 'nexus', token: 'phone' }, 'promotion')).toBe('nexus');
    expect(whoOf({ fill: 'nexus', token: 'phone' })).toBe('hire');
    expect(whoLabels('promotion').map(([, l]) => l)).toEqual(['Nexus Fills It', 'You Answer On The Promotion', 'The Employee Fills It', 'Same Every Time', 'Leave Blank For Paper']);
    expect(whoLabels('separation')[1][1]).toBe('You Answer When Offboarding');
    expect(whoLabels('hire')[2][1]).toBe('The New Hire Fills It');
  });

  it('with a single signature line a manager countersigns', () => {
    const blanks = findBlanks(PROMO, { purpose: 'promotion' });
    const out = applyBlanks(PROMO, blanks, { countersign: 'manager' });
    expect(out.doc.content[out.doc.content.length - 1]).toMatchObject({ type: 'signatureBlock', attrs: { role: 'manager' } });
    expect(['employee', ...out.signers.filter(k => k !== 'employee')]).toEqual(['employee', 'manager']);
    // a company line already chosen: nothing added
    const two = { type: 'doc', content: [p('Employee Signature:'), p('COMPANY'), p('By: ________')] };
    const withCo = applyBlanks(two, findBlanks(two).map(b => (b.who === 'company' ? { ...b, who: 'signatory' } : b)), { countersign: 'manager' });
    expect(withCo.signers).toEqual(['employee', 'signatory']);
  });
});

describe('findSamples on a separation letter', () => {
  const SEP = { type: 'doc', content: [
    p('Dear Jane Smith,'),                                                                                    // 0
    p('This confirms your Voluntary Resignation. Your last day of work will be 11/15/2026.'),                // 1
    p('Your final paycheck will be issued on 11/20/2026.'),                                                  // 2
    p('Please forward any mail to 45 Oak Avenue, Clovis, CA 93611, or write to jane.smith@gmail.com.'),     // 3
    p('Questions? Email hr@greensglobal.com.'),                                                               // 4
    bold('Duties And Responsibilities'),                                                                      // 5
    p('Return your laptop.'),                                                                                 // 6
    p('Employee Signature:'),                                                                                 // 7
  ] };
  const found = findSamples(SEP, CTX, 'separation');

  it('finds the last day, the reason and HR\'s final pay date', () => {
    expect(byToken(found, 'last_day')).toMatchObject({ match: '11/15/2026', who: 'nexus' });
    expect(byToken(found, 'separation_type')).toMatchObject({ match: 'Voluntary Resignation', became: 'Why They Are Leaving' });
    const fp = found.find(b => b.match === '11/20/2026');
    expect(fp).toMatchObject({ fill: 'hr', label: 'Final Pay Date', who: 'you' });
    expect(tokensFor([fp])).toEqual(['final_pay_date']);
    expect(byToken(found, 'start_date')).toBeUndefined();
  });

  it('the forwarding address and personal email are the employee\'s, filed to their record', () => {
    const addr = found.find(b => b.label === 'Forwarding Address');
    const mail = found.find(b => b.label === 'Forwarding Email');
    expect(addr).toMatchObject({ fill: 'ask', who: 'hire', match: '45 Oak Avenue, Clovis, CA 93611' });
    expect(mail).toMatchObject({ fill: 'ask', who: 'hire', match: 'jane.smith@gmail.com' });
    expect(found.some(b => b.match === 'hr@greensglobal.com')).toBe(false);     // the company's own email stays text
    const { fieldDefs } = applyBlanks(SEP, found);
    expect(fieldDefs.filter(f => f.source === 'person').map(f => f.token)).toEqual(['forwarding_address', 'forwarding_email']);
    expect(fieldDefs.find(f => f.token === 'final_pay_date')).toMatchObject({ source: 'hr', pay: false });
  });

  it('has no duties section', () => {
    expect(found.some(b => b.kind === 'section')).toBe(false);
  });

  it('a single-word reason counts only as the whole value', () => {
    const f = findSamples({ type: 'doc', content: [p('Upon termination of employment, return all keys.'), p('Reason: Termination')] }, CTX, 'separation');
    expect(byToken(f, 'separation_type').places).toHaveLength(1);
  });
});

describe('findSamples - round 2 review fixes', () => {
  it('a separation keeps the company email as text even when its name is longer than the domain', () => {
    const doc = { type: 'doc', content: [p('Questions? Email hr@greensglobal.com.'), p('Please forward mail to jane@gmail.com.')] };
    const f = findSamples(doc, { ...CTX, companyLegal: 'Greens Global Construction LLC', companyName: 'Greens Global Construction' }, 'separation');
    expect(f.some(b => b.match === 'hr@greensglobal.com')).toBe(false);
    expect(f.find(b => b.label === 'Forwarding Email')).toMatchObject({ match: 'jane@gmail.com' });
  });

  it('with no company name only an email after a forwarding lead-in is the employee one', () => {
    const doc = { type: 'doc', content: [p('Questions? Email hr@acme.com.'), p('Your personal email on file is jane@gmail.com.')] };
    const f = findSamples(doc, { roleNames: [] }, 'separation');
    expect(f.some(b => b.match === 'hr@acme.com')).toBe(false);
    expect(f.find(b => b.label === 'Forwarding Email')).toMatchObject({ match: 'jane@gmail.com' });
  });

  it('"from Monday to Friday" is not a title change, and a return address is not a forwarding address', () => {
    const promo = findSamples({ type: 'doc', content: [p('Your schedule remains from Monday to Friday.')] }, CTX, 'promotion');
    expect(byToken(promo, 'old_title')).toBeUndefined();
    expect(byToken(promo, 'new_title')).toBeUndefined();
    const sep = findSamples({ type: 'doc', content: [p('Dear Jane,'), p('Hello.'), p('Thanks.'), p('Please send all company property to 100 Pine Ave, Fresno, CA 93721.')] }, CTX, 'separation');
    expect(sep.some(b => b.label === 'Forwarding Address')).toBe(false);
  });
});
