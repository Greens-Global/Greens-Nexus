import { describe, it, expect } from 'vitest';
import { applyMask, formatCount, formatPlaceholder, formatInputMode, FORMAT_KEYS } from './fieldFormats';

// Federal forms in Nexus Sign (Neil, 11/02/2026): a text field may carry a
// `format` - the box masks as the signer types, and the server's formats.check
// has the last word. The keys here are the server's keys, nothing more.

describe('fieldFormats', () => {
  it('lists exactly the server formats', () => {
    expect(FORMAT_KEYS).toEqual(['ssn', 'routing', 'account', 'ein', 'zip', 'date_mmddyyyy', 'date_or_na', 'alien_number', 'i94', 'passport', 'money', 'percent']);
  });
  it('masks an SSN as ###-##-#### while typing and never past nine digits', () => {
    expect(applyMask('ssn', '1')).toBe('1');
    expect(applyMask('ssn', '123')).toBe('123');
    expect(applyMask('ssn', '1234')).toBe('123-4');
    expect(applyMask('ssn', '123456789')).toBe('123-45-6789');
    expect(applyMask('ssn', '123-45-6789x0')).toBe('123-45-6789');
    expect(applyMask('ein', '123456789')).toBe('12-3456789');
  });
  it('keeps routing and account numbers to digits with a live count', () => {
    expect(applyMask('routing', '12a3 456')).toBe('123456');
    expect(applyMask('routing', '1234567890')).toBe('123456789');
    expect(formatCount('routing', '1234567')).toBe('7 of 9 digits');
    expect(formatCount('routing', '123456789')).toBe('');
    expect(applyMask('account', '123456789012345678')).toBe('12345678901234567');
    expect(formatCount('account', '12')).toBe('2 digits - 4 to 17');
    expect(formatCount('account', '1234')).toBe('');
    expect(formatCount('ssn', '12')).toBe('');
  });
  it('masks dates as MM/DD/YYYY, a ZIP as 5 or 9 digits, and an A-Number with its letter', () => {
    expect(applyMask('date_mmddyyyy', '11022026')).toBe('11/02/2026');
    expect(applyMask('date_or_na', 'n/a')).toBe('N/A');
    expect(applyMask('date_or_na', '1102')).toBe('11/02');
    expect(applyMask('zip', '92101')).toBe('92101');
    expect(applyMask('zip', '921011234')).toBe('92101-1234');
    expect(applyMask('alien_number', '12345678')).toBe('A12345678');
    expect(applyMask('alien_number', 'a-123')).toBe('A123');
    expect(applyMask('i94', 'ab 12-cd')).toBe('AB12CD');
    expect(applyMask('passport', 'x1234567 ')).toBe('X1234567');
  });
  it('keeps money to two decimals and a percent to 100', () => {
    expect(applyMask('money', '$1,234.567')).toBe('1234.56');
    expect(applyMask('money', '12.')).toBe('12.');
    expect(applyMask('percent', '150')).toBe('100');
    expect(applyMask('percent', '12.5')).toBe('12.5');
  });
  it('leaves an unknown format alone', () => {
    expect(applyMask('', ' free text ')).toBe(' free text ');
    expect(applyMask('nope', 'abc')).toBe('abc');
    expect(formatCount('', 'abc')).toBe('');
  });
  it('names the placeholder and the keyboard', () => {
    expect(formatPlaceholder('ssn')).toBe('###-##-####');
    expect(formatPlaceholder('date_mmddyyyy')).toBe('MM/DD/YYYY');
    expect(formatPlaceholder('date_or_na')).toBe('MM/DD/YYYY or N/A');
    expect(formatInputMode('routing')).toBe('numeric');
    expect(formatInputMode('money')).toBe('decimal');
    expect(formatInputMode('passport')).toBe('text');
    expect(formatPlaceholder('')).toBe('');
  });
});
