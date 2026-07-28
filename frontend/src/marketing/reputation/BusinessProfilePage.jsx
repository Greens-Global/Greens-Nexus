import { useEffect, useMemo, useState } from 'react'
import BusinessProfileHeader from './BusinessProfileHeader'
import ProfileStatCards from './ProfileStatCards'
import ProfileViewsChart from './ProfileViewsChart'
import DiscoveryKeywordsCard from './DiscoveryKeywordsCard'
import GbpContentSection from './GbpContentSection'
import { initialPosts, initialPhotos, initialQuestions } from './gbpContentData'
import { initialFacebookPosts } from './facebookContentData'
import { initialInstagramPosts } from './instagramContentData'
import { postsForProperty, photosForProperty, questionsForProperty } from './gbpContentAggregate'
import { profileMetricsByFacility, discoveryKeywordsByFacility } from './profileData'
import { profileRowsInRange, sumProfileTotals, topDiscoveryKeywords, directDiscoverySplit } from './profileAggregate'
import { FACILITIES } from '../shared/facilities'
import PropertyComparisonModal from '../shared/PropertyComparisonModal'
import { ANCHOR_DATE, downloadCSV, formatNumber, getPreviousPeriod } from '../shared/utils'
import { C } from '../theme'

const COMPARISON_COLUMNS = [
  { key: 'totalViews', label: 'Total Views', value: (r) => r.totalViews, format: (r) => formatNumber(r.totalViews), highlight: true },
  { key: 'websiteClicks', label: 'Website Clicks', value: (r) => r.websiteClicks, format: (r) => formatNumber(r.websiteClicks) },
  { key: 'callClicks', label: 'Calls', value: (r) => r.callClicks, format: (r) => formatNumber(r.callClicks) },
  { key: 'directionRequests', label: 'Direction Requests', value: (r) => r.directionRequests, format: (r) => formatNumber(r.directionRequests) },
]

