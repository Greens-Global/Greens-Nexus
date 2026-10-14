// The signing order the packet editor proposes as documents are added
// (HR packets built from Documents, Oct 14).
//     npx vitest run src/lib/packetFlow.test.js
import { describe, expect, it } from 'vitest';
import { defaultRoleFor, flowFor } from './packetFlow';

describe('defaultRoleFor', () => {
  it('maps the usual signer keys to roles', () => {
    expect(defaultRoleFor('employee')).toBe('employee');
    expect(defaultRoleFor('company')).toBe('hr');
    expect(defaultRoleFor('company', true)).toBe('signatory');   // the template prints {{signatory}}
    expect(defaultRoleFor('supervisor')).toBe('manager');
    expect(defaultRoleFor('payroll')).toBe('payroll');
    expect(defaultRoleFor('witness')).toBe('hr');
  });
});

describe('flowFor', () => {
  const offer = { id: 't1', signs: ['company', 'employee'] };
  const nda = { id: 't2', signs: ['employee'] };

  it('adds a step for every signer the documents name, the person last', () => {
    expect(flowFor([], [offer, nda], 'hire')).toEqual([
      { key: 'company', role: 'hr', action: 'sign' },
      { key: 'employee', role: 'employee', action: 'sign' },
    ]);
  });

  it('keeps what HR already chose and only adds what is new', () => {
    const chosen = [{ key: 'employee', role: 'employee', action: 'sign' }];
    const out = flowFor(chosen, [offer], 'separation');
    expect(out.map(s => s.key)).toEqual(['company', 'employee']);
  });

  it('leaves a promotion letter in the order HR set', () => {
    const chosen = [{ key: 'employee', role: 'employee', action: 'sign' }];
    expect(flowFor(chosen, [{ id: 'p', signs: ['employee', 'manager'] }], 'promotion').map(s => s.key))
      .toEqual(['employee', 'manager']);
  });
});
