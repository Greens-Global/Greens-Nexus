import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Sparkles, Pencil, Trash2, History, Send, MessageSquare } from 'lucide-react'
import { api } from '../../api'
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState'
import { formatDateTime } from '../../lib/datetime'
import StarRating from '../shared/StarRating'
import { generateAiReply, replyVariationCount, COMPANY } from '../reputation/aiReplyEngine'
import { C } from '../theme'
import { announceGbpChange, errorText } from './useGbp'

const PAGE = 50
const REPLY_MAX = 4096   // Google's limit (gbp.REPLY_MAX)

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 6,
  border: '1px solid ' + C.gray200, fontSize: 12, fontWeight: 500, color: C.gray600, background: C.white, cursor: 'pointer',
}
const primaryBtn = { ...btn, border: 'none', background: C.emerald600, color: C.white }
const card = { background: C.white, border: '1px solid ' + C.gray200, borderRadius: 12, padding: 16 }

const FILTERS = [
  { key: 'no', label: 'Unreplied', count: 'unreplied' },
  { key: 'yes', label: 'Replied', count: 'replied' },
  { key: '', label: 'All Reviews', count: 'all' },
]

const ACTION_LABEL = { reply: 'replied', edit: 'edited the reply', delete: 'deleted the reply' }

function sentimentOf(rating) {
  return rating >= 4 ? 'Positive' : rating === 3 ? 'Neutral' : 'Negative'
}

// A starting draft from the rule-based reply engine, with the location's
// real phone number in place of the engine's placeholder. A person always
// reads and posts it - nothing is sent automatically.
function suggestReply(review, location, variant) {
  const text = generateAiReply({
    sentiment: sentimentOf(review.rating),
    facility: location?.facility || location?.title || review.location,
    name: (review.reviewer || '').split(' ')[0] || 'there',
    reviewText: review.comment || '',
    variantIndex: variant % replyVariationCount(),
  })
  return text.split(COMPANY.phone).join(location?.phone || 'the office')
}