const PLATFORMS = [
  { key: 'google', label: 'Google' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
]

const INSIGHTS_TITLE = {
  google: 'Google Business Profile Insights',
}

const POSTS_ONLY_TITLE = {
  facebook: 'Facebook Page Posts',
  instagram: 'Instagram Posts',
}

export default function BusinessProfilePage({ range, onRangeChange, property, onPropertyChange, onNavigate, alerts, insights, onClearAlert, action, onClearAction }) {
  const [compareSelection, setCompareSelection] = useState(null)
  const [platform, setPlatform] = useState('google')
  const [autoOpenCreatePost, setAutoOpenCreatePost] = useState(false)
  const [postsByPlatform, setPostsByPlatform] = useState({
    google: initialPosts,
    facebook: initialFacebookPosts,
    instagram: initialInstagramPosts,
  })
  const [photosByPlatform, setPhotosByPlatform] = useState({
    google: initialPhotos,
    facebook: [],
    instagram: [],
  })
  const [questionsByPlatform, setQuestionsByPlatform] = useState({
    google: initialQuestions,
    facebook: [],
    instagram: [],
  })

  useEffect(() => {
    if (action === 'google-posts' || action === 'facebook-posts' || action === 'instagram-posts') {
      setPlatform(action === 'google-posts' ? 'google' : action === 'facebook-posts' ? 'facebook' : 'instagram')
      setAutoOpenCreatePost(true)
      onClearAction?.()
    }
  }, [action, onClearAction])

  const posts = postsByPlatform[platform]
  const photos = photosByPlatform[platform]
  const questions = questionsByPlatform[platform]

  // Only Google has a "Business Profile Performance" API equivalent in this
  // mock universe - Facebook/Instagram are organic content platforms with no
  // view/click/call analytics, so no insights data source exists for them.
  const insightsPlatform = platform === 'google' ? 'google' : null
  const activeMetricsByFacility = insightsPlatform === 'google' ? profileMetricsByFacility : null
  const activeKeywordsByFacility = insightsPlatform === 'google' ? discoveryKeywordsByFacility : null

  function setPosts(updater) {
    setPostsByPlatform((prev) => ({ ...prev, [platform]: updater(prev[platform]) }))
  }
  function setPhotos(updater) {
    setPhotosByPlatform((prev) => ({ ...prev, [platform]: updater(prev[platform]) }))
  }
  function setQuestions(updater) {
    setQuestionsByPlatform((prev) => ({ ...prev, [platform]: updater(prev[platform]) }))
  }

  const previousRange = useMemo(() => getPreviousPeriod(range), [range])

  const profileRows = useMemo(
    () => (activeMetricsByFacility ? profileRowsInRange(activeMetricsByFacility, property, range) : []),
    [activeMetricsByFacility, property, range],
  )
  const profilePrevRows = useMemo(
    () => (activeMetricsByFacility ? profileRowsInRange(activeMetricsByFacility, property, previousRange) : []),
    [activeMetricsByFacility, property, previousRange],
  )
  const profileTotals = useMemo(() => sumProfileTotals(profileRows), [profileRows])
  const profilePrevTotals = useMemo(() => sumProfileTotals(profilePrevRows), [profilePrevRows])
  const discoveryKeywords = useMemo(
    () => (activeKeywordsByFacility ? topDiscoveryKeywords(activeKeywordsByFacility, property) : []),
    [activeKeywordsByFacility, property],
  )
  const discoverySplit = useMemo(
    () => (activeKeywordsByFacility ? directDiscoverySplit(activeKeywordsByFacility, property) : { direct: 0, discovery: 0, total: 0 }),
    [activeKeywordsByFacility, property],
  )

  const comparisonRows = useMemo(
    () =>
      activeMetricsByFacility
        ? FACILITIES.map((name) => ({
            name,
            ...sumProfileTotals(profileRowsInRange(activeMetricsByFacility, name, range)),
          }))
        : [],
    [activeMetricsByFacility, range],
  )

  const scopedPosts = useMemo(() => postsForProperty(posts, property), [posts, property])
  const scopedPhotos = useMemo(() => photosForProperty(photos, property), [photos, property])
  const scopedQuestions = useMemo(() => questionsForProperty(questions, property), [questions, property])

  function createPost(input) {
    const post = {
      id: `post-custom-${Date.now()}`,
      facility: input.facility,
      type: input.type,
      text: input.text,
      imageUrl: input.imageUrl,
      ctaLabel: input.ctaLabel,
      ctaUrl: input.ctaUrl,
      createdDate: ANCHOR_DATE,
      expiresDate: input.expiresDate,
      status: 'LIVE',
    }
    setPosts((prev) => [post, ...prev])
  }

  function updatePost(id, input) {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              facility: input.facility,
              type: input.type,
              text: input.text,
              imageUrl: input.imageUrl,
              ctaLabel: input.ctaLabel,
              ctaUrl: input.ctaUrl,
              expiresDate: input.expiresDate,
            }
          : p,
      ),
    )
  }

  function addPhoto(input) {
    const photo = {
      id: `photo-custom-${Date.now()}`,
      facility: input.facility,
      url: input.url,
      category: input.category,
      uploadedDate: ANCHOR_DATE,
    }
    setPhotos((prev) => [photo, ...prev])
  }

  function answerQuestion(id, text) {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, answer: text, answeredDate: ANCHOR_DATE } : q)))
  }

  function downloadReport() {
    const rows = insightsPlatform
      ? [
          [INSIGHTS_TITLE[insightsPlatform]],
          [`Property: ${property}`],
          [],
          ['Metric', 'Value'],
          ['Maps Views', profileTotals.mapsViews],
          ['Search Views', profileTotals.searchViews],
          ['Website Clicks', profileTotals.websiteClicks],
          ['Calls', profileTotals.callClicks],
          ['Direction Requests', profileTotals.directionRequests],
          [],
          ['Top Discovery Keywords', 'Type', 'Impressions'],
          ...discoveryKeywords.map((k) => [k.keyword, k.type, k.impressions]),
        ]
      : [
          [POSTS_ONLY_TITLE[platform]],
          [`Property: ${property}`],
          [],
          ['Post', 'Type', 'Status', 'Posted', 'Expires'],
          ...scopedPosts.map((p) => [p.text, p.type, p.status, p.createdDate, p.expiresDate]),
        ]
    downloadCSV(`business-profile-report_${platform}_${range.start}_${range.end}.csv`, rows)
  }

  return (
    <div>
      <BusinessProfileHeader
        range={range}
        onRangeChange={onRangeChange}
        property={property}
        properties={FACILITIES}
        onPropertyChange={onPropertyChange}
        onDownload={downloadReport}
        onCompare={setCompareSelection}
        onNavigate={onNavigate}
        alerts={alerts}
        insights={insights}
        onClearAlert={onClearAlert}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: C.gray900 }}>
          {insightsPlatform ? INSIGHTS_TITLE[insightsPlatform] : POSTS_ONLY_TITLE[platform]}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, border: '1px solid ' + C.gray200, padding: 4, flexShrink: 0 }}>
          {PLATFORMS.map((p) => {
            const active = platform === p.key
            return (
              <button
                key={p.key}
                onClick={() => setPlatform(p.key)}
                style={{
                  padding: '4px 12px',
                  borderRadius: 6,
                  fontSize: 12.5,
                  fontWeight: 500,
                  transition: 'background-color .15s',
                  background: active ? C.gray900 : 'transparent',
                  color: active ? C.white : C.gray500,
                  border: 'none',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      {insightsPlatform && (
        <>
          <ProfileStatCards current={profileTotals} previous={profilePrevTotals} platform={insightsPlatform} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'stretch' }}>
            <div style={{ gridColumn: 'span 7' }}>
              <ProfileViewsChart rows={profileRows} prevRows={profilePrevRows} platform={insightsPlatform} />
            </div>
            <div style={{ gridColumn: 'span 5' }}>
              <DiscoveryKeywordsCard keywords={discoveryKeywords} split={discoverySplit} />
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: 16 }}>
        <GbpContentSection
          property={property}
          platform={platform}
          posts={scopedPosts}
          photos={scopedPhotos}
          questions={scopedQuestions}
          allPhotos={photos}
          onCreatePost={createPost}
          onUpdatePost={updatePost}
          onAddPhoto={addPhoto}
          onAnswerQuestion={answerQuestion}
          autoOpenCreatePost={autoOpenCreatePost}
          onAutoOpenHandled={() => setAutoOpenCreatePost(false)}
        />
      </div>

      {compareSelection && insightsPlatform && (
        <PropertyComparisonModal
          title={`Compare Properties - ${INSIGHTS_TITLE[insightsPlatform]}`}
          rows={comparisonRows.filter((r) => compareSelection.includes(r.name))}
          columns={COMPARISON_COLUMNS}
          onClose={() => setCompareSelection(null)}
        />
      )}
    </div>
  )
}
