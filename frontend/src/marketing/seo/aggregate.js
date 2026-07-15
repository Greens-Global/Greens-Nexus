import { ALL_REGIONS, REGIONS } from '../shared/facilities'

export function searchKeywords(database, query) {
  const q = query.trim().toLowerCase()
  if (!q) return database
  return database.filter((k) => k.keyword.includes(q))
}

// Generic keywords (no region tag, e.g. "self storage") always stay visible —
// only region-tagged keywords get filtered out when they don't match.
export function filterKeywordsByRegion(database, region) {
  if (region === ALL_REGIONS) return database
  return database.filter((k) => !k.region || k.region === region)
}

export function filterTrackedByRegion(rows, region) {
  if (region === ALL_REGIONS) return rows
  const facilities = REGIONS.find((r) => r.name === region)?.facilities ?? []
  return rows.filter((r) => facilities.includes(r.facility))
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export { MONTH_LABELS }

// Row-normalized (each keyword's own min/max) so seasonality shape is visible
// for both head terms and long-tail terms regardless of absolute volume.
export function buildHeatmapRows(keywords, limit = 10) {
  return [...keywords]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit)
    .map((k) => {
      const min = Math.min(...k.trend)
      const max = Math.max(...k.trend)
      const span = max - min || 1
      return { keyword: k.keyword, volume: k.volume, cells: k.trend.map((v) => ({ raw: v, normalized: (v - min) / span })) }
    })
}

function latestPosition(tk) {
  return tk.history[tk.history.length - 1]?.position ?? 0
}
function firstPosition(tk) {
  return tk.history[0]?.position ?? 0
}

export function computeTrackedStats(rows) {
  const n = rows.length
  const avgPosition = n > 0 ? rows.reduce((a, r) => a + latestPosition(r), 0) / n : 0
  return {
    count: n,
    avgPosition,
    top10: rows.filter((r) => latestPosition(r) <= 10).length,
    top3: rows.filter((r) => latestPosition(r) <= 3).length,
    improved: rows.filter((r) => latestPosition(r) < firstPosition(r)).length,
    declined: rows.filter((r) => latestPosition(r) > firstPosition(r)).length,
  }
}

export function positionDelta(tk) {
  // Positive = improved (moved up, i.e. a lower position number).
  return firstPosition(tk) - latestPosition(tk)
}