function Stat({ label, value, sub }) {
  return (
    <div style={{ ...card, padding: 14 }}>
      <div style={{ fontSize: 12, color: C.gray500, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: C.gray900, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

// Keyed on the reply itself (below), so a posted / edited / deleted reply
// starts the card fresh instead of syncing its form state in an effect.
function ReviewItem({ review, location, canReply, onChange }) {
  const [editing, setEditing] = useState(!review.replied)
  const [draft, setDraft] = useState(review.reply || '')
  const [variant, setVariant] = useState(0)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [history, setHistory] = useState(null)

  async function post() {
    setBusy('post')
    setErr('')
    try {
      onChange(await api.replyGbpReview(review.id, draft))
      setEditing(false)
      setHistory(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy('')
    }
  }

  async function remove() {
    setBusy('delete')
    setErr('')
    try {
      await api.deleteGbpReply(review.id)
      onChange({ ...review, replied: false, reply: '', repliedBy: '', repliedByName: '', repliedAt: '', replyUpdatedAt: '' })
      setConfirmDelete(false)
      setHistory(null)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy('')
    }
  }

  async function toggleHistory() {
    if (history) { setHistory(null); return }
    try {
      setHistory(await api.getGbpReviewHistory(review.id))
    } catch (e) {
      setErr(errorText(e))
    }
  }

  function suggest() {
    setDraft(suggestReply(review, location, variant))
    setVariant((v) => v + 1)
  }

  const tooLong = draft.trim().length > REPLY_MAX
  const unchanged = review.replied && draft.trim() === (review.reply || '').trim()

  return (
    <div style={{ border: '1px solid ' + C.gray100, borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div aria-hidden="true" style={{
          width: 32, height: 32, borderRadius: '50%', background: C.gray100, color: C.gray600, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600,
        }}>
          {(review.reviewer || '?').charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 500, color: C.gray900, fontSize: 13.5 }}>{review.reviewer || 'Google User'}</span>
            <StarRating value={review.rating} size={12} />
            <span style={{
              padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 500,
              ...(review.replied ? { background: C.emerald50, color: C.emerald700 } : { background: C.amber50, color: C.amber700 }),
            }}>
              {review.replied ? 'Replied' : 'Awaiting Reply'}
            </span>
          </div>
          {review.comment
            ? <p style={{ fontSize: 13, color: C.gray700, marginBottom: 4, whiteSpace: 'pre-wrap' }}>{review.comment}</p>
            : <p style={{ fontSize: 12.5, color: C.gray400, fontStyle: 'italic', marginBottom: 4 }}>Rating only - no written review.</p>}
          <p style={{ fontSize: 11.5, color: C.gray400 }}>{review.location} &middot; {formatDateTime(review.createdAt)}</p>
        </div>
      </div>

      <div style={{ borderRadius: 8, background: C.gray50, border: '1px solid ' + C.gray100, padding: 12, marginTop: 10, marginLeft: 44 }}>
        {review.replied && !editing && (
          <>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: C.gray500, marginBottom: 4 }}>Response From the Owner</div>
            <p style={{ fontSize: 13, color: C.gray700, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{review.reply}</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: C.gray500 }}>
                {review.repliedBy
                  ? `Replied by ${review.repliedByName || review.repliedBy} on ${formatDateTime(review.repliedAt)}`
                  : `Replied in Google directly${review.replyUpdatedAt ? ` on ${formatDateTime(review.replyUpdatedAt)}` : ''}`}
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={toggleHistory} style={btn}><History size={12} />{history ? 'Hide History' : 'History'}</button>
                {canReply && !confirmDelete && (
                  <>
                    <button onClick={() => setEditing(true)} style={btn}><Pencil size={12} />Edit Reply</button>
                    <button onClick={() => setConfirmDelete(true)} style={btn}><Trash2 size={12} />Delete Reply</button>
                  </>
                )}
                {canReply && confirmDelete && (
                  <>
                    <button onClick={remove} disabled={!!busy} style={{ ...btn, border: 'none', background: C.red600, color: C.white }}>
                      {busy === 'delete' ? 'Deleting...' : 'Delete From Google'}
                    </button>
                    <button onClick={() => setConfirmDelete(false)} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {editing && canReply && (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder="Write a reply - it is posted publicly on Google as a response from the owner."
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid ' + (tooLong ? C.red500 : C.gray200),
                fontSize: 13, color: C.gray700, background: C.white, marginBottom: 8, outline: 'none', resize: 'vertical', fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={post} disabled={!draft.trim() || tooLong || unchanged || !!busy}
                      style={{ ...primaryBtn, opacity: !draft.trim() || tooLong || unchanged || busy ? 0.6 : 1 }}>
                <Send size={12} />
                {busy === 'post' ? 'Posting...' : review.replied ? 'Save Reply' : 'Post Reply'}
              </button>
              <button onClick={suggest} style={btn}><Sparkles size={12} />{draft ? 'Suggest Another' : 'Suggest Reply'}</button>
              {review.replied && (
                <button onClick={() => { setEditing(false); setDraft(review.reply || '') }} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
              )}
              {!review.replied && (
                <button onClick={toggleHistory} style={{ ...btn, border: 'none', background: 'transparent' }}>{history ? 'Hide History' : 'History'}</button>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: tooLong ? C.red600 : C.gray400 }}>
                {draft.trim().length} / {REPLY_MAX}
              </span>
            </div>
          </>
        )}

        {!review.replied && !canReply && (
          <span style={{ fontSize: 12, color: C.gray500 }}>Not replied yet. Replying needs Marketing editor access.</span>
        )}

        {err && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: C.red600 }}>{err}</div>}

        {history && (
          <div style={{ marginTop: 10, borderTop: '1px solid ' + C.gray200, paddingTop: 8 }}>
            {history.length === 0
              ? <div style={{ fontSize: 12, color: C.gray400 }}>Nothing has been done to this review from Nexus yet.</div>
              : history.map((h, i) => (
                <div key={i} style={{ fontSize: 12, color: h.ok ? C.gray600 : C.red600, padding: '3px 0' }}>
                  <strong style={{ fontWeight: 500 }}>{h.byName || h.by}</strong> {ACTION_LABEL[h.action] || h.action}
                  {' '}&middot; {formatDateTime(h.at)}
                  {!h.ok && <> &middot; Google refused it: {h.error}</>}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Real Google reviews (marketing_reviews, synced from Google) with the
// Replied / Unreplied split, reply / edit / delete, and the record of who
// in Nexus did each - Google itself shows every reply as the owner's.
export default function GoogleReviewsPanel({ canReply, reloadKey = 0 }) {
  const [locations, setLocations] = useState([])
  const [filter, setFilter] = useState('no')
  const [locationKey, setLocationKey] = useState('')
  const [query, setQuery] = useState('')
  const [data, setData] = useState({ total: 0, counts: { all: 0, unreplied: 0, replied: 0 }, reviews: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [locs, page] = await Promise.all([
        api.getGbpLocations(),
        api.getGbpReviews({ replied: filter, location: locationKey, limit: PAGE, offset: 0 }),
      ])
      setLocations(locs || [])
      setData(page)
    } catch (e) {
      setError(errorText(e, 'The Google reviews could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [filter, locationKey])

  useEffect(() => { load() }, [load, reloadKey])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const page = await api.getGbpReviews({ replied: filter, location: locationKey, limit: PAGE, offset: data.reviews.length })
      setData((d) => ({ ...page, reviews: [...d.reviews, ...page.reviews] }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  // A reply / edit / delete updates its row in place and moves the counts,
  // without reloading - the review stays where the person was working.
  function replaceReview(next) {
    setData((d) => {
      const prev = d.reviews.find((r) => r.id === next.id)
      const counts = { ...d.counts }
      if (prev && prev.replied !== next.replied) {
        counts.replied += next.replied ? 1 : -1
        counts.unreplied += next.replied ? -1 : 1
      }
      return { ...d, counts, reviews: d.reviews.map((r) => (r.id === next.id ? next : r)) }
    })
    announceGbpChange()
  }

  const locationById = useMemo(() => Object.fromEntries(locations.map((l) => [l.id, l])), [locations])
  const scope = locationKey ? locations.filter((l) => l.key === locationKey) : locations
  const totalReviews = scope.reduce((a, l) => a + (l.reviewCount || 0), 0)
  const avgRating = totalReviews ? scope.reduce((a, l) => a + (l.avgRating || 0) * (l.reviewCount || 0), 0) / totalReviews : 0

  const q = query.trim().toLowerCase()
  const shown = q
    ? data.reviews.filter((r) => `${r.reviewer} ${r.comment} ${r.reply} ${r.location}`.toLowerCase().includes(q))
    : data.reviews

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Stat label="Average Rating" value={totalReviews ? avgRating.toFixed(1) : '-'} sub={totalReviews ? <StarRating value={Math.round(avgRating)} size={12} /> : null} />
        <Stat label="Total Reviews" value={totalReviews.toLocaleString('en-US')} />
        <Stat label="Awaiting Reply" value={data.counts.unreplied.toLocaleString('en-US')} />
        <Stat label="Replied" value={data.counts.replied.toLocaleString('en-US')} />
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
            {FILTERS.map((f) => {
              const active = filter === f.key
              return (
                <button key={f.label} onClick={() => setFilter(f.key)} style={{
                  ...btn, whiteSpace: 'nowrap',
                  ...(active ? { background: C.gray900, color: C.white, borderColor: C.gray900 } : {}),
                }}>
                  {f.label} <span style={{ opacity: 0.7 }}>{data.counts[f.count].toLocaleString('en-US')}</span>
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select value={locationKey} onChange={(e) => setLocationKey(e.target.value)} aria-label="Location"
                    style={{ ...btn, paddingRight: 28 }}>
              <option value="">All Locations</option>
              {locations.map((l) => <option key={l.key} value={l.key}>{l.facility || l.title}</option>)}
            </select>
            <label style={{ ...btn, cursor: 'text' }}>
              <Search size={12} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search loaded reviews"
                     style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: C.gray700, width: 160 }} />
            </label>
          </div>
        </div>

        <AsyncSection
          loading={loading}
          error={!!error}
          errorMessage={error}
          onRetry={load}
          isEmpty={shown.length === 0}
          skeleton={<SkeletonBlocks count={3} height={110} />}
          emptyContent={(
            <div style={{ textAlign: 'center', padding: '32px 12px', color: C.gray400, fontSize: 13 }}>
              <MessageSquare size={22} style={{ marginBottom: 6 }} />
              <div>
                {q ? 'No loaded review matches that search.'
                  : filter === 'no' ? 'Every review has a reply.'
                  : locations.length === 0 ? 'No locations have synced from Google yet.'
                  : 'No reviews here yet.'}
              </div>
            </div>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {shown.map((r) => (
              <ReviewItem key={`${r.id}:${r.replied}:${r.reply}`} review={r} location={locationById[r.locationId]} canReply={canReply} onChange={replaceReview} />
            ))}
          </div>
          {data.reviews.length < data.total && (
            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <button onClick={loadMore} disabled={loadingMore} style={btn}>
                {loadingMore ? 'Loading...' : `Load More (${(data.total - data.reviews.length).toLocaleString('en-US')} more)`}
              </button>
            </div>
          )}
        </AsyncSection>
      </div>
    </div>
  )
}
