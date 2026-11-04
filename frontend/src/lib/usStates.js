// US states by code - where a hire works inside the US picks their hiring
// paperwork (Neil, Oct 22: California and Texas get different packets).
export const US_STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico',
};

export const stateName = (code) => US_STATE_NAMES[(code || '').toUpperCase()] || code || '';

/** "California", "India", "Texas" - the place a packet or hire is for. */
export const placeName = (country, region, countryNames = {}) =>
  (country === 'US' && region ? stateName(region) : '') || countryNames[country] || country || '';

// Works In (Neil, 11/04/2026): three places for every hiring document - an
// offer, a hiring packet, a promotion, a separation - "other options will
// come later... each state has their own process". United States - CA first:
// it is the default.
export const WORKS_IN = [
  { key: 'US-CA', country: 'US', region: 'CA', label: 'United States - CA' },
  { key: 'US-TX', country: 'US', region: 'TX', label: 'United States - TX' },
  { key: 'IN', country: 'IN', region: '', label: 'India' },
];
export const worksInKey = (country, region) => (country ? (country === 'US' ? `US-${region || ''}` : country) : '');
/** The label of a saved place, one of the three or an older one kept as it was. */
export const worksInLabel = (country, region, countryNames = {}) =>
  WORKS_IN.find(w => w.key === worksInKey(country, region))?.label
  || (country === 'US' ? `United States - ${region || 'Anywhere'}` : countryNames[country] || country || '');
