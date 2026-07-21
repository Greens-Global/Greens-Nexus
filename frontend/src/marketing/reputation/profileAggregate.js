import { FACILITIES, ALL_PROPERTIES } from '../shared/facilities'

function rowsForProperty(metricsByFacility, property) {
  if (property !== ALL_PROPERTIES) return metricsByFacility[property] ?? []

  const byDate = new Map()
  for (const facility of FACILITIES) {
    for (const row of metricsByFacility[facility] ?? []) {
      const existing = byDate.get(row.date)
      if (existing) {
        existing.mapsViews += row.mapsViews
        existing.searchViews += row.searchViews
        existing.websiteClicks += row.websiteClicks
        existing.callClicks += row.callClicks
        existing.directionRequests += row.directionRequests
      } else {
        byDate.set(row.date, { ...row })
      }
    }
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
}

export function profileRowsInRange(metricsByFacility, property, range) {
  return rowsForProperty(metricsByFacility, property).filter((r) => r.date >= range.start && r.date <= range.end)
}

export function sumProfileTotals(rows) {
  const mapsViews = rows.reduce((a, r) => a + r.mapsViews, 0)
  const searchViews = rows.reduce((a, r) => a + r.searchViews, 0)
  return {
    mapsViews,
    searchViews,
    totalViews: mapsViews + searchViews,
    websiteClicks: rows.reduce((a, r) => a + r.websiteClicks, 0),
    callClicks: rows.reduce((a, r) => a + r.callClicks, 0),
    directionRequests: rows.reduce((a, r) => a + r.directionRequests, 0),
  }
}

export function topDiscoveryKeywords(keywordsByFacility, property, limit = 8) {
  if (property !== ALL_PROPERTIES) {
    return [...(keywordsByFacility[property] ?? [])].sort((a, b) => b.impressions - a.impressions).slice(0, limit)
  }
  const merged = new Map()
  for (const facility of FACILITIES) {
    for (const kw of keywordsByFacility[facility] ?? []) {
      const existing = merged.get(kw.keyword)
      if (existing) existing.impressions += kw.impressions
      else merged.set(kw.keyword, { ...kw })
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
}

export function directDiscoverySplit(keywordsByFacility, property) {
  const keywords = property !== ALL_PROPERTIES ? keywordsByFacility[property] ?? [] : Object.values(keywordsByFacility).flat()
  const direct = keywords.filter((k) => k.type === 'Direct').reduce((a, k) => a + k.impressions, 0)
  const discovery = keywords.filter((k) => k.type === 'Discovery').reduce((a, k) => a + k.impressions, 0)
  return { direct, discovery, total: direct + discovery }
}
