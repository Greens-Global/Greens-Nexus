// Mirrors the real Google Business Profile Performance API
// (businessprofileperformance.googleapis.com/v1) — specifically
// locations.fetchMultiDailyMetricsTimeSeries for views/clicks/calls and
// locations.searchkeywords.impressions.monthly.list for discovery queries.
// When the real API is wired in, only the fetch*Report() functions in
// profileData.ts need to change — these adapters already know how to read
// that exact JSON.

function gbpDateToIso(d) {
  const mm = String(d.month).padStart(2, '0')
  const dd = String(d.day).padStart(2, '0')
  return `${d.year}-${mm}-${dd}`
}

export function adaptGbpTimeSeries(response) {
  const byDate = new Map()
  const get = (date) => {
    let p = byDate.get(date)
    if (!p) {
      p = { date, mapsViews: 0, searchViews: 0, websiteClicks: 0, callClicks: 0, directionRequests: 0 }
      byDate.set(date, p)
    }
    return p
  }

  for (const series of response.multiDailyMetricTimeSeries) {
    for (const row of series.dailyMetricTimeSeries) {
      for (const dv of row.timeSeries.datedValues) {
        const p = get(gbpDateToIso(dv.date))
        const value = Number(dv.value)
        if (row.dailyMetric === 'BUSINESS_IMPRESSIONS_MOBILE_MAPS' || row.dailyMetric === 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS') {
          p.mapsViews += value
        } else if (row.dailyMetric === 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH' || row.dailyMetric === 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') {
          p.searchViews += value
        } else if (row.dailyMetric === 'WEBSITE_CLICKS') {
          p.websiteClicks += value
        } else if (row.dailyMetric === 'CALL_CLICKS') {
          p.callClicks += value
        } else if (row.dailyMetric === 'BUSINESS_DIRECTION_REQUESTS') {
          p.directionRequests += value
        }
      }
    }
  }

  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
}

export function adaptGbpSearchKeywords(response) {
  return response.searchKeywordsCounts.map((r) => ({
    keyword: r.searchKeyword,
    type: r.type,
    impressions: Number(r.insightsValue.value),
  }))
}
