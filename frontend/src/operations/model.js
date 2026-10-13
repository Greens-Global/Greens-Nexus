// Operations (storage facilities): the arithmetic the screen does on the
// payload from GET /facility-ops/summary. The server sends one block per
// facility; `combine` adds any set of them into one block of the same shape,
// so "All Facilities" and a single facility render through the same code.
// Money is integer cents until `money` formats it.

export const AGING = [
  { key: 'd0_30', label: '0-30 Days' },
  { key: 'd30_60', label: '31-60 Days' },
  { key: 'd60_90', label: '61-90 Days' },
  { key: 'd90_120', label: '91-120 Days' },
  { key: 'd120_plus', label: '120+ Days' },
];
const AGING_LABEL = Object.fromEntries(AGING.map((a) => [a.key, a.label]));
export const agingLabel = (key) => AGING_LABEL[key] || '0-30 Days';

export const OFF_MARKET_REASON = {
  REPAIRS_REQUIRED: 'Repairs Required',
  UNDER_RENOVATION: 'Under Renovation',
  USED_BY_FACILITY: 'Used by Facility',
  OTHER: 'Other',
};

export const LEAD_STATUS = {
  NEW: 'New',
  IN_PROGRESS_HOT: 'Hot',
  IN_PROGRESS_COLD: 'Cold',
  ON_HOLD: 'On Hold',
  RESERVATION: 'Reserved',
};

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

export function money(cents, { compact = false, exact = false } = {}) {
  const n = (Number(cents) || 0) / 100;
  if (exact) return usdCents.format(n);
  return compact && Math.abs(n) >= 10000 ? usdCompact.format(n) : usd.format(n);
}

// Cubby's own codes ("SEARCH_ENGINE") read as "Search Engine"; text staff typed is left alone.
export const tidy = (v) => (/^[A-Z0-9_]+$/.test(v || '')
  ? v.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  : (v || ''));

export const count = (n) => (Number(n) || 0).toLocaleString('en-US');

// A share as "67.2%"; a dash when there is nothing to divide by.
export function pct(part, whole, digits = 1) {
  if (!whole) return '-';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-10" -> "Oct '26"
export function monthLabel(ym) {
  const [y, m] = String(ym || '').split('-');
  return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} '${y.slice(2)}` : '';
}
// "2026-10-13" -> "10/13"
export function dayLabel(iso) {
  const [, m, d] = String(iso || '').split('-');
  return m && d ? `${m}/${d}` : '';
}

// The period selector. Occupancy, rent and balances are always "as of today";
// a period only changes what happened OVER time: move-ins and move-outs,
// money collected, failed payments, and how far back the charts reach.
export const PERIODS = [
  { key: 'this-month', label: 'This Month' },
  { key: 'last-month', label: 'Last Month' },
  { key: 'last-30', label: 'Last 30 Days' },
  { key: 'last-90', label: 'Last 90 Days' },
  { key: 'this-year', label: 'This Year' },
  { key: 'last-12', label: 'Last 12 Months' },
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// { key, label, from, to } as YYYY-MM-DD strings, counted back from `asOf`
// (the facility's own "today", so a Pacific evening is not already tomorrow).
export function periodRange(key, asOf) {
  const [y, m, d] = String(asOf || '').split('-').map(Number);
  const today = y ? new Date(y, m - 1, d) : new Date();
  const back = (days) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  const label = (PERIODS.find((p) => p.key === key) || PERIODS[0]).label;
  let from = new Date(today.getFullYear(), today.getMonth(), 1);
  let to = today;
  if (key === 'last-month') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (key === 'last-30') from = back(29);
  else if (key === 'last-90') from = back(89);
  else if (key === 'this-year') from = new Date(today.getFullYear(), 0, 1);
  else if (key === 'last-12') from = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1);
  return { key, label, from: iso(from), to: iso(to) };
}

const within = (rows, range) => rows.filter((r) => r.date >= range.from && r.date <= range.to);

// What happened in the period, from the daily series.
export function periodStats(data, range) {
  const moves = within(data.moves.daily, range);
  const pays = within(data.payments.daily, range);
  return {
    moveIns: moves.reduce((a, r) => a + r.ins, 0),
    moveOuts: moves.reduce((a, r) => a + r.outs, 0),
    collected: pays.reduce((a, r) => a + r.collected, 0),
    failed: pays.reduce((a, r) => a + r.failed, 0),
    failedRows: within(data.payments.failed, range),
  };
}

