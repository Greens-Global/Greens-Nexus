import { useState } from 'react'
import { Plus, Pencil, Megaphone, Tag, CalendarDays } from 'lucide-react'
import { formatDateLabel } from '../shared/utils'
import { C } from '../theme'

const TYPE_STYLE = {
  OFFER: { color: C.amber600, background: C.amber50 },
  EVENT: { color: C.purple600, background: C.purple50 },
  STANDARD: { color: C.blue600, background: C.blue50 },
}

const TYPE_GRADIENT = {
  OFFER: 'linear-gradient(to bottom right, #fbbf24, ' + C.amber600 + ')',
  EVENT: 'linear-gradient(to bottom right, #c084fc, ' + C.purple600 + ')',
  STANDARD: 'linear-gradient(to bottom right, #60a5fa, ' + C.blue600 + ')',
}

const TYPE_ICON = {
  OFFER: Tag,
  EVENT: CalendarDays,
  STANDARD: Megaphone,
}

function PostCard({ p, showFacility, onEditClick }) {
  const [hovered, setHovered] = useState(false)
  const Icon = TYPE_ICON[p.type]
  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 12,
        border: '1px solid ' + C.gray200,
        overflow: 'hidden',
        transition: 'all .15s',
        background: C.white,
        boxShadow: hovered ? '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)' : 'none',
        transform: hovered ? 'translateY(-2px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={() => onEditClick(p)}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 10,
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 9999,
          background: 'rgba(255,255,255,0.9)',
          color: C.gray600,
          boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
          border: 'none',
          cursor: 'pointer',
          opacity: hovered ? 1 : 0,
          transition: 'opacity .15s',
        }}
        title="Edit post"
      >
        <Pencil size={13} />
      </button>
      {p.imageUrl ? (
        <img src={p.imageUrl} alt="" style={{ width: '100%', height: 128, objectFit: 'cover', background: C.gray100 }} />
      ) : (
        <div style={{ width: '100%', height: 128, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TYPE_GRADIENT[p.type] }}>
          <Icon size={30} style={{ color: 'rgba(255,255,255,0.9)' }} />
        </div>
      )}
      <div style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 500, color: TYPE_STYLE[p.type].color, background: TYPE_STYLE[p.type].background }}>{p.type}</span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 9999,
              fontSize: 10.5,
              fontWeight: 500,
              color: p.status === 'LIVE' ? C.emerald600 : C.gray500,
              background: p.status === 'LIVE' ? C.emerald50 : C.gray100,
            }}
          >
            {p.status === 'LIVE' ? 'Live' : 'Expired'}
          </span>
          {showFacility && <span style={{ fontSize: 11, color: C.gray400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.facility}</span>}
        </div>
        <p style={{ fontSize: 12.5, color: C.gray700, lineHeight: 1.375, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '3em' }}>{p.text}</p>
        {p.ctaLabel && (
          <button style={{ marginTop: 10, width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid ' + C.gray300, fontSize: 11.5, fontWeight: 500, color: C.gray700, background: C.white, cursor: 'pointer' }}>
            {p.ctaLabel}
          </button>
        )}
        <p style={{ fontSize: 11, color: C.gray400, marginTop: 8 }}>
          Posted {formatDateLabel(p.createdDate)}
          <br />
          {p.status === 'LIVE' ? `Expires ${formatDateLabel(p.expiresDate)}` : `Expired ${formatDateLabel(p.expiresDate)}`}
        </p>
      </div>
    </div>
  )
}

export default function GbpPostsCard({ posts, showFacility, onAddClick, onEditClick }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
        <p style={{ fontSize: 12, color: C.gray500 }}>Google Posts appear directly on your listing and typically expire after 1-2 weeks.</p>
        <button
          onClick={onAddClick}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 12.5, fontWeight: 500, border: 'none', flexShrink: 0, cursor: 'pointer' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
        >
          <Plus size={13} />
          Create Post
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12, maxHeight: 460, overflowY: 'auto', padding: 2 }}>
        {posts.map((p) => (
          <PostCard key={p.id} p={p} showFacility={showFacility} onEditClick={onEditClick} />
        ))}
        {posts.length === 0 && <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: C.gray400, padding: '32px 0', fontSize: 12.5 }}>No posts yet.</div>}
      </div>
    </div>
  )
}
