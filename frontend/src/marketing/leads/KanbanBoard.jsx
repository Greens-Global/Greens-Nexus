import { useState } from 'react'
import LeadCard from './LeadCard'
import { STAGE_ORDER, groupByStage } from './aggregate'
import { C, alpha } from '../theme'

const STAGE_COLOR = {
  New: { color: C.blue600, background: C.blue50 },
  Contacted: { color: C.amber600, background: C.amber50 },
  Toured: { color: C.purple600, background: C.purple50 },
  'Move-In': { color: C.emerald600, background: C.emerald50 },
  Lost: { color: C.red600, background: C.red50 },
}

export default function KanbanBoard({ leads, onSelectLead, onChangeStage }) {
  const groups = groupByStage(leads)
  const [dragOverStage, setDragOverStage] = useState(null)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: 12 }}>
      {STAGE_ORDER.map((stage) => {
        const over = dragOverStage === stage
        return (
          <div
            key={stage}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOverStage !== stage) setDragOverStage(stage)
            }}
            onDragLeave={() => setDragOverStage((prev) => (prev === stage ? null : prev))}
            onDrop={(e) => {
              e.preventDefault()
              const id = e.dataTransfer.getData('text/plain')
              if (id) onChangeStage(id, stage)
              setDragOverStage(null)
            }}
            style={{
              borderRadius: 12,
              border: '1px solid ' + (over ? C.gray400 : C.gray200),
              background: over ? C.gray100 : alpha(C.gray50, 0.6),
              padding: 10,
              minHeight: 200,
              transition: 'all .15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 2px' }}>
              <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 9999, ...STAGE_COLOR[stage] }}>{stage}</span>
              <span style={{ fontSize: 11, color: C.gray400, fontWeight: 500 }}>{groups[stage].length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {groups[stage].map((lead) => (
                <LeadCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)} />
              ))}
              {groups[stage].length === 0 && <div style={{ textAlign: 'center', fontSize: 11.5, color: C.gray300, padding: '24px 0' }}>No leads</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
