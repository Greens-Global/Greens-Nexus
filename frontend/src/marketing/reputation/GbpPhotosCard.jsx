import { useState } from 'react'
import { Plus, AlertTriangle } from 'lucide-react'
import { formatDateLabel } from '../shared/utils'
import { C } from '../theme'

const CATEGORIES = ['ALL', 'EXTERIOR', 'INTERIOR', 'TEAM']
const CATEGORY_LABEL = { ALL: 'All', EXTERIOR: 'Exterior', INTERIOR: 'Interior', TEAM: 'Team' }

function PhotoTile({ p, showFacility }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid ' + C.gray200,
        transition: 'all .15s',
        boxShadow: hovered ? '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)' : 'none',
        transform: hovered ? 'translateY(-2px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={p.url}
        alt=""
        style={{ width: '100%', height: 112, objectFit: 'cover', background: C.gray100, transition: 'transform .2s', transform: hovered ? 'scale(1.05)' : 'none' }}
      />
      <span style={{ position: 'absolute', top: 6, left: 6, padding: '2px 6px', borderRadius: 9999, fontSize: 9.5, fontWeight: 500, background: 'rgba(255,255,255,0.9)', color: C.gray700, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
        {CATEGORY_LABEL[p.category]}
      </span>
      <div style={{ padding: '6px 8px', background: C.white }}>
        {showFacility && <div style={{ fontSize: 10, color: C.gray500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{p.facility}</div>}
        <div style={{ fontSize: 9.5, color: C.gray400 }}>{formatDateLabel(p.uploadedDate)}</div>
      </div>
    </div>
  )
}

export default function GbpPhotosCard({ photos, showFacility, staleWarning, onAddClick }) {
  const [category, setCategory] = useState('ALL')
  const filtered = category === 'ALL' ? photos : photos.filter((p) => p.category === category)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {CATEGORIES.map((c) => {
            const active = category === c
            return (
              <button
                key={c}
                onClick={() => setCategory(c)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 9999,
                  fontSize: 12,
                  fontWeight: 500,
                  border: '1px solid ' + (active ? C.gray900 : C.gray200),
                  background: active ? C.gray900 : C.white,
                  color: active ? C.white : C.gray600,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = C.white }}
              >
                {CATEGORY_LABEL[c]}
              </button>
            )
          })}
        </div>
        <button
          onClick={onAddClick}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 12.5, fontWeight: 500, border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
        >
          <Plus size={13} />
          Add Photo
        </button>
      </div>

      {staleWarning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: C.amber50, color: C.amber700, fontSize: 12 }}>
          <AlertTriangle size={13} />
          {staleWarning}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, maxHeight: 420, overflowY: 'auto', padding: 2 }}>
        {filtered.map((p) => (
          <PhotoTile key={p.id} p={p} showFacility={showFacility} />
        ))}
        {filtered.length === 0 && <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: C.gray400, padding: '32px 0', fontSize: 12.5 }}>No photos in this category.</div>}
      </div>
    </div>
  )
}
