// Field-data snapshot (site-wide, all pages) — thresholds match Google's
// published Core Web Vitals rating bands.
export const coreWebVitals = [
  { key: 'lcp', label: 'Largest Contentful Paint', value: 2.8, unit: 's', rating: 'Needs Improvement' },
  { key: 'inp', label: 'Interaction to Next Paint', value: 165, unit: 'ms', rating: 'Good' },
  { key: 'cls', label: 'Cumulative Layout Shift', value: 0.06, unit: '', rating: 'Good' },
]

// Jan-Jun 2025, mirrors the steady organic growth story shown elsewhere in
// Insights (organic sessions up ~18% over the same window).
export const organicTrafficTrend = [
  { month: 'Jan', sessions: 4_200 },
  { month: 'Feb', sessions: 4_550 },
  { month: 'Mar', sessions: 5_100 },
  { month: 'Apr', sessions: 5_680 },
  { month: 'May', sessions: 6_240 },
  { month: 'Jun', sessions: 6_890 },
]

export const topLandingPages = [
  { path: '/storage-units-near-me', sessions: 1_840, avgPosition: 4.2, bounceRate: 38 },
  { path: '/locations/valley-center', sessions: 1_120, avgPosition: 6.8, bounceRate: 41 },
  { path: '/climate-controlled-storage', sessions: 860, avgPosition: 7.1, bounceRate: 35 },
  { path: '/locations/escondido', sessions: 640, avgPosition: 9.4, bounceRate: 44 },
  { path: '/blog/how-big-is-a-10x10-storage-unit', sessions: 520, avgPosition: 5.5, bounceRate: 52 },
  { path: '/locations/temecula', sessions: 410, avgPosition: 11.2, bounceRate: 47 },
]
