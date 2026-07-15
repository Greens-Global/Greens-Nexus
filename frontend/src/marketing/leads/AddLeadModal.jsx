import { useState } from 'react'
import Modal from '../shared/Modal'
import { FACILITIES } from '../shared/facilities'
import { SOURCES } from './data'
import { C } from '../theme'

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }
const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid ' + C.gray200,
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

export default function AddLeadModal({ onAdd, onClose }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [facility, setFacility] = useState(FACILITIES[0])
  const [source, setSource] = useState('Direct')

  const disabled = !name.trim()

  function submit() {
    if (!name.trim()) return
    onAdd({ name: name.trim(), email: email.trim(), phone: phone.trim(), facility, source })
    onClose()
  }

  return (
    <Modal title="Add Lead" onClose={onClose} width="max-w-md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={labelStyle}>Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Phone</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(916) 555-0100"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Facility</label>
          <select
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            style={{ ...inputStyle, color: C.gray700 }}
          >
            {FACILITIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Source</label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ ...inputStyle, color: C.gray700 }}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={submit}
          disabled={disabled}
          onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = C.emerald700 }}
          onMouseLeave={(e) => { e.currentTarget.style.background = C.emerald600 }}
          style={{
            marginTop: 4,
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            background: C.emerald600,
            color: C.white,
            fontSize: 13,
            fontWeight: 500,
            border: 'none',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          Add Lead
        </button>
      </div>
    </Modal>
  )
}
