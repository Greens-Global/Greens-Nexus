export const ANCHOR_DATE = '2025-06-30'
export const DATA_START = '2025-01-01'
export const DATA_END = '2025-06-30'

export function toISO(d) {
  return d.toISOString().slice(0, 10)
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function addDays(iso, days) {
  const d = parseISO(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return toISO(d)
}

export function daysBetween(start, end) {
  const ms = parseISO(end).getTime() - parseISO(start).getTime()
  return Math.round(ms / 86400000) + 1
}

export function clampToDataRange(iso) {
  if (iso < DATA_START) return DATA_START
  if (iso > DATA_END) return DATA_END
  return iso
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

// U.S.-formatted numeric date, YYYY/MM/DD - the one date format used
// everywhere across the Marketing module (filters, charts, tables, reviews,
// reports, and exports) so a date reads the same no matter where it shows up.
export function formatDateFromDate(d) {
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`
}

// Same YYYY/MM/DD format, for Date objects carrying a real local time
// (e.g. a review's post timestamp) rather than a UTC-normalized calendar date.
export function formatLocalDateUS(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
}

export function formatYearMonthFromDate(d) {
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}`
}

export function formatDateUS(iso) {
  return formatDateFromDate(parseISO(iso))
}

export function formatDateLabel(iso) {
  return formatDateUS(iso)
}

export function formatRangeLabel(range) {
  return `${formatDateLabel(range.start)} - ${formatDateLabel(range.end)}`
}

export function formatDateShort(iso) {
  return formatDateUS(iso)
}

export function formatMonthLabel(iso) {
  const d = parseISO(iso)
  return d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
}

export function formatRangeLabelShort(range) {
  return `${formatDateShort(range.start)} - ${formatDateShort(range.end)}`
}

// Compact MM/YYYY range for the "vs …" helper on KPI cards - the full
// MM/DD/YYYY range is too wide for the narrow 7-column cards, so this drops the
// day and keeps just month/year on the card's own full-width line.
export function formatRangeLabelMonthYear(range) {
  const my = (iso) => {
    const d = parseISO(iso)
    return `${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
  }
  return `${my(range.start)} - ${my(range.end)}`
}

export function daysInMonthOf(iso) {
  const d = parseISO(iso)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

// Fraction of the calendar month that `range` covers, used to extrapolate a
// partial-month total (e.g. "Last 7 Days") into a projected month-end value.
// Ranges spanning more than one calendar month return 1 (no extrapolation).
export function monthCoverageFraction(range) {
  const s = parseISO(range.start)
  const e = parseISO(range.end)
  if (s.getUTCFullYear() !== e.getUTCFullYear() || s.getUTCMonth() !== e.getUTCMonth()) return 1
  return Math.min(1, daysBetween(range.start, range.end) / daysInMonthOf(range.start))
}

function isFullCalendarMonth(range) {
  const s = parseISO(range.start)
  const e = parseISO(range.end)
  if (s.getUTCFullYear() !== e.getUTCFullYear() || s.getUTCMonth() !== e.getUTCMonth()) return false
  const lastDay = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0)).getUTCDate()
  return s.getUTCDate() === 1 && e.getUTCDate() === lastDay
}

export function getPreviousPeriod(range) {
  if (isFullCalendarMonth(range)) {
    const s = parseISO(range.start)
    return monthRange(s.getUTCFullYear(), s.getUTCMonth() - 1)
  }
  const len = daysBetween(range.start, range.end)
  const prevEnd = addDays(range.start, -1)
  const prevStart = addDays(prevEnd, -(len - 1))
  return { start: prevStart, end: prevEnd }
}

export function lastNDays(n) {
  return { start: addDays(ANCHOR_DATE, -(n - 1)), end: ANCHOR_DATE }
}

export function monthRange(year, month) {
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0))
  return { start: toISO(start), end: toISO(end) }
}

export function thisMonth() {
  const d = parseISO(ANCHOR_DATE)
  return monthRange(d.getUTCFullYear(), d.getUTCMonth())
}

export function lastMonth() {
  const d = parseISO(ANCHOR_DATE)
  return monthRange(d.getUTCFullYear(), d.getUTCMonth() - 1)
}

export function formatNumber(n) {
  return Math.round(n).toLocaleString('en-US')
}

export function formatCurrency(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatPercent(n, digits = 2) {
  return `${n.toFixed(digits)}%`
}

export function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100
  return ((current - previous) / previous) * 100
}

export function downloadCSV(filename, rows) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
