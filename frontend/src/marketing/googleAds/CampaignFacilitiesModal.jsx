import { useEffect, useMemo, useState } from 'react'
import Modal from './Modal'
import { api } from '../../api'
import { SkeletonBlocks } from '../../components/AsyncState'
import { FACILITIES, suggestFacility } from '../shared/facilities'
import { C } from '../theme'

const UNASSIGNED = 'Unassigned'

const select = { width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12.5, background: C.white }

// Which property each Google Ads campaign counts toward. Google has no idea
// what our properties are, so this is set once per campaign in Nexus; an
// unmapped campaign counts as Unassigned. Unmapped campaigns start with a
// suggestion from their name - nothing is saved until Save.
export default function CampaignFacilitiesModal({ onClose, onSaved }) {
  const [campaigns, setCampaigns] = useState(null)
  const [choice, setChoice] = useState({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getAdsCampaigns()
      .then((rows) => {
        setCampaigns(rows || [])
        setChoice(Object.fromEntries((rows || []).map((c) => [c.id, c.facility || suggestFacility(c.name)])))
      })
      .catch((e) => setError(e?.message || 'The campaigns could not be loaded.'))
  }, [])

  const changes = useMemo(
    () => (campaigns || []).filter((c) => (choice[c.id] || '') !== (c.facility || '')).map((c) => ({ id: c.id, facility: choice[c.id] || '' })),
    [campaigns, choice],
  )

  async function save() {
    if (!changes.length) { onClose(); return }
    setSaving(true)
    setError('')
    try {
      await api.mapAdsCampaigns(changes)
      onSaved()
    } catch (e) {
      setError(e?.message || 'The mapping could not be saved - please try again.')
      setSaving(false)
    }
  }

  return (
    <Modal title="Map Campaigns to Properties" onClose={onClose} width="max-w-3xl" isDirty={changes.length > 0} onSave={save}>
      <p style={{ fontSize: 12.5, color: C.gray500, marginBottom: 12 }}>
        Each campaign's spend counts toward the property chosen here. Suggestions come from the campaign name - check them before saving.
      </p>
      {campaigns === null && !error && <SkeletonBlocks count={3} height={36} borderRadius={8} />}
      {campaigns && campaigns.length === 0 && (
        <div style={{ fontSize: 12.5, color: C.gray400, padding: '16px 0' }}>No campaigns have synced from Google Ads yet.</div>
      )}
      {campaigns && campaigns.length > 0 && (
        <div style={{ borderRadius: 8, border: '1px solid ' + C.gray100, overflow: 'hidden', maxHeight: '55vh', overflowY: 'auto' }}>
          {campaigns.map((c, i) => {
            const suggested = !c.facility && choice[c.id]
            return (
              <div key={c.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 10, padding: '8px 12px', alignItems: 'center', borderTop: i === 0 ? 'none' : '1px solid ' + C.gray100 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: C.gray900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: C.gray400 }}>
                    {[c.account, c.platform, c.status].filter(Boolean).join(' · ')}
                    {suggested && <span style={{ color: C.amber600 }}> · Suggested</span>}
                  </div>
                </div>
                <select value={choice[c.id] || ''} onChange={(e) => setChoice((p) => ({ ...p, [c.id]: e.target.value }))}
                        style={select} aria-label={`Property for ${c.name}`}>
                  <option value="">{UNASSIGNED}</option>
                  {FACILITIES.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            )
          })}
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 12.5, color: C.red600, marginTop: 10 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button type="button" onClick={onClose} style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: C.gray600 }}>Cancel</button>
        <button type="button" onClick={save} disabled={saving || !campaigns}
                style={{ padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500, opacity: saving || !campaigns ? 0.6 : 1 }}>
          {saving ? 'Saving...' : changes.length ? `Save ${changes.length} Change${changes.length === 1 ? '' : 's'}` : 'Done'}
        </button>
      </div>
    </Modal>
  )
}
