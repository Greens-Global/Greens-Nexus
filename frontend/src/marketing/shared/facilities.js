export const FACILITIES = ['Greens Valley Center', 'Greens Escondido', 'Greens Temecula', 'Greens Fairfield', 'Greens Georgetown']
export const ALL_PROPERTIES = 'All Properties'

// Groups properties into the local metro areas they actually serve, so
// location-aware features (e.g. SEO keyword research) can scope down to
// "San Diego Area" and get every facility that competes in that market.
export const REGIONS = [
  { name: 'San Diego Area', facilities: ['Greens Valley Center', 'Greens Escondido', 'Greens Temecula'] },
  { name: 'Sacramento / Bay Area', facilities: ['Greens Fairfield', 'Greens Georgetown'] },
]
export const ALL_REGIONS = 'All Regions'
