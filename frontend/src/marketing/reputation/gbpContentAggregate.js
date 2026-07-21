import { FACILITIES, ALL_PROPERTIES } from '../shared/facilities'
import { ANCHOR_DATE, daysBetween } from '../shared/utils'

function scoped(rows, property) {
  return property === ALL_PROPERTIES ? rows : rows.filter((r) => r.facility === property)
}

export function postsForProperty(posts, property) {
  return scoped(posts, property).sort((a, b) => (a.createdDate < b.createdDate ? 1 : -1))
}

export function photosForProperty(photos, property) {
  return scoped(photos, property).sort((a, b) => (a.uploadedDate < b.uploadedDate ? 1 : -1))
}

export function questionsForProperty(questions, property) {
  return scoped(questions, property).sort((a, b) => (a.askedDate < b.askedDate ? 1 : -1))
}

export function unansweredCount(questions, property) {
  return scoped(questions, property).filter((q) => !q.answer).length
}

// Days since the most recent photo was added, per property. Returns null
// for a property with no photos at all (treated as "very stale" by callers).
export function daysSinceLastPhoto(photos, facility) {
  const rows = photos.filter((p) => p.facility === facility)
  if (rows.length === 0) return null
  const latest = rows.reduce((a, b) => (a.uploadedDate > b.uploadedDate ? a : b))
  return daysBetween(latest.uploadedDate, ANCHOR_DATE) - 1
}

export const STALE_PHOTO_THRESHOLD_DAYS = 60

export function stalePhotoProperties(photos) {
  return FACILITIES.filter((f) => {
    const days = daysSinceLastPhoto(photos, f)
    return days === null || days >= STALE_PHOTO_THRESHOLD_DAYS
  })
}
