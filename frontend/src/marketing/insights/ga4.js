// Mirrors the real Google Analytics Data API (GA4) `runReport` response
// shape (properties.runReport). When the real API is wired in, only the
// `fetchXReport()` functions in data.ts need to change (swap the mock
// response for an actual `analyticsdata.googleapis.com` call) — the parse*
// functions below already know how to read that exact JSON.

// GA4's default channel grouping — matches the real dimension values Google
// Analytics buckets traffic into (sessionDefaultChannelGrouping).
export const CHANNELS = ['Google Ads', 'Direct', 'Organic Search', 'Referral', 'Social Media']

function ga4Date(iso) {
  // GA4 report rows use an unpunctuated YYYYMMDD string for the `date` dimension.
  return iso.replaceAll('-', '')
}

function isoFromGa4Date(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
}

// Error-diffusion allocation: splits an integer total across cells
// proportional to `weights`, guaranteeing the cells sum back to exactly
// `total` every call. `carry` is a per-cell fractional balance the caller
// keeps and passes back in on every subsequent call (typically once per
// day) — a cell that loses today's rounding keeps its owed fraction, which
// accumulates until it's large enough to win a unit. Plain largest-remainder
// re-decided from scratch each day would systematically starve a small-share
// cell forever if its per-day expected value never happens to out-rank the
// others (which is exactly what happens to a channel like Social Media at
// ~4% share split across only 30 days) — carrying the remainder forward
// guarantees every cell eventually gets its proportional share.
function allocateWithCarry(total, weights, carry) {
  const roundedTotal = Math.round(total)
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1
  const target = weights.map((w, i) => (w / weightSum) * roundedTotal + carry[i])
  const floors = target.map((t) => Math.max(0, Math.floor(t)))
  let remainder = roundedTotal - floors.reduce((a, b) => a + b, 0)

  const result = [...floors]
  if (remainder > 0) {
    const order = target.map((t, i) => ({ i, frac: t - floors[i] })).sort((a, b) => b.frac - a.frac)
    for (let k = 0; k < order.length && remainder > 0; k++, remainder--) result[order[k].i] += 1
  } else if (remainder < 0) {
    const order = target.map((t, i) => ({ i, frac: t - floors[i] })).sort((a, b) => a.frac - b.frac)
    for (let k = 0; k < order.length && remainder < 0; k++, remainder++) {
      if (result[order[k].i] > 0) result[order[k].i] -= 1
    }
  }
  for (let i = 0; i < weights.length; i++) carry[i] = target[i] - result[i]
  return result
}

// Two-stage allocation: split the day's total across channels first (a
// coarse 5-way split), then split each channel's own integer total across
// properties. Each stage keeps its own persistent carry so small shares at
// either level still show up over the month, proportional to their share.
function allocateTwoStage(
  total,
  channelShares,
  propertyShares,
  channelCarry,
  propertyCarryByChannel,
) {
  const channelValues = allocateWithCarry(total, channelShares.map((c) => c.share), channelCarry)
  return channelValues.map((channelTotal, ci) =>
    allocateWithCarry(channelTotal, propertyShares.map((p) => p.share), propertyCarryByChannel[ci]),
  )
}

/**
 * Builds a mock response for:
 *   dimensions: [date, sessionDefaultChannelGrouping, customEvent:property_name]
 *   metrics: [sessions]
 */
export function buildSessionsReport(dailySessions, channelShares, propertyShares) {
  const rows = []
  const channelCarry = channelShares.map(() => 0)
  const propertyCarryByChannel = channelShares.map(() => propertyShares.map(() => 0))
  for (const day of dailySessions) {
    const perChannel = allocateTwoStage(day.value, channelShares, propertyShares, channelCarry, propertyCarryByChannel)
    channelShares.forEach((channel, ci) => {
      propertyShares.forEach((property, pi) => {
        rows.push({
          dimensionValues: [{ value: ga4Date(day.date) }, { value: channel.name }, { value: property.name }],
          metricValues: [{ value: String(perChannel[ci][pi]) }],
        })
      })
    })
  }
  return {
    dimensionHeaders: [{ name: 'date' }, { name: 'sessionDefaultChannelGrouping' }, { name: 'customEvent:property_name' }],
    metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
    rows,
    rowCount: rows.length,
  }
}

/**
 * Builds a mock response for:
 *   dimensions: [date, sessionDefaultChannelGrouping, customEvent:property_name, eventName]
 *   metrics: [eventCount]
 * `eventName` is filtered app-side to the two key events this app tracks:
 * 'generate_lead' (form fill / call) and 'move_in' (closed-won).
 */
export function buildEventsReport(
  dailyLeads,
  dailyMoveIns,
  channelShares,
  propertyLeadShares,
  propertyMoveInShares,
) {
  const rows = []
  const push = (days, eventName, shares) => {
    const channelCarry = channelShares.map(() => 0)
    const propertyCarryByChannel = channelShares.map(() => shares.map(() => 0))
    for (const day of days) {
      const perChannel = allocateTwoStage(day.value, channelShares, shares, channelCarry, propertyCarryByChannel)
      channelShares.forEach((channel, ci) => {
        shares.forEach((property, pi) => {
          rows.push({
            dimensionValues: [{ value: ga4Date(day.date) }, { value: channel.name }, { value: property.name }, { value: eventName }],
            metricValues: [{ value: String(perChannel[ci][pi]) }],
          })
        })
      })
    }
  }
  push(dailyLeads, 'generate_lead', propertyLeadShares)
  push(dailyMoveIns, 'move_in', propertyMoveInShares)

  return {
    dimensionHeaders: [
      { name: 'date' },
      { name: 'sessionDefaultChannelGrouping' },
      { name: 'customEvent:property_name' },
      { name: 'eventName' },
    ],
    metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }],
    rows,
    rowCount: rows.length,
  }
}

export function parseSessionsReport(response) {
  return response.rows.map((r) => ({
    date: isoFromGa4Date(r.dimensionValues[0].value),
    channel: r.dimensionValues[1].value,
    property: r.dimensionValues[2].value,
    sessions: Number(r.metricValues[0].value),
  }))
}

export function parseEventsReport(response) {
  return response.rows.map((r) => ({
    date: isoFromGa4Date(r.dimensionValues[0].value),
    channel: r.dimensionValues[1].value,
    property: r.dimensionValues[2].value,
    eventName: r.dimensionValues[3].value,
    count: Number(r.metricValues[0].value),
  }))
}
