import { dailyLeadMetrics, sessionRows, eventRows, CHANNELS } from './data'
import { FACILITIES } from '../shared/facilities'

export function filterByRange(rows, range) {
  return rows.filter((r) => r.date >= range.start && r.date <= range.end)
}

// For "All Properties" this is just the precomputed daily series. For a
// specific property it re-derives sessions/organicSessions/leads/moveIns by
// summing the exact matching GA4 rows — an exact filter, not an estimate.
// NPS/promoter/detractor are survey data, not property-attributed, so they
// pass through unfiltered either way.
export function dailyRowsForProperty(property) {
  if (property === null) return dailyLeadMetrics

  const byDate = new Map()
  const agg = (date) => {
    let a = byDate.get(date)
    if (!a) {
      a = { sessions: 0, organicSessions: 0, leads: 0, moveIns: 0 }
      byDate.set(date, a)
    }
    return a
  }
  for (const r of sessionRows) {
    if (r.property !== property) continue
    const a = agg(r.date)
    a.sessions += r.sessions
    if (r.channel === 'Organic Search') a.organicSessions += r.sessions
  }
  for (const r of eventRows) {
    if (r.property !== property) continue
    const a = agg(r.date)
    if (r.eventName === 'generate_lead') a.leads += r.count
    else a.moveIns += r.count
  }

  return dailyLeadMetrics.map((d) => {
    const a = byDate.get(d.date) ?? { sessions: 0, organicSessions: 0, leads: 0, moveIns: 0 }
    return { ...d, ...a }
  })
}

export function sumLeadTotals(rows) {
  const sessions = rows.reduce((a, r) => a + r.sessions, 0)
  const organicSessions = rows.reduce((a, r) => a + r.organicSessions, 0)
  const leads = rows.reduce((a, r) => a + r.leads, 0)
  const moveIns = rows.reduce((a, r) => a + r.moveIns, 0)
  const n = rows.length
  const npsAvg = n > 0 ? rows.reduce((a, r) => a + r.nps, 0) / n : 0
  const promoterPctAvg = n > 0 ? rows.reduce((a, r) => a + r.promoterPct, 0) / n : 0
  const detractorPctAvg = n > 0 ? rows.reduce((a, r) => a + r.detractorPct, 0) / n : 0
  return {
    sessions,
    organicSessions,
    leads,
    moveIns,
    npsAvg,
    promoterPctAvg,
    detractorPctAvg,
    leadToMoveInRate: leads > 0 ? (moveIns / leads) * 100 : 0,
  }
}

// Genuinely date-range- and property-scoped — pulled straight from the
// parsed GA4 event rows rather than a fixed percentage snapshot.
export function leadsByChannelInRange(range, property) {
  const rows = eventRows.filter(
    (r) => r.date >= range.start && r.date <= range.end && r.eventName === 'generate_lead' && (property === null || r.property === property),
  )
  const byChannel = new Map(CHANNELS.map((c) => [c, 0]))
  for (const r of rows) byChannel.set(r.channel, (byChannel.get(r.channel) ?? 0) + r.count)
  return CHANNELS.map((source) => ({ source, value: Math.round(byChannel.get(source) ?? 0) }))
}

export function propertyBreakdownInRange(range) {
  const rows = eventRows.filter((r) => r.date >= range.start && r.date <= range.end)
  const leads = new Map(FACILITIES.map((f) => [f, 0]))
  const moveIns = new Map(FACILITIES.map((f) => [f, 0]))
  for (const r of rows) {
    const map = r.eventName === 'generate_lead' ? leads : moveIns
    map.set(r.property, (map.get(r.property) ?? 0) + r.count)
  }
  return FACILITIES.map((name) => ({
    name,
    leads: Math.round(leads.get(name) ?? 0),
    moveIns: Math.round(moveIns.get(name) ?? 0),
  }))
}
