import { useState } from 'react'
import { Sparkles, RefreshCw, Pencil, Check, CheckCircle2 } from 'lucide-react'
import PlatformBadge from './PlatformBadge'
import StarRating from '../shared/StarRating'
import { formatLocalDateUS } from '../shared/utils'
import { C } from '../theme'

const sentimentStyles = {
  Positive: { background: C.emerald50, color: C.emerald600 },
  Neutral: { background: C.amber50, color: C.amber600 },
  Negative: { background: C.red50, color: C.red600 },
}

const statusStyles = {
  'Awaiting Reply': { background: C.gray100, color: C.gray600 },
  'AI Drafted': { background: C.purple50, color: C.purple600 },
  Posted: { background: C.emerald50, color: C.emerald700 },
}

function formatDate(iso) {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${formatLocalDateUS(d)}, ${time}`
}

export default function ReviewCard({ review, onApprove, onRegenerate }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(review.aiReply)

  const isPosted = review.status === 'Posted'

  function startEdit() {
    setDraft(review.aiReply)
    setEditing(true)
  }

  function saveEdit() {
    setEditing(false)
    onApprove(review.id, draft)
  }

  function approveAsIs() {
    onApprove(review.id, review.aiReply)
  }

  const emeraldBtn = {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 6,
    background: C.emerald600, color: C.white, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
  }
  const grayBorderBtn = {
    display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 6,
    border: '1px solid ' + C.gray200, fontSize: 12, fontWeight: 500, color: C.gray600, background: C.white, cursor: 'pointer',
  }

  return (
    <div style={{ border: '1px solid ' + C.gray100, borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <PlatformBadge platform={review.platform} size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 500, color: C.gray900, fontSize: 13.5 }}>{review.customer}</span>
            <span style={{ fontSize: 11, color: C.gray400, fontWeight: 500 }}>via {review.platform}</span>
            <StarRating value={review.rating} size={12} />
            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 500, ...sentimentStyles[review.sentiment] }}>
              {review.sentiment}
            </span>
            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 500, ...statusStyles[review.status] }}>
              {review.status}
            </span>
          </div>
          <p style={{ fontSize: 13, color: C.gray600, marginBottom: 4 }}>{review.text}</p>
          <p style={{ fontSize: 11.5, color: C.gray400 }}>
            {review.facility} &middot; {formatDate(review.date)}
          </p>
        </div>
      </div>

      <div style={{ borderRadius: 8, background: C.gray50, border: '1px solid ' + C.gray100, padding: 12, marginLeft: 38 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11.5, fontWeight: 500, color: C.gray500 }}>
          <Sparkles size={12} style={{ color: C.purple500 }} />
          AI Reply Suggestion &amp; Actions
        </div>

        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 13, color: C.gray700, marginBottom: 8, outline: 'none' }}
          />
        ) : (
          <p style={{ fontSize: 13, color: C.gray700, marginBottom: 8 }}>{review.aiReply}</p>
        )}

        {isPosted ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.emerald600, fontWeight: 500 }}>
            <CheckCircle2 size={13} />
            Posted{review.responseHours != null ? ` • replied in ${review.responseHours.toFixed(1)} hrs` : ''}
            {review.wasEdited && <span style={{ color: C.gray400, fontWeight: 400 }}>(edited before posting)</span>}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {editing ? (
              <>
                <button
                  onClick={saveEdit}
                  style={emeraldBtn}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
                >
                  <Check size={12} />
                  Save &amp; Post
                </button>
                <button
                  onClick={() => setEditing(false)}
                  style={{ padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500, color: C.gray500, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={approveAsIs}
                  style={emeraldBtn}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
                >
                  <Check size={12} />
                  Approve &amp; Post
                </button>
                <button
                  onClick={startEdit}
                  style={grayBorderBtn}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
                >
                  <Pencil size={12} />
                  Edit Reply
                </button>
                <button
                  onClick={() => onRegenerate(review.id)}
                  style={grayBorderBtn}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
                >
                  <RefreshCw size={12} />
                  Regenerate
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
