export const FACILITIES = ['Greens Valley Center', 'Greens Escondido', 'Greens Temecula', 'Greens Fairfield', 'Greens Georgetown']
export const ALL_PROPERTIES = 'All Properties'

// "Greens Valley Center" -> matches a campaign called "Valley Center - Brand".
export function suggestFacility(campaignName) {
  const name = (campaignName || '').toLowerCase()
  return FACILITIES.find((f) => name.includes(f.replace(/^Greens\s+/i, '').toLowerCase())) || ''
}

// Groups properties into the local metro areas they actually serve, so
// location-aware features (e.g. SEO keyword research) can scope down to
// "San Diego Area" and get every facility that competes in that market.
export const REGIONS = [
  { name: 'San Diego Area', facilities: ['Greens Valley Center', 'Greens Escondido', 'Greens Temecula'] },
  { name: 'Sacramento / Bay Area', facilities: ['Greens Fairfield', 'Greens Georgetown'] },
]
export const ALL_REGIONS = 'All Regions'
