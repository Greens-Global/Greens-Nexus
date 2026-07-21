import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import CampaignTable from './CampaignTable'
import Modal from './Modal'
import { C } from '../theme'

export default function TopCampaignsCard({ campaigns, onToggleStatus }) {
  const [showAll, setShowAll] = useState(false)
  const top5 = [...campaigns].sort((a, b) => b.spend - a.spend).slice(0, 5)

  return (
    <div className="mktg-card" style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Top Campaigns</h3>
      <div style={{ flex: 1 }}>
        <CampaignTable campaigns={top5} onToggleStatus={onToggleStatus} showStatus={false} />
      </div>
      <button
        onClick={() => setShowAll(true)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 500, color: C.emerald600, marginTop: 12 }}
        onMouseEnter={(e) => (e.currentTarget.style.color = C.emerald700)}
        onMouseLeave={(e) => (e.currentTarget.style.color = C.emerald600)}
      >
        View all campaigns
        <ArrowRight size={13} />
      </button>

      {showAll && (
        <Modal title={`All Campaigns (${campaigns.length})`} onClose={() => setShowAll(false)} width="max-w-4xl">
          <CampaignTable campaigns={campaigns} onToggleStatus={onToggleStatus} searchable />
        </Modal>
      )}
    </div>
  )
}
