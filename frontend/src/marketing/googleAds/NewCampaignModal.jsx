import { useState } from 'react'
import Modal from './Modal'
import { FACILITIES } from '../shared/facilities'
import { C } from '../theme'

export const GOOGLE_CHANNELS = ['Google Search', 'Google Display', 'Google Shopping', 'Google Remarketing', 'Google Local', 'YouTube Ads']

const labelStyle = { display: 'block', fontSize: 12.5, fontWeight: 500, color: C.gray600, marginBottom: 6 }
const fieldStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, outline: 'none' }

export default function NewCampaignModal({ onClose, onCreate, defaultFacility }) {
  const channels = GOOGLE_CHANNELS
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState(channels[0])
  const [facility, setFacility] = useState(defaultFacility ?? FACILITIES[0])
  const [budget, setBudget] = useState('')
  const [error, setError] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Campaign name is required.')
      return
    }
    const spend = Number(budget) || 0
    if (spend < 0) {
      setError('Budget must be a positive number.')
      return
    }
    onCreate({
      id: `c${Date.now()}`,
      name: name.trim(),
      platform,
      facility,
      spend,
      clicks: 0,
      conversions: 0,
      impressions: 0,
      status: 'Active',
    })
    onClose()
  }

  return (
    <Modal title="New Campaign" onClose={onClose} width="max-w-md">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Campaign Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Storage - Fall Promo"
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={fieldStyle}>
            {channels.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Property / Facility</label>
          <select value={facility} onChange={(e) => setFacility(e.target.value)} style={fieldStyle}>
            {FACILITIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Initial Budget ($)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="0.00"
            style={fieldStyle}
          />
        </div>
        {error && <div style={{ fontSize: 12.5, color: C.red500 }}>{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: C.gray600, background: 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={{ padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
          >
            Create Campaign
          </button>
        </div>
      </form>
    </Modal>
  )
}
