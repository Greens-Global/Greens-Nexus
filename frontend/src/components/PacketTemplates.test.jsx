// Packet template rules: what blocks a save and how a document's fields read.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./ESign', () => ({ AttachmentPlacer: () => null, MERGE_FIELDS: [['salary', 'Salary'], ['start_date', 'Start Date']] }));
const { templateProblems, describeFields } = await import('./PacketTemplates');

const sign = (role) => ({ id: `s-${role}`, type: 'sign', role });
const salary = { id: 'm1', type: 'merge', merge: 'salary' };

describe('templateProblems', () => {
  it('needs a name, a signer and something to sign', () => {
    expect(templateProblems({ name: '', roles: [], attachments: [], bodyText: '' })).toEqual([
      'Give the template a name.', 'Add at least one signer.', 'Upload a PDF or type the letter - the packet is empty.',
    ]);
  });
  it('tells which signer has nowhere to sign', () => {
    const t = { name: 'Hiring Packet', roles: [{ key: 'company', label: 'Company' }, { key: 'employee', label: 'Employee' }],
      attachments: [{ path: 'p', fields: [sign('company'), salary] }], bodyText: '' };
    expect(templateProblems(t)).toEqual(['Employee has nowhere to sign - place a Signature box for them on a document, or put [[sign:employee]] in the letter.']);
    expect(templateProblems({ ...t, bodyText: 'Dear {{first_name}}\n\n[[sign:employee]]' })).toEqual([]);
  });
});

describe('describeFields', () => {
  it('reads the signatures and offer fields on a document', () => {
    expect(describeFields([sign('company'), sign('employee'), salary, { id: 't', type: 'text', role: 'employee' }])).toBe('2 signatures · Salary · 1 other field');
    expect(describeFields([])).toBe('No fields placed yet');
  });
});
