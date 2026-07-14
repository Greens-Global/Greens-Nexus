import { useState } from 'react'
import { Search, ChevronLeft } from 'lucide-react'
import Modal from './Modal'
import { GOOGLE_CHANNELS, YELP_CHANNELS } from './NewCampaignModal'
import { FACILITIES } from '../shared/facilities'
import { formatNumber } from './utils'
import { C } from '../theme'

const STATUSES = ['Active', 'Paused', 'Completed']

const labelStyle = { display: 'block', fontSize: 12.5, fontWeight: 500, color: C.gray600, marginBottom: 6 }
const fieldStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, outline: 'none' }

export default function EditCampaignModal({ platform, campaigns, initialCampaignId, onClose, onSave }) {
  const channels = platform === 'google' ? GOOGLE_CHANNELS : YELP_CHANNELS
  const [selectedId, setSelectedId] = useState(initialCampaignId ?? null)
  const [query, setQuery] = useState('')

  const selected = campaigns.find((c) => c.id === selectedId) ?? null

  const [name, setName] = useState(selected?.name ?? '')
  const [facility, setFacility] = useState(selected?.facility ?? FACILITIES[0])
  const [channel, setChannel] = useState(selected?.platform ?? channels[0])
  const [status, setStatus] = useState(selected?.status ?? 'Active')
  const [budget, setBudget] = useState(String(selected?.spend ?? 0))
  const [error, setError] = useState('')

  function selectCampaign(c) {
    setSelectedId(c.id)
    setName(c.name)
    setFacility(c.facility)
    setChannel(c.platform)
    setStatus(c.status)
    setBudget(String(c.spend))
  }

  function handleSave(e) {
    e.preventDefault()
    if (!selected || !name.trim()) return
    const spend = Number(budget)
    if (Number.isNaN(spend) || spend < 0) {
      setError('Budget must be a positive number.')
      return
    }
    onSave(selected.id, { name: name.trim(), facility, platform: channel, status, spend })
    onClose()
  }

  const filtered = query.trim() ? campaigns.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())) : campaigns

  if (!selected) {
    return (
      <Modal title="Edit Campaign" onClose={onClose} width="max-w-md">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} color={C.gray400} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search campaigns..."
              style={{ ...fieldStyle, paddingLeft: 36 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => selectCampaign(c)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left', padding: '8px 12px', borderRadius: 8, background: 'transparent' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: C.gray900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: C.gray400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.facility}</div>
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    marginLeft: 8,
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 10.5,
                    fontWeight: 500,
                    ...(c.status === 'Active'
                      ? { background: C.gray900, color: C.white }
                      : c.status === 'Paused'
                      ? { background: C.gray100, color: C.gray500 }
                      : { background: C.blue50, color: C.blue600 }),
                  }}
                >
                  {c.status}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <div style={{ textAlign: 'center', color: C.gray400, fontSize: 12.5, padding: '24px 0' }}>No campaigns match your search.</div>}
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Edit Campaign" onClose={onClose} width="max-w-md">
      <button
        onClick={() => setSelectedId(null)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: C.gray500, marginBottom: 12 }}
        onMouseEnter={(e) => (e.currentTarget.style.color = C.gray700)}
        onMouseLeave={(e) => (e.currentTarget.style.color = C.gray500)}
      >
        <ChevronLeft size={13} />
        Choose a different campaign
      </button>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Campaign Name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} />
        </div>
        <div>
          <label style={labelStyle}>Platform</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} style={fieldStyle}>
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
          <label style={labelStyle}>Status</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {STATUSES.map((s) => {
              const active = status === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: '1px solid ' + (active ? C.gray900 : C.gray200),
                    fontSize: 12.5,
                    fontWeight: 500,
                    background: active ? C.gray900 : 'transparent',
                    color: active ? C.white : C.gray600,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  {s}
                </button>
              )
            })}
          </div>
        </div>
        <div>
          <label style={labelStyle}>Budget ($)</label>
          <input type="number" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} style={fieldStyle} />
        </div>
        {error && <div style={{ fontSize: 12.5, color: C.red500 }}>{error}</div>}

        <div style={{ borderRadius: 8, background: C.gray50, border: '1px solid ' + C.gray100, padding: 12, display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8, fontSize: 12 }}>
          <div>
            <div style={{ color: C.gray400 }}>Clicks</div>
            <div style={{ fontWeight: 500, color: C.gray700 }}>{formatNumber(selected.clicks)}</div>
          </div>
          <div>
            <div style={{ color: C.gray400 }}>Conversions</div>
            <div style={{ fontWeight: 500, color: C.gray700 }}>{formatNumber(selected.conversions)}</div>
          </div>
          <div>
            <div style={{ color: C.gray400 }}>Impressions</div>
            <div style={{ fontWeight: 500, color: C.gray700 }}>{formatNumber(selected.impressions)}</div>
          </div>
        </div>
        <p style={{ fontSize: 11, color: C.gray400, marginTop: -8 }}>Clicks, conversions, and impressions are tracked automatically and can't be edited.</p>

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
            Save Changes
          </button>
        </div>
      </form>
    </Modal>
  )
}
