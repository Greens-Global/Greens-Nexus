import { useMemo, useState } from 'react'
import LeadsHeader from './LeadsHeader'
import LeadsStatCards from './LeadsStatCards'
import LeadsOverviewCharts from './LeadsOverviewCharts'
import KanbanBoard from './KanbanBoard'
import LeadDetailModal from './LeadDetailModal'
import AddLeadModal from './AddLeadModal'
import { initialLeads, ALL_SOURCES } from './data'
import { computeLeadStats, filterLeads } from './aggregate'
import { ALL_PROPERTIES } from '../shared/facilities'
import { ANCHOR_DATE, downloadCSV, formatDateLabel } from '../shared/utils'

export default function LeadsPage({ onNavigate, alerts, insights, onClearAlert }) {
  const [leads, setLeads] = useState(initialLeads)
  const [property, setProperty] = useState(ALL_PROPERTIES)
  const [source, setSource] = useState(ALL_SOURCES)
  const [selectedLead, setSelectedLead] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  const scoped = useMemo(
    () =>
      filterLeads(leads, {
        facility: property === ALL_PROPERTIES ? null : property,
        source: source === ALL_SOURCES ? null : source,
      }),
    [leads, property, source],
  )
  const stats = useMemo(() => computeLeadStats(scoped), [scoped])

  function changeStage(id, stage) {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, stage, stageChangedDate: ANCHOR_DATE } : l)))
    setSelectedLead((prev) => (prev && prev.id === id ? { ...prev, stage, stageChangedDate: ANCHOR_DATE } : prev))
  }

  function assign(id, assignedTo) {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, assignedTo } : l)))
    setSelectedLead((prev) => (prev && prev.id === id ? { ...prev, assignedTo } : prev))
  }

  function addNote(id, text) {
    setLeads((prev) =>
      prev.map((l) =>
        l.id === id ? { ...l, notes: [...l.notes, { id: `note-${l.notes.length}`, date: ANCHOR_DATE, author: l.assignedTo, text }] } : l,
      ),
    )
    setSelectedLead((prev) =>
      prev && prev.id === id
        ? { ...prev, notes: [...prev.notes, { id: `note-${prev.notes.length}`, date: ANCHOR_DATE, author: prev.assignedTo, text }] }
        : prev,
    )
  }

  function addLead(input) {
    const today = ANCHOR_DATE
    const lead = {
      id: `lead-custom-${Date.now()}`,
      ...input,
      stage: 'New',
      capturedDate: today,
      stageChangedDate: today,
      assignedTo: 'Unassigned',
      notes: [],
    }
    setLeads((prev) => [lead, ...prev])
  }

  function downloadReport() {
    const rows = [
      ['Leads Report'],
      [`Property: ${property}`],
      [],
      ['Name', 'Email', 'Phone', 'Facility', 'Source', 'Stage', 'Assigned To', 'Captured'],
      ...scoped.map((l) => [l.name, l.email, l.phone, l.facility, l.source, l.stage, l.assignedTo, formatDateLabel(l.capturedDate)]),
    ]
    downloadCSV('leads-report.csv', rows)
  }

  return (
    <div>
      <LeadsHeader
        property={property}
        onPropertyChange={setProperty}
        source={source}
        onSourceChange={setSource}
        onDownload={downloadReport}
        onAddLead={() => setShowAdd(true)}
        onNavigate={onNavigate}
        alerts={alerts}
        insights={insights}
        onClearAlert={onClearAlert}
      />

      <LeadsStatCards stats={stats} />

      <LeadsOverviewCharts leads={scoped} />

      <KanbanBoard leads={scoped} onSelectLead={setSelectedLead} onChangeStage={changeStage} />

      {selectedLead && (
        <LeadDetailModal
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onChangeStage={changeStage}
          onAssign={assign}
          onAddNote={addNote}
        />
      )}

      {showAdd && <AddLeadModal onAdd={addLead} onClose={() => setShowAdd(false)} />}
    </div>
  )
}
