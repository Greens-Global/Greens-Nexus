// Reads a QuickBooks Desktop "Timer Lists" export (File > Utilities > Export >
// Timer Lists, an .iif file) in the browser - Charmi, 11/06/2026: the IIF
// import kept failing because Nexus wrote "Regular Pay" / "Overtime Pay" /
// "Vacation Pay" and her company file names its payroll items differently.
// The same file already gives the TIMERHDR company name and create time, so
// one upload fills Payroll Export Codes with what her QuickBooks really has.
// Nothing is sent anywhere; the caller shows the result and HR saves it.

// An IIF is tab separated: a "!TAG\tCOL..." line names the columns of the
// "TAG\t..." rows after it. Values may be wrapped in double quotes.
const unquote = (v) => {
  const s = (v ?? '').trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"').trim() : s;
};

// The section that lists payroll items. QuickBooks versions name it a little
// differently, so any tag that reads as a payroll item list counts.
const isPayItemTag = (tag) => /^(PAYITEM|PITEM|PAYROLLITEM|HRPAYITEM|PAYROLLITEMWAGE|PAYITEMWAGE)$/.test(tag) || /PAY.*ITEM/.test(tag);

export function parseTimerLists(text) {
  const out = { companyName: '', createTime: '', payrollItems: [], sections: [] };
  const headers = {};
  const items = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = raw.split('\t');
    const first = unquote(cells[0]).toUpperCase();
    if (first.startsWith('!')) {
      const tag = first.slice(1);
      headers[tag] = cells.slice(1).map((c) => unquote(c).toUpperCase());
      if (!out.sections.includes(tag)) out.sections.push(tag);
      continue;
    }
    const cols = headers[first];
    if (!cols) continue;
    const val = (name) => {
      const i = cols.indexOf(name);
      return i >= 0 ? unquote(cells[i + 1]) : '';
    };
    if (first === 'TIMERHDR') {
      out.companyName = val('COMPANYNAME') || out.companyName;
      const ct = val('COMPANYCREATETIME');
      if (/^[0-9]{1,12}$/.test(ct)) out.createTime = ct;
    } else if (isPayItemTag(first)) {
      const name = val('NAME');
      // A hidden (inactive) item cannot take time.
      if (name && !/^Y/i.test(val('HIDDEN'))) items.add(name);
    }
  }
  out.payrollItems = [...items].sort((a, b) => a.localeCompare(b));
  return out;
}

// Best guess of the QuickBooks payroll item for each Nexus pay class - only
// when exactly ONE item fits, so nothing is guessed between two. HR sees the
// filled boxes and decides before saving.
const RULES = {
  overtime: /overtime|\bo\.?t\.?\b|1\.5/i,
  doubleTime: /double|\bd\.?t\.?\b|\b2(\.0)?\s*x\b|x\s*2\b/i,
  holiday: /holiday/i,
  sick: /sick/i,
  vacation: /vacation|\bvac\b|\bpto\b/i,
  personal: /personal/i,
};
const OTHER = /overtime|\bo\.?t\.?\b|double|holiday|sick|vacation|\bvac\b|\bpto\b|personal|salary|bonus|commission|premium|differential|call|advance|reimb|tip/i;

export function guessPayItems(items) {
  const list = items || [];
  const one = (pred) => {
    const hits = list.filter(pred);
    return hits.length === 1 ? hits[0] : '';
  };
  const guess = {};
  const reg = one((n) => /regular|hourly|\bwage/i.test(n) && !OTHER.test(n));
  if (reg) guess.regular = reg;
  for (const [key, re] of Object.entries(RULES)) {
    // "Overtime (x2)" is double time, not overtime.
    const hit = one((n) => re.test(n) && !/salary/i.test(n) && !(key === 'overtime' && RULES.doubleTime.test(n)));
    if (hit) guess[key] = hit;
  }
  return guess;
}
