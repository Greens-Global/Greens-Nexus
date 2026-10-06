// Google Business Profile hours <-> a simple per-day form.
//
// Google's shape (Business Information API):
//   regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 9, minutes: 30 },
//                               closeDay: 'MONDAY', closeTime: { hours: 17 } }] }
//   specialHours: { specialHourPeriods: [{ startDate: { year, month, day }, closed: true }
//                                        | { startDate, openTime, closeTime }] }
// Zero fields are omitted by Google (minutes: 0 never appears; midnight is {}).
//
// The form edits one open-close span per day. Anything it cannot show
// faithfully - split hours, a span past midnight, open 24 hours, a holiday
// covering several days - marks the hours `complex`, and the form leaves them
// alone (edit those in Google) rather than flatten them on save.

export const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
export const DAY_LABEL = {
  MONDAY: 'Monday', TUESDAY: 'Tuesday', WEDNESDAY: 'Wednesday', THURSDAY: 'Thursday',
  FRIDAY: 'Friday', SATURDAY: 'Saturday', SUNDAY: 'Sunday',
}

const pad = (n) => String(n).padStart(2, '0')

export function timeToInput(t) {
  if (!t) return '00:00'
  return `${pad(t.hours || 0)}:${pad(t.minutes || 0)}`
}

export function inputToTime(s) {
  const [h, m] = (s || '00:00').split(':').map(Number)
  return { ...(h ? { hours: h } : {}), ...(m ? { minutes: m } : {}) }
}

export function regularToForm(regularHours) {
  const periods = regularHours?.periods || []
  const byDay = {}
  let complex = false
  for (const p of periods) {
    if (p.openDay !== p.closeDay || (p.closeTime && p.closeTime.hours === 24) || byDay[p.openDay]) complex = true
    byDay[p.openDay] = p
  }
  const days = DAYS.map((day) => {
    const p = byDay[day]
    return p
      ? { day, closed: false, open: timeToInput(p.openTime), close: timeToInput(p.closeTime) }
      : { day, closed: true, open: '09:00', close: '17:00' }
  })
  return { days, complex, hasHours: periods.length > 0 }
}

export function formToRegular(days) {
  return {
    periods: days.filter((d) => !d.closed).map((d) => ({
      openDay: d.day, openTime: inputToTime(d.open), closeDay: d.day, closeTime: inputToTime(d.close),
    })),
  }
}

const dateToInput = (d) => (d ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : '')
const inputToDate = (s) => {
  const [year, month, day] = (s || '').split('-').map(Number)
  return { year, month, day }
}

export function specialToForm(specialHours) {
  const periods = specialHours?.specialHourPeriods || []
  let complex = false
  const rows = periods.map((p) => {
    if (p.endDate && dateToInput(p.endDate) !== dateToInput(p.startDate)) complex = true
    return {
      date: dateToInput(p.startDate),
      closed: !!p.closed,
      open: p.closed ? '09:00' : timeToInput(p.openTime),
      close: p.closed ? '17:00' : timeToInput(p.closeTime),
    }
  })
  return { rows, complex }
}

export function formToSpecial(rows) {
  return {
    specialHourPeriods: rows.filter((r) => r.date).map((r) => (
      r.closed
        ? { startDate: inputToDate(r.date), closed: true }
        : { startDate: inputToDate(r.date), openTime: inputToTime(r.open), endDate: inputToDate(r.date), closeTime: inputToTime(r.close) }
    )),
  }
}

// A row the form would send that Google would refuse.
export function hoursProblem(days, rows) {
  for (const d of days) {
    if (!d.closed && d.open >= d.close) return `${DAY_LABEL[d.day]} closes before it opens.`
  }
  for (const r of rows) {
    if (!r.date) return 'Every holiday needs a date.'
    if (!r.closed && r.open >= r.close) return 'A holiday closes before it opens.'
  }
  return ''
}
