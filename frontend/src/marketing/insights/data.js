import { FACILITIES } from '../shared/facilities'
import { CHANNELS, buildSessionsReport, buildEventsReport, parseSessionsReport, parseEventsReport } from './ga4'

function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Smooth random-walk weights, same approach used for the Google Ads daily
// series, so this chart wanders gently rather than jumping day to day.
function distribute(days, total, seed) {
  const rng = mulberry32(seed)
  const weights = []
  let level = 1
  for (let i = 0; i < days; i++) {
    level += (rng() - 0.5) * 0.12
    level = Math.max(0.55, Math.min(1.6, level))
    weights.push(level)
  }
  const sumW = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (total * w) / sumW)
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

// Generates the account-wide daily totals only — these aren't the GA4
// response yet. Session/lead/move-in totals get sliced by channel and
// property into a mock GA4 report below; NPS is a survey metric (e.g. from
// a tool like Delighted), not something Google's API provides, so it stays
// a plain internal series.
function generateMonth(year, monthIndex, targets, seedBase) {
  const dim = daysInMonth(year, monthIndex)
  const sessions = distribute(dim, targets.sessions, seedBase + 1)
  const leads = distribute(dim, targets.leads, seedBase + 2)
  const moveIns = distribute(dim, targets.moveIns, seedBase + 3)
  const npsRng = mulberry32(seedBase + 5)

  // Assume ~20pts of passives; promoters/detractors are the split of the
  // remaining 80pts that produces the target NPS (promoters - detractors).
  const promoterBaseline = (targets.nps + 80) / 2
  const detractorBaseline = (80 - targets.nps) / 2

  const rows = []
  let sRun = 0
  let lRun = 0
  let mRun = 0
  for (let day = 0; day < dim; day++) {
    const isLast = day === dim - 1
    const s = isLast ? Math.round(targets.sessions - sRun) : Math.round(sessions[day])
    const l = isLast ? Math.round(targets.leads - lRun) : Math.round(leads[day])
    const m = isLast ? Math.round(targets.moveIns - mRun) : Math.round(moveIns[day])
    sRun += s
    lRun += l
    mRun += m
    const promoterPct = Math.max(0, Math.min(100, promoterBaseline + (npsRng() - 0.5) * 8))
    const detractorPct = Math.max(0, Math.min(100, detractorBaseline + (npsRng() - 0.5) * 4))
    const nps = Math.round(promoterPct - detractorPct)
    const date = new Date(Date.UTC(year, monthIndex, day + 1)).toISOString().slice(0, 10)
    rows.push({ date, sessions: s, leads: l, moveIns: m, promoterPct, detractorPct, nps })
  }
  return rows
}

const JUNE = { sessions: 12_845, leads: 356, moveIns: 100, nps: 64 }
const MAY = { sessions: 10_858, leads: 311, moveIns: 85, nps: 59 }
const APRIL = { sessions: 9_989, leads: 280, moveIns: 76, nps: 57 }
const MARCH = { sessions: 8_990, leads: 246, moveIns: 65, nps: 55 }
const FEBRUARY = { sessions: 7_911, leads: 212, moveIns: 55, nps: 53 }
const JANUARY = { sessions: 6_804, leads: 178, moveIns: 45, nps: 51 }

const baseDaily = [
  ...generateMonth(2025, 0, JANUARY, 700),
  ...generateMonth(2025, 1, FEBRUARY, 800),
  ...generateMonth(2025, 2, MARCH, 900),
  ...generateMonth(2025, 3, APRIL, 1000),
  ...generateMonth(2025, 4, MAY, 1100),
  ...generateMonth(2025, 5, JUNE, 1200),
]

// Channel mix — matches GA4's default channel grouping for this account.
const CHANNEL_SHARES = [
  { name: 'Google Ads', share: 169 / 356 },
  { name: 'Direct', share: 98 / 356 },
  { name: 'Organic Search', share: 54 / 356 },
  { name: 'Referral', share: 21 / 356 },
  { name: 'Social Media', share: 14 / 356 },
]

const PROPERTY_LEADS = [112, 98, 76, 41, 29]
const PROPERTY_MOVE_INS = [36, 27, 19, 11, 7]
const TOTAL_PROPERTY_LEADS = PROPERTY_LEADS.reduce((a, b) => a + b, 0)
const TOTAL_PROPERTY_MOVE_INS = PROPERTY_MOVE_INS.reduce((a, b) => a + b, 0)

const PROPERTY_LEAD_SHARES = FACILITIES.map((name, i) => ({ name, share: PROPERTY_LEADS[i] / TOTAL_PROPERTY_LEADS }))
const PROPERTY_MOVE_IN_SHARES = FACILITIES.map((name, i) => ({ name, share: PROPERTY_MOVE_INS[i] / TOTAL_PROPERTY_MOVE_INS }))

// These two functions stand in for the real GA4 Data API calls
// (properties.runReport). Swap their bodies for actual fetches and nothing
// downstream needs to change — parseSessionsReport/parseEventsReport already
// know how to read that exact response shape.
function fetchSessionsReport() {
  return buildSessionsReport(
    baseDaily.map((d) => ({ date: d.date, value: d.sessions })),
    CHANNEL_SHARES,
    PROPERTY_LEAD_SHARES,
  )
}
function fetchEventsReport() {
  return buildEventsReport(
    baseDaily.map((d) => ({ date: d.date, value: d.leads })),
    baseDaily.map((d) => ({ date: d.date, value: d.moveIns })),
    CHANNEL_SHARES,
    PROPERTY_LEAD_SHARES,
    PROPERTY_MOVE_IN_SHARES,
  )
}

export const sessionRows = parseSessionsReport(fetchSessionsReport())
export const eventRows = parseEventsReport(fetchEventsReport())
export { CHANNELS }

// Reconstructed from the parsed GA4 rows (summed back across channel and
// property) so totals always reconcile exactly with the channel/property
// breakdowns shown elsewhere on the page. Grouped by date once up front
// rather than re-scanning the full row arrays per day.
const byDate = new Map()
function dayAgg(date) {
  let agg = byDate.get(date)
  if (!agg) {
    agg = { sessions: 0, organicSessions: 0, leads: 0, moveIns: 0 }
    byDate.set(date, agg)
  }
  return agg
}
for (const r of sessionRows) {
  const agg = dayAgg(r.date)
  agg.sessions += r.sessions
  if (r.channel === 'Organic Search') agg.organicSessions += r.sessions
}
for (const r of eventRows) {
  const agg = dayAgg(r.date)
  if (r.eventName === 'generate_lead') agg.leads += r.count
  else agg.moveIns += r.count
}

export const dailyLeadMetrics = baseDaily.map((d) => {
  const agg = byDate.get(d.date) ?? { sessions: 0, organicSessions: 0, leads: 0, moveIns: 0 }
  return {
    date: d.date,
    sessions: agg.sessions,
    organicSessions: agg.organicSessions,
    leads: agg.leads,
    moveIns: agg.moveIns,
    promoterPct: d.promoterPct,
    detractorPct: d.detractorPct,
    nps: d.nps,
  }
})

export const mobileTrafficShare = 0.68

// Proportioned the same way monthlyBudgetByPropertyDefault is (larger
// facilities get a bigger share), summing to the previous account-wide
// DEFAULT_LEAD_GOAL of 350.
export const leadGoalByPropertyDefault = {
  'Greens Valley Center': 110,
  'Greens Escondido': 90,
  'Greens Temecula': 65,
  'Greens Fairfield': 55,
  'Greens Georgetown': 30,
}
