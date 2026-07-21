// Mirrors the real Google Ads API (v17+) GoogleAdsService.Search /
// SearchStream response shape for a GAQL query such as:
//   SELECT segments.date, metrics.impressions, metrics.clicks,
//          metrics.conversions, metrics.cost_micros
//   FROM customer WHERE segments.date BETWEEN '2025-06-01' AND '2025-06-30'
//
// When the real API is wired in, `fetchGoogleAdsReport()` below is the only
// function that needs to change (swap the mock response for an actual
// `customers.googleAds.search` call) — `adaptGoogleAdsReport` already knows
// how to turn that exact JSON into the app's internal `DailyMetric[]`.

export function adaptGoogleAdsReport(response) {
  return response.results.map((row) => ({
    date: row.segments.date,
    impressions: Number(row.metrics.impressions),
    clicks: Number(row.metrics.clicks),
    conversions: Number(row.metrics.conversions),
    spend: Number(row.metrics.costMicros) / 1_000_000,
  }))
}
