import { daysBetween } from '../shared/utils'
import { UNASSIGNED } from './data'

export const STAGE_ORDER = ['New', 'Contacted', 'Toured', 'Move-In', 'Lost']

export function daysInStage(lead, asOfISO) {
  return Math.max(0, daysBetween(lead.stageChangedDate, asOfISO) - 1)
}

export function filterLeads(leads, filters) {
  return leads.filter(
    (l) =>
      (!filters.facility || l.facility === filters.facility) &&
      (!filters.source || l.source === filters.source) &&
      (!filters.assignedTo || l.assignedTo === filters.assignedTo),
  )
}

export function groupByStage(leads) {
  const groups = { New: [], Contacted: [], Toured: [], 'Move-In': [], Lost: [] }
  for (const l of leads) groups[l.stage].push(l)
  return groups
}

export function computeLeadStats(leads) {
  const total = leads.length
  const moveIns = leads.filter((l) => l.stage === 'Move-In').length
  const lost = leads.filter((l) => l.stage === 'Lost').length
  const active = total - moveIns - lost
  const unassigned = leads.filter((l) => l.assignedTo === UNASSIGNED).length
  const resolved = moveIns + lost
  return {
    total,
    active,
    moveIns,
    lost,
    conversionRate: resolved > 0 ? (moveIns / resolved) * 100 : 0,
    unassigned,
  }
}
