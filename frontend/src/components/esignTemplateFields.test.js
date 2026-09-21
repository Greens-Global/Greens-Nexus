import { describe, it, expect, vi } from 'vitest';

vi.mock('../api', () => ({ api: {} }));
const { templateAskFields } = await import('./ESign');

// Picking a template in Nexus Sign must ask for the template's variables -
// including {{tokens}} that have no typed definition (hand-written, pasted, or
// imported from Word), which used to go out unfilled: "Dear {{full_name}}".

describe('templateAskFields', () => {
  it('asks for declared fields first, then undeclared tokens', () => {
    const t = {
      fieldDefs: [{ token: 'salary', label: 'Annual Salary', type: 'currency' }],
      tokens: ['full_name', 'salary', 'start_date'],
    };
    expect(templateAskFields(t).map(f => f.token)).toEqual(['salary', 'full_name', 'start_date']);
  });

  it('labels an undeclared token readably and treats it as text', () => {
    const [f] = templateAskFields({ tokens: ['principal.amount'] });
    expect(f).toEqual({ token: 'principal.amount', label: 'Principal Amount', type: 'text' });
    expect(templateAskFields({ tokens: ['company_address'] })[0].label).toBe('Company Address');
  });

  it('never asks for a field that is placed on the document', () => {
    const t = { fieldDefs: [
      { token: 'sig', label: 'Signature', type: 'signature' },
      { token: 'photo', label: 'Photo', type: 'image' },
      { token: 'note', label: 'Note', type: 'text' },
    ] };
    expect(templateAskFields(t).map(f => f.token)).toEqual(['note']);
  });

  it('is empty for a template with no variables at all', () => {
    expect(templateAskFields({ fieldDefs: [], tokens: [] })).toEqual([]);
    expect(templateAskFields(undefined)).toEqual([]);
  });
});
