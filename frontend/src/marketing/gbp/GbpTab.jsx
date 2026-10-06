import { useState } from 'react'
import { SkeletonBlocks } from '../../components/AsyncState'
import MarketingTabBar from '../shared/MarketingTabBar'
import { C } from '../theme'
import GbpConnectionBar from './GbpConnectionBar'
import GoogleReviewsPanel from './GoogleReviewsPanel'
import GoogleListingsPanel from './GoogleListingsPanel'
import { useGbpStatus, useGbpPermissions } from './useGbp'

const INTRO = {
  reputation: 'Every Google review across the locations. Reply, edit or delete from here - Nexus records who answered, which Google does not show.',
  listings: 'How each location performs on Google, and its listing: description, phone, website, hours, posts and photos, plus the link that asks customers for a review.',
}

// Reputation and Business Profile both start here. Connected to Google ->
// the real locations and reviews. Not connected (or no Marketing grant) ->
// the existing sample page, with the connection bar above it saying so.
export default function GbpTab({ tab, tabBarProps, renderSample }) {
  const gbp = useGbpStatus()
  const perms = useGbpPermissions()
  const [reloadKey, setReloadKey] = useState(0)
  const bar = <GbpConnectionBar gbp={gbp} onSynced={() => setReloadKey((k) => k + 1)} />

  if (gbp.loading) {
    return (
      <div>
        <div style={{ marginBottom: 20 }}><MarketingTabBar active={tab} {...tabBarProps} /></div>
        <SkeletonBlocks count={3} height={120} />
      </div>
    )
  }

  if (!gbp.status?.connected) return renderSample(bar)

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <MarketingTabBar active={tab} {...tabBarProps} />
        <p style={{ fontSize: 13, color: C.gray500, marginTop: 16, maxWidth: 720 }}>{INTRO[tab]}</p>
      </div>
      {bar}
      {tab === 'reputation'
        ? <GoogleReviewsPanel canReply={perms.canReply} reloadKey={reloadKey} />
        : <GoogleListingsPanel canEdit={perms.canEditListing} canPost={perms.canReply} reloadKey={reloadKey} />}
    </div>
  )
}
