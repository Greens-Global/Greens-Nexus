import { useMemo, useRef, useState } from 'react'
import { SkeletonBlocks } from '../../components/AsyncState'
import MarketingTabBar from '../shared/MarketingTabBar'
import { C } from '../theme'
import GbpConnectionBar from './GbpConnectionBar'
import GoogleReviewsPanel from './GoogleReviewsPanel'
import GoogleListingsPanel from './GoogleListingsPanel'
import ReputationOverview from './ReputationOverview'
import { useGbpStatus, useGbpPermissions, useGbpReviewFeed } from './useGbp'

const INTRO = {
  reputation: 'Every Google review across the locations. Reply, edit or delete from here - Nexus records who answered, which Google does not show.',
  listings: 'How each location performs on Google, and its listing: description, phone, website, hours, posts and photos, plus the link that asks customers for a review.',
}

// Connected Reputation: the charts over every real review, then the review
// list. A word picked in the cloud searches the whole list (All Reviews) and
// brings it into view.
function ConnectedReputation({ canReply, reloadKey }) {
  const feed = useGbpReviewFeed(reloadKey)
  const [filter, setFilter] = useState('no')
  const [query, setQuery] = useState('')
  const listRef = useRef(null)
  const charts = !feed.loading && feed.reviews?.length > 0
  const locationNames = useMemo(() => [...new Set((feed.reviews || []).map((r) => r.facility))], [feed.reviews])

  function pickWord(word) {
    setQuery(word || '')
    if (word) {
      setFilter('')
      listRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <>
      {feed.loading && <div style={{ marginBottom: 16 }}><SkeletonBlocks count={2} height={120} /></div>}
      {charts && (
        <ReputationOverview reviews={feed.reviews} locationNames={locationNames} activeWord={query.trim()} onSelectWord={pickWord} />
      )}
      <div ref={listRef}>
        <GoogleReviewsPanel canReply={canReply} reloadKey={reloadKey} showStats={!charts && !feed.loading}
                            filter={filter} onFilterChange={setFilter} query={query} onQueryChange={setQuery} />
      </div>
    </>
  )
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
        ? <ConnectedReputation canReply={perms.canReply} reloadKey={reloadKey} />
        : <GoogleListingsPanel canEdit={perms.canEditListing} canPost={perms.canReply} reloadKey={reloadKey} />}
    </div>
  )
}
