// Variable names, the editor's half (requirement 5.1).
//
// The dotted taxonomy is the thing that keeps a library of 15-60 templates
// legible: `principal.amount`, `agreement.date`, `place.execution` rather than
// `amount2`/`amt_final`. Before this, both ends of the product forbade the
// dot - the backend dropped any override key that was not [a-z0-9_]+, and the
// template editor rewrote the dot to an underscore as you typed - so the
// convention the requirements are built on was literally unusable.
//
// This file is the client mirror of test_document_module_requirements.py's
// VariableTaxonomyTests; the two must agree, or a name the editor accepts is
// silently dropped when the document is generated.
//
//     npx vitest run src/lib/variableTaxonomy.test.js
import { describe, expect, it } from 'vitest';
import { isValidToken, slugifyToken, tokenGroup, variableFromDrop, VARIABLE_DRAG_TYPE } from './mergeFieldTypes';

describe('a variable name follows the taxonomy', () => {
  it('accepts the dotted names the requirements use', () => {
    for (const token of ['principal.amount', 'agreement.date', 'place.execution',
                         'borrower.name', 'lender.name']) {
      expect(isValidToken(token), token).toBe(true);
    }
  });

  it('still accepts the undotted built-ins', () => {
    // Renaming these would break every template already in the library.
    for (const token of ['full_name', 'company_legal', 'today', 'start_date']) {
      expect(isValidToken(token), token).toBe(true);
    }
  });

  it('rejects a name that is not a name', () => {
    for (const token of ['', '   ', 'Principal.Amount', 'principal amount',
                         'principal..amount', '.amount', 'amount.', 'principal-amount',
                         '{{principal.amount}}', 'a'.repeat(81)]) {
      expect(isValidToken(token), JSON.stringify(token)).toBe(false);
    }
  });

  it('groups by the part before the dot', () => {
    expect(tokenGroup('principal.amount')).toBe('principal');
    expect(tokenGroup('agreement.date')).toBe('agreement');
    expect(tokenGroup('full_name')).toBe('general');
  });
});

describe('turning what someone typed into a variable name', () => {
  it('keeps a dot the author meant as taxonomy', () => {
    expect(slugifyToken('principal.amount')).toBe('principal.amount');
    expect(slugifyToken('Principal.Amount')).toBe('principal.amount');
  });

  it('turns a label into a usable name', () => {
    expect(slugifyToken('Principal Amount')).toBe('principal_amount');
    expect(slugifyToken('Place of Execution')).toBe('place_of_execution');
  });

  it('never produces a name its own validator would reject', () => {
    for (const label of ['Principal Amount.', '.leading', 'double..dot', 'trailing_',
                         'Borrower / Lender', '   ', '!!!', 'a'.repeat(200)]) {
      const token = slugifyToken(label);
      expect(isValidToken(token), `${JSON.stringify(label)} -> ${token}`).toBe(true);
    }
  });

  it('falls back to something rather than an empty name', () => {
    expect(slugifyToken('')).toBe('field');
    expect(slugifyToken('!!!')).toBe('field');
  });
});

describe('dragging a variable out of the library', () => {
  const dropWith = (type, value) => ({ dataTransfer: { getData: (t) => (t === type ? value : '') } });

  it('reads the token the library put on the drag', () => {
    expect(variableFromDrop(dropWith(VARIABLE_DRAG_TYPE, 'principal.amount'))).toBe('principal.amount');
  });

  it('ignores a drag that is not one of ours', () => {
    // A file, or text from another app, must fall through to the editor's own
    // drop handling rather than being read as a variable.
    expect(variableFromDrop(dropWith('text/plain', 'hello'))).toBe('');
    expect(variableFromDrop({})).toBe('');
    expect(variableFromDrop({ dataTransfer: { getData: () => { throw new Error('denied'); } } })).toBe('');
  });
});