// The months a trend chart shows: the period's own, and never fewer than six -
// one bar is not a trend.
export function historyWindow(history, range) {
  const last = range.to.slice(0, 7);
  const upTo = history.filter((h) => h.month <= last);
  const inRange = upTo.filter((h) => h.month >= range.from.slice(0, 7)).length;
  return upTo.slice(-Math.max(6, inRange));
}

// Collections for the chart: a bar per day, or per month once the period is
// too long for days to be readable.
export function collectionSeries(daily, range) {
  const days = within(daily, range);
  if (days.length <= 92) return days.map((d) => ({ ...d, label: dayLabel(d.date) }));
  const months = new Map();
  for (const d of days) {
    const ym = d.date.slice(0, 7);
    const hit = months.get(ym) || { date: ym, label: monthLabel(ym), collected: 0, failed: 0 };
    hit.collected += d.collected;
    hit.failed += d.failed;
    months.set(ym, hit);
  }
  return [...months.values()];
}

const sumBy = (list, pick) => list.reduce((a, x) => a + (pick(x) || 0), 0);
const tag = (f, rows) => rows.map((r) => ({ ...r, facility: f.shortName }));

function mergeSeries(facilities, pick, key, fields) {
  const byKey = new Map();
  for (const f of facilities) {
    for (const row of pick(f)) {
      const hit = byKey.get(row[key]) || { [key]: row[key], ...Object.fromEntries(fields.map((k) => [k, 0])) };
      for (const k of fields) hit[k] += row[k] || 0;
      byKey.set(row[key], hit);
    }
  }
  return [...byKey.values()].sort((a, b) => (a[key] > b[key] ? 1 : -1));
}

export function combine(facilities) {
  const fs = facilities || [];
  const types = new Map();
  for (const f of fs) {
    for (const t of f.unitTypes) {
      const hit = types.get(t.name) || { name: t.name, total: 0, rented: 0, vacant: 0, unavailable: 0, rentSum: 0, vacantPotential: 0, streetSum: 0 };
      for (const k of ['total', 'rented', 'vacant', 'unavailable', 'rentSum', 'vacantPotential']) hit[k] += t[k] || 0;
      hit.streetSum += (t.street || 0) * (t.total || 0);
      types.set(t.name, hit);
    }
  }
  const buckets = {};
  for (const a of AGING) buckets[a.key] = sumBy(fs, (f) => f.pastDue.buckets[a.key]);

  return {
    count: fs.length,
    units: {
      total: sumBy(fs, (f) => f.units.total), rented: sumBy(fs, (f) => f.units.rented),
      vacant: sumBy(fs, (f) => f.units.vacant), unavailable: sumBy(fs, (f) => f.units.unavailable),
    },
    area: { total: sumBy(fs, (f) => f.area.total), rented: sumBy(fs, (f) => f.area.rented) },
    rent: {
      rentRoll: sumBy(fs, (f) => f.rent.rentRoll), streetRented: sumBy(fs, (f) => f.rent.streetRented),
      vacantPotential: sumBy(fs, (f) => f.rent.vacantPotential), belowStreetGap: sumBy(fs, (f) => f.rent.belowStreetGap),
      belowStreetCount: sumBy(fs, (f) => f.rent.belowStreetCount),
    },
    autoPay: sumBy(fs, (f) => f.autoPay),
    protected: sumBy(fs, (f) => f.protected),
    pastDue: {
      total: sumBy(fs, (f) => f.pastDue.total), tenants: sumBy(fs, (f) => f.pastDue.tenants), buckets,
      rows: fs.flatMap((f) => tag(f, f.pastDue.rows)).sort((a, b) => b.amount - a.amount),
    },
    locks: {
      toPlace: fs.flatMap((f) => tag(f, f.locks.toPlace)),
      toRemove: fs.flatMap((f) => tag(f, f.locks.toRemove)),
      applied: sumBy(fs, (f) => f.locks.applied),
    },
    history: mergeSeries(fs, (f) => f.history, 'month', ['moveIns', 'moveOuts', 'rented']),
    moves: {
      insMtd: sumBy(fs, (f) => f.moves.insMtd), outsMtd: sumBy(fs, (f) => f.moves.outsMtd),
      movingOut: fs.flatMap((f) => tag(f, f.moves.movingOut)).sort((a, b) => (a.date > b.date ? 1 : -1)),
      movingIn: fs.flatMap((f) => tag(f, f.moves.movingIn)).sort((a, b) => (a.date > b.date ? 1 : -1)),
      daily: mergeSeries(fs, (f) => f.moves.daily || [], 'date', ['ins', 'outs']),
    },
    rentChanges: { count: sumBy(fs, (f) => f.rentChanges.count), lift: sumBy(fs, (f) => f.rentChanges.lift) },
    unitTypes: [...types.values()]
      .map((t) => ({ ...t, street: t.total ? Math.round(t.streetSum / t.total) : 0 }))
      .sort((a, b) => b.vacantPotential - a.vacantPotential),
    belowStreet: fs.flatMap((f) => tag(f, f.belowStreet)).sort((a, b) => (b.street - b.rent) - (a.street - a.rent)),
    offMarket: fs.flatMap((f) => tag(f, f.offMarket)),
    leads: {
      total: sumBy(fs, (f) => f.leads.total), open: sumBy(fs, (f) => f.leads.open),
      reserved: sumBy(fs, (f) => f.leads.reserved), converted: sumBy(fs, (f) => f.leads.converted),
      rows: fs.flatMap((f) => tag(f, f.leads.rows)).sort((a, b) => b.ageDays - a.ageDays),
    },
    tasks: {
      open: sumBy(fs, (f) => f.tasks.open), overdue: sumBy(fs, (f) => f.tasks.overdue),
      rows: fs.flatMap((f) => tag(f, f.tasks.rows)).sort((a, b) => ((a.dueDate || '9') > (b.dueDate || '9') ? 1 : -1)),
    },
    payments: {
      collectedMtd: sumBy(fs, (f) => f.payments.collectedMtd),
      daily: mergeSeries(fs, (f) => f.payments.daily, 'date', ['collected', 'failed']),
      failed: fs.flatMap((f) => tag(f, f.payments.failed)).sort((a, b) => (a.date < b.date ? 1 : -1)),
    },
  };
}

