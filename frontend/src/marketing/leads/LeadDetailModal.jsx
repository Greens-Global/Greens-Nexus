import { useState } from 'react'
import { Mail, Phone, MapPin, Calendar, Check } from 'lucide-react'
import Modal from '../shared/Modal'
import { formatDateLabel } from '../shared/utils'
import { STAGE_ORDER } from './aggregate'
import { STAFF, UNASSIGNED } from './data'
import { C } from '../theme'

const STAGE_COLOR = {
  New: { color: C.blue600, background: C.blue50, borderColor: C.blue200 },
  Contacted: { color: C.amber600, background: C.amber50, borderColor: C.amber200 },
  Toured: { color: C.purple600, background: C.purple50, borderColor: C.purple200 },
  'Move-In': { color: C.emerald600, background: C.emerald50, borderColor: C.emerald200 },
  Lost: { color: C.red600, background: C.red50, borderColor: C.red200 },
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }

export default function LeadDetailModal({ lead, onClose, onChangeStage, onAssign, onAddNote }) {
  const [noteText, setNoteText] = useState('')
  const [draftStage, setDraftStage] = useState(lead.stage)
  const [draftAssignedTo, setDraftAssignedTo] = useState(lead.assignedTo)
  const [justSaved, setJustSaved] = useState(false)

  const hasChanges = draftStage !== lead.stage || draftAssignedTo !== lead.assignedTo

  function submitNote() {
    if (!noteText.trim()) return
    onAddNote(lead.id, noteText.trim())
    setNoteText('')
  }

  function saveChanges() {
    if (draftStage !== lead.stage) onChangeStage(lead.id, draftStage)
    if (draftAssignedTo !== lead.assignedTo) onAssign(lead.id, draftAssignedTo)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1500)
  }

  return (
    <Modal title={lead.name} onClose={onClose} width="max-w-xl"
      isDirty={hasChanges} onSave={() => { saveChanges(); onClose(); }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13, color: C.gray600, marginBottom: 16 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Mail size={13} color={C.gray400} />
          {lead.email}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Phone size={13} color={C.gray400} />
          {lead.phone}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <MapPin size={13} color={C.gray400} />
          {lead.facility}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={13} color={C.gray400} />
          {formatDateLabel(lead.capturedDate)}
        </span>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Stage</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {STAGE_ORDER.map((s) => {
            const active = draftStage === s
            return (
              <button
                key={s}
                onClick={() => setDraftStage(s)}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = C.white }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 9999,
                  fontSize: 12,
                  fontWeight: 500,
                  border: '1px solid ' + (active ? STAGE_COLOR[s].borderColor : C.gray200),
                  color: active ? STAGE_COLOR[s].color : C.gray400,
                  background: active ? STAGE_COLOR[s].background : C.white,
                  cursor: 'pointer',
                }}
              >
                {s}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Assigned To</label>
        <select
          value={draftAssignedTo}
          onChange={(e) => setDraftAssignedTo(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid ' + C.gray200,
            fontSize: 13,
            color: C.gray700,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        >
          <option value={UNASSIGNED}>{UNASSIGNED}</option>
          {STAFF.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle}>Activity</label>
        <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 12, maxHeight: 224, overflowY: 'auto' }}>
          {lead.notes.map((n, i) => (
            <div key={n.id} style={{ display: 'flex', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 9999, background: C.emerald500, marginTop: 6, boxShadow: '0 0 0 4px ' + C.emerald50 }} />
                {i < lead.notes.length - 1 && <span style={{ width: 1, flex: 1, background: C.gray200, margin: '2px 0' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: C.gray700 }}>{n.author}</span>
                  <span style={{ fontSize: 11, color: C.gray400 }}>{formatDateLabel(n.date)}</span>
                </div>
                <div style={{ fontSize: 12.5, color: C.gray600, background: C.gray50, borderRadius: 8, padding: '8px 10px' }}>{n.text}</div>
              </div>
            </div>
          ))}
          {lead.notes.length === 0 && <div style={{ fontSize: 12.5, color: C.gray400, textAlign: 'center', padding: '12px 0' }}>No activity yet.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitNote()}
            placeholder="Add a note..."
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid ' + C.gray200,
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <button
            onClick={submitNote}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.emerald700 }}
            onMouseLeave={(e) => { e.currentTarget.style.background = C.emerald600 }}
            style={{ padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer' }}
          >
            Add
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingTop: 16, borderTop: '1px solid ' + C.gray100 }}>
        <span style={{ fontSize: 12, color: C.gray400 }}>
          {justSaved ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.emerald600, fontWeight: 500 }}>
              <Check size={13} />
              Saved
            </span>
          ) : hasChanges ? (
            'You have unsaved changes'
          ) : (
            ''
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onClose}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.gray50 }}
            onMouseLeave={(e) => { e.currentTarget.style.background = C.white }}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, fontWeight: 500, color: C.gray600, background: C.white, cursor: 'pointer' }}
          >
            Close
          </button>
          <button
            onClick={saveChanges}
            disabled={!hasChanges}
            onMouseEnter={(e) => { if (hasChanges) e.currentTarget.style.background = C.emerald700 }}
            onMouseLeave={(e) => { if (hasChanges) e.currentTarget.style.background = C.emerald600 }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 8,
              background: C.emerald600,
              color: C.white,
              fontSize: 13,
              fontWeight: 500,
              border: 'none',
              opacity: hasChanges ? 1 : 0.4,
              cursor: hasChanges ? 'pointer' : 'not-allowed',
            }}
          >
            <Check size={14} />
            Save Changes
          </button>
        </div>
      </div>
    </Modal>
  )
}
