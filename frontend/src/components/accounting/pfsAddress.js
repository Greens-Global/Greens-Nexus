// PFS borrower addresses and the co-borrower's name (Charmi + Neil, Oct 7).
//
// City, State and ZIP are three fields on the Borrower and the Co-Borrower
// blocks (`city`, `state`, `zip` in the profile's details JSON). Statements
// saved before Oct 7 carry one combined `city_state_zip` text; it is split on
// read, best effort ("Sacramento, CA 95814"), and whatever cannot be split is
// kept whole as the city so nothing is lost. The old separate "Spouse or
// Co-Borrower" name (`spouse`) is the co-borrower's name now: one source of
// truth. The server does the same on read (routers/pfs.py) - this copy also
// covers statements kept on record before the change.

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'GU', 'MP', 'PR', 'VI',
];
const STATE_SET = new Set(US_STATES);

/** "95814" or "95814-1234" from 5 or 9 digits; null when it is neither. */
export const formatZip = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  const raw = String(v ?? '').trim();
  if (!/^\d{5}(-?\d{4})?$/.test(raw.replace(/\s/g, ''))) return null;
  return digits.length === 9 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
};

/** The inline message for a ZIP being typed; '' when it is fine or empty. */
export const zipError = (v) => (String(v ?? '').trim() && formatZip(v) === null ? 'ZIP is 5 digits, or 9 as 12345-6789.' : '');

/** Best-effort split of an old combined "City, ST 12345" value. */
export function splitCityStateZip(text) {
  const s = String(text ?? '').trim();
  if (!s) return {};
  let m = s.match(/^(.*?)[\s,]+([A-Za-z]{2})\.?[\s,]+(\d{5}(?:-?\d{4})?)$/);
  if (m && m[1].trim() && STATE_SET.has(m[2].toUpperCase())) return { city: m[1].replace(/[\s,]+$/, '').trim(), state: m[2].toUpperCase(), zip: formatZip(m[3]) };
  m = s.match(/^(.*?)[\s,]+([A-Za-z]{2})\.?$/);
  if (m && m[1].trim() && STATE_SET.has(m[2].toUpperCase())) return { city: m[1].replace(/[\s,]+$/, '').trim(), state: m[2].toUpperCase() };
  m = s.match(/^(.*?)[\s,]+(\d{5}(?:-?\d{4})?)$/);
  if (m && m[1].trim()) return { city: m[1].replace(/[\s,]+$/, '').trim(), zip: formatZip(m[2]) };
  return { city: s };
}

// One block (the borrower's details or the co-borrower's): the old combined
// value becomes the three fields, unless the three are already there.
function withParts(block) {
  const out = { ...block };
  const old = out.city_state_zip;
  delete out.city_state_zip;
  if (old && !out.city && !out.state && !out.zip) Object.assign(out, splitCityStateZip(old));
  return out;
}

/** The details as the Oct 7 form reads them: city / state / zip on both
 * blocks, the old spouse name folded into the co-borrower's name. */
export function normalizePfsDetails(details) {
  const d = withParts(details && typeof details === 'object' ? details : {});
  const spouse = String(d.spouse ?? '').trim();
  delete d.spouse;
  const hasCo = d.coBorrower && typeof d.coBorrower === 'object';
  if (hasCo || spouse) {
    const co = withParts(hasCo ? d.coBorrower : {});
    if (!String(co.name ?? '').trim() && spouse) co.name = spouse;
    d.coBorrower = co;
  }
  return d;
}

/** "City, ST 12345" from the three fields (or an old combined value). */
export function cityStateZip(block) {
  const b = block || {};
  const p = b.city || b.state || b.zip ? b : splitCityStateZip(b.city_state_zip);
  const tail = [p.state, p.zip].filter(Boolean).join(' ');
  return [p.city, tail].filter(Boolean).join(', ');
}

/** The address line printed on the PDF and the workbook. */
export const addressLine = (block) => [block?.address, cityStateZip(block)].filter(Boolean).join(', ');

/** The co-borrower's name: the block's, else a statement's old spouse field. */
export const coBorrowerName = (details) => String(details?.coBorrower?.name || details?.spouse || '').trim();
