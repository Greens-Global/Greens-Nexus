export function filterRange(rows, range) {
  return rows.filter((m) => m.date >= range.start && m.date <= range.end)
}

export function sumTotals(rows) {
  const impressions = rows.reduce((a, r) => a + r.impressions, 0)
  const clicks = rows.reduce((a, r) => a + r.clicks, 0)
  const conversions = rows.reduce((a, r) => a + r.conversions, 0)
  const spend = rows.reduce((a, r) => a + r.spend, 0)
  return {
    impressions,
    clicks,
    conversions,
    spend,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    costPerConv: conversions > 0 ? spend / conversions : 0,
    avgCpc: clicks > 0 ? spend / clicks : 0,
  }
}

// Neither platform has a true per-facility daily series, so each property's
// slice of the account-wide range totals is estimated by its share of clicks
// in Geographic Performance (the same approximation GoogleAdsPage already
// uses to scope a single selected property).
export function propertyBreakdownInRange(dailyRows, geoRows, range) {
  const rows = filterRange(dailyRows, range)
  const totals = sumTotals(rows)
  const totalClicks = geoRows.reduce((a, g) => a + g.clicks, 0)
  return geoRows.map((g) => {
    const share = totalClicks > 0 ? g.clicks / totalClicks : 0
    return {
      name: g.location,
      impressions: totals.impressions * share,
      clicks: totals.clicks * share,
      conversions: totals.conversions * share,
      spend: totals.spend * share,
      ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
      costPerConv: totals.conversions * share > 0 ? (totals.spend * share) / (totals.conversions * share) : 0,
      avgCpc: totals.clicks * share > 0 ? (totals.spend * share) / (totals.clicks * share) : 0,
    }
  })
}
