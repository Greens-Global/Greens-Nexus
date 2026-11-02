// Text field formats for Nexus Sign (Neil, 11/02/2026, federal forms). A
// field definition may carry `format` - one of the server's keys in
// backend/federal_forms/formats.py - and the signer's box masks what is
// typed to that shape: an SSN as ###-##-####, a routing number as nine
// digits with a live count, a date as MM/DD/YYYY. The mask is a courtesy;
// the server's formats.check has the last word and answers 422 with the
// field and a sentence, which the signing screen shows under the box.
// Nothing here decides validity - only what the box lets through.

const DIGIT_MASKS = {
  ssn: '###-##-####',
  ein: '##-#######',
  zip: '#####-####',
  date_mmddyyyy: '##/##/####',
  date_or_na: '##/##/####',
};

const SPEC = {
  ssn:           { placeholder: '###-##-####', inputMode: 'numeric' },
  routing:       { placeholder: '9 digits', inputMode: 'numeric', digits: [9, 9] },
  account:       { placeholder: '4 to 17 digits', inputMode: 'numeric', digits: [4, 17] },
  ein:           { placeholder: '##-#######', inputMode: 'numeric' },
  zip:           { placeholder: 'ZIP', inputMode: 'numeric' },
  date_mmddyyyy: { placeholder: 'MM/DD/YYYY', inputMode: 'numeric' },
  date_or_na:    { placeholder: 'MM/DD/YYYY or N/A', inputMode: 'text' },
  alien_number:  { placeholder: 'A-Number', inputMode: 'text' },
  i94:           { placeholder: 'I-94 number', inputMode: 'text' },
  passport:      { placeholder: 'Passport number', inputMode: 'text' },
  money:         { placeholder: '0.00', inputMode: 'decimal' },
  percent:       { placeholder: '%', inputMode: 'decimal' },
};

export const FORMAT_KEYS = Object.keys(SPEC);

const digitsOf = (raw) => String(raw ?? '').replace(/\D/g, '');

// Fill a '#' pattern from the digits typed; a separator is written only when
// a digit follows it, so "123" stays "123" and "1234" becomes "123-4".
function fillMask(pattern, raw) {
  const digits = digitsOf(raw);
  let out = '';
  let i = 0;
  for (const ch of pattern) {
    if (i >= digits.length) break;
    if (ch === '#') { out += digits[i]; i += 1; } else out += ch;
  }
  return out;
}

/** What the box shows after a keystroke, for a field with `format`. An
 *  unknown or empty format returns the raw text unchanged. */
export function applyMask(format, raw) {
  const text = String(raw ?? '');
  if (!format || !SPEC[format]) return text;
  if (format === 'date_or_na' && /^n\/?a?$/i.test(text.trim()) && /[a-z]/i.test(text)) return 'N/A';
  if (DIGIT_MASKS[format]) return fillMask(DIGIT_MASKS[format], text);
  if (format === 'routing' || format === 'account') return digitsOf(text).slice(0, SPEC[format].digits[1]);
  if (format === 'alien_number') {
    const d = digitsOf(text).slice(0, 9);
    return d ? `A${d}` : (/^a/i.test(text.trim()) ? 'A' : '');
  }
  if (format === 'i94') return text.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 11);
  if (format === 'passport') return text.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 20);
  if (format === 'money' || format === 'percent') {
    const cleaned = text.replace(/[^0-9.]/g, '');
    const [whole, ...rest] = cleaned.split('.');
    let out = whole.replace(/^0+(?=\d)/, '');
    if (rest.length) out += `.${rest.join('').slice(0, 2)}`;
    if (format === 'percent' && Number(out) > 100) return '100';
    return out;
  }
  return text;
}

/** The live count under a routing or account box while it is incomplete:
 *  "7 of 9 digits", "2 digits - 4 to 17". '' once it fits, or for formats
 *  the mask itself makes obvious. */
export function formatCount(format, value) {
  const spec = SPEC[format];
  if (!spec?.digits) return '';
  const n = digitsOf(value).length;
  const [min, max] = spec.digits;
  if (n >= min && n <= max) return '';
  if (min === max) return `${n} of ${max} digits`;
  return `${n} digit${n === 1 ? '' : 's'} - ${min} to ${max}`;
}

export const formatPlaceholder = (format) => SPEC[format]?.placeholder || '';
export const formatInputMode = (format) => SPEC[format]?.inputMode || '';