// Past-due dollars per day for the chosen facilities, from the saved daily
// history. A day only counts once every chosen facility has a row for it, so
// the line never dips because one facility's row is missing.
export function pastDueTrend(trend, ids) {
  const want = new Set(ids);
  const days = new Map();
  for (const r of trend || []) {
    if (!want.has(r.facilityId)) continue;
    const hit = days.get(r.date) || { date: r.date, pastDue: 0, seen: 0 };
    hit.pastDue += r.pastDue || 0;
    hit.seen += 1;
    days.set(r.date, hit);
  }
  return [...days.values()].filter((d) => d.seen === want.size).sort((a, b) => (a.date > b.date ? 1 : -1));
}

// One line a manager can act on, per facility. Ordered by kind - money owed,
// then locks, then units that cannot be rented, then leads and tasks - and by
// size within a kind. Thresholds are deliberately plain: prompts to look, not
// scores.
export function attentionItems(facilities) {
  const out = [];
  const add = (rank, size, f, tab, section, text) => out.push({ rank, size, facility: f.shortName, tab, section, text });
  for (const f of facilities || []) {
    const older = f.pastDue.total - (f.pastDue.buckets.d0_30 || 0);
    if (f.rent.rentRoll && f.pastDue.total / f.rent.rentRoll >= 0.1) {
      add(1, f.pastDue.total, f, 'collections', 'past-due', `${money(f.pastDue.total)} past due - ${pct(f.pastDue.total, f.rent.rentRoll, 0)} of a month's rent`);
    } else if (older > 0 && older / f.pastDue.total >= 0.5) {
      add(1, older, f, 'collections', 'past-due', `${money(older)} of the past-due balance is older than 30 days`);
    }
    const locks = f.locks.toPlace.length;
    if (locks) add(2, locks, f, 'worklist', 'locks-place', `${locks} ${locks === 1 ? 'unit needs' : 'units need'} an overlock`);
    if (f.units.total && f.units.unavailable / f.units.total >= 0.15) {
      add(3, f.units.unavailable, f, 'units', 'off-market', `${count(f.units.unavailable)} of ${count(f.units.total)} units are off the market (${pct(f.units.unavailable, f.units.total, 0)})`);
    }
    const stale = f.leads.rows.filter((l) => l.status === 'NEW' && l.ageDays >= 2).length;
    if (stale) add(4, stale, f, 'worklist', 'leads', `${stale} new ${stale === 1 ? 'lead has' : 'leads have'} waited 2+ days`);
    if (f.tasks.overdue) add(5, f.tasks.overdue, f, 'worklist', 'tasks', `${f.tasks.overdue} overdue ${f.tasks.overdue === 1 ? 'task' : 'tasks'}`);
  }
  return out.sort((a, b) => a.rank - b.rank || b.size - a.size);
}
