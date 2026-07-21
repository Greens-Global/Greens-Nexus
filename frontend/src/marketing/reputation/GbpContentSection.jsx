import { useEffect, useState } from 'react'
import GbpPostsCard from './GbpPostsCard'
import GbpPhotosCard from './GbpPhotosCard'
import GbpQnaCard from './GbpQnaCard'
import CreatePostModal from './CreatePostModal'
import AddPhotoModal from './AddPhotoModal'
import { daysSinceLastPhoto, STALE_PHOTO_THRESHOLD_DAYS } from './gbpContentAggregate'
import { ALL_PROPERTIES, FACILITIES } from '../shared/facilities'
import { C } from '../theme'

const TABS = [
  { key: 'posts', label: 'Posts' },
  { key: 'photos', label: 'Photos' },
  { key: 'qna', label: 'Q&A' },
]

// Google's Business Profile is the only listing with all three surfaces in
// this mock universe. Facebook/Instagram are organic content platforms only —
// no photo gallery or public Q&A management, just Posts.
const TABS_BY_PLATFORM = {
  google: ['posts', 'photos', 'qna'],
  facebook: ['posts'],
  instagram: ['posts'],
}

const LISTING_LABEL = {
  google: 'Google Business Profile',
  facebook: 'Facebook Page',
  instagram: 'Instagram Business Profile',
}

export default function GbpContentSection({
  property,
  platform,
  posts,
  photos,
  questions,
  allPhotos,
  onCreatePost,
  onUpdatePost,
  onAddPhoto,
  onAnswerQuestion,
  autoOpenCreatePost,
  onAutoOpenHandled,
}) {
  const [tab, setTab] = useState('posts')
  const [showCreatePost, setShowCreatePost] = useState(false)
  const [editingPost, setEditingPost] = useState(null)
  const [showAddPhoto, setShowAddPhoto] = useState(false)

  const availableKeys = TABS_BY_PLATFORM[platform]
  const availableTabs = TABS.filter((t) => availableKeys.includes(t.key))

  useEffect(() => {
    if (!availableKeys.includes(tab)) setTab(availableKeys[0])
  }, [platform, availableKeys, tab])

  useEffect(() => {
    if (autoOpenCreatePost) {
      setTab('posts')
      setShowCreatePost(true)
      onAutoOpenHandled?.()
    }
  }, [autoOpenCreatePost, onAutoOpenHandled])

  const showFacility = property === ALL_PROPERTIES
  const defaultFacility = property === ALL_PROPERTIES ? FACILITIES[0] : property
  const listingLabel = LISTING_LABEL[platform]

  const staleWarning = (() => {
    if (property === ALL_PROPERTIES) return null
    const days = daysSinceLastPhoto(allPhotos, property)
    if (days === null) return `No photos added yet for ${property}.`
    if (days >= STALE_PHOTO_THRESHOLD_DAYS) return `Last photo added ${days} days ago — consider refreshing this gallery.`
    return null
  })()

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>Manage Your Business Listing</h3>
          <p style={{ fontSize: 11.5, color: C.gray400 }}>Publish updates, photos, and answer questions directly on your {listingLabel}.</p>
        </div>
        {availableTabs.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, border: '1px solid ' + C.gray200, padding: 4, flexShrink: 0 }}>
            {availableTabs.map((t) => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 500,
                    background: active ? C.gray900 : 'transparent',
                    color: active ? C.white : C.gray500,
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {tab === 'posts' && (
        <GbpPostsCard
          posts={posts}
          showFacility={showFacility}
          onAddClick={() => setShowCreatePost(true)}
          onEditClick={(post) => setEditingPost(post)}
        />
      )}
      {tab === 'photos' && (
        <GbpPhotosCard photos={photos} showFacility={showFacility} staleWarning={staleWarning} onAddClick={() => setShowAddPhoto(true)} />
      )}
      {tab === 'qna' && <GbpQnaCard questions={questions} showFacility={showFacility} onAnswer={onAnswerQuestion} />}

      {showCreatePost && (
        <CreatePostModal
          facilities={FACILITIES}
          defaultFacility={defaultFacility}
          platform={platform}
          onSubmit={(input) => {
            onCreatePost(input)
            setShowCreatePost(false)
          }}
          onClose={() => setShowCreatePost(false)}
        />
      )}
      {editingPost && (
        <CreatePostModal
          facilities={FACILITIES}
          defaultFacility={defaultFacility}
          platform={platform}
          editing={editingPost}
          onSubmit={(input) => {
            onUpdatePost(editingPost.id, input)
            setEditingPost(null)
          }}
          onClose={() => setEditingPost(null)}
        />
      )}
      {showAddPhoto && (
        <AddPhotoModal
          facilities={FACILITIES}
          defaultFacility={defaultFacility}
          onAdd={(input) => {
            onAddPhoto(input)
            setShowAddPhoto(false)
          }}
          onClose={() => setShowAddPhoto(false)}
        />
      )}
    </div>
  )
}
