import { useState } from 'react'
import { ANCHOR_DATE } from '../shared/utils'
import { daysInStage } from './aggregate'
import { UNASSIGNED } from './data'
import { C, shadowMd } from '../theme'

const SOURCE_DOT = {
  'Google Ads': C.blue500,
  Direct: C.gray500,
  'Organic Search': C.emerald500,
  Referral: C.amber500,
  'Social Media': C.purple500,
  'Google Business Profile': C.teal500,
}

const SOURCE_BORDER = {
  'Google Ads': C.blue500,
  Direct: C.gray400,
  'Organic Search': C.emerald500,
  Referral: C.amber500,
  'Social Media': C.purple500,
  'Google Business Profile': C.teal500,
}

const SHADOW_SM = '0 1px 2px 0 rgba(0,0,0,0.05)'

function initials(name) {
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export default function LeadCard({ lead, onClick }) {
  const days = daysInStage(lead, ANCHOR_DATE)
  const [dragging, setDragging] = useState(false)

  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', lead.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderTopColor = C.gray300
        e.currentTarget.style.borderRightColor = C.gray300
        e.currentTarget.style.borderBottomColor = C.gray300
        e.currentTarget.style.boxShadow = shadowMd
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderTopColor = C.gray200
        e.currentTarget.style.borderRightColor = C.gray200
        e.currentTarget.style.borderBottomColor = C.gray200
        e.currentTarget.style.boxShadow = SHADOW_SM
      }}
      style={{
        width: '100%',
        textAlign: 'left',
        borderRadius: 8,
        borderStyle: 'solid',
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 3,
        borderTopColor: C.gray200,
        borderRightColor: C.gray200,
        borderBottomColor: C.gray200,
        borderLeftColor: SOURCE_BORDER[lead.source],
        background: C.white,
        padding: 10,
        boxShadow: SHADOW_SM,
        transition: 'all .15s',
        cursor: 'grab',
        opacity: dragging ? 0.4 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: C.gray900, lineHeight: 1.25 }}>{lead.name}</span>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 9999,
            background: C.gray100,
            color: C.gray600,
            fontSize: 9.5,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          title={lead.assignedTo}
        >
          {lead.assignedTo === UNASSIGNED ? '—' : initials(lead.assignedTo)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: C.gray500, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.facility}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10.5, color: C.gray400 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 9999, background: SOURCE_DOT[lead.source] }} />
          {lead.source}
        </span>
        <span>{days === 0 ? 'today' : `${days}d`}</span>
      </div>
    </button>
  )
}
