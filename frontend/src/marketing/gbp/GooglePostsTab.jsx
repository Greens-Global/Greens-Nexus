import { useCallback, useEffect, useState } from 'react'
import { Megaphone, Pencil, Trash2, ExternalLink, Check } from 'lucide-react'
import { api } from '../../api'
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState'
import { formatDate } from '../../lib/datetime'
import { C } from '../theme'
import { errorText } from './useGbp'

const POST_MAX = 1500   // Google's limit (gbp.POST_MAX)
const CTA_TYPES = [
  { key: '', label: 'No Button' },
  { key: 'LEARN_MORE', label: 'Learn More' },
  { key: 'BOOK', label: 'Book' },
  { key: 'ORDER', label: 'Order Online' },
  { key: 'SHOP', label: 'Shop' },
  { key: 'SIGN_UP', label: 'Sign Up' },
  { key: 'CALL', label: 'Call Now' },
]
const CTA_LABEL = Object.fromEntries(CTA_TYPES.map((c) => [c.key, c.label]))
const STATE_STYLE = {
  LIVE: { label: 'Live', background: C.emerald50, color: C.emerald700 },
  PROCESSING: { label: 'Processing', background: C.amber50, color: C.amber700 },
  REJECTED: { label: 'Rejected by Google', background: C.red50, color: C.red700 },
}

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 6,
  border: '1px solid ' + C.gray200, fontSize: 12, fontWeight: 500, color: C.gray600, background: C.white, cursor: 'pointer',
}
const primaryBtn = { ...btn, border: 'none', background: C.emerald600, color: C.white }
const input = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 13,
  color: C.gray800, background: C.white, outline: 'none', fontFamily: 'inherit',
}

function PostForm({ location, post, onSaved, onCancel }) {
  const [summary, setSummary] = useState(post?.summary || '')
  const [ctaType, setCtaType] = useState(post?.ctaType || '')
  const [ctaUrl, setCtaUrl] = useState(post?.ctaUrl || location.website || '')
  const [photoUrl, setPhotoUrl] = useState('')
  const [photos, setPhotos] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // A post's picture is one of the location's own Google photos - Google
  // needs a public address for it, and its own is one.
  useEffect(() => {
    if (post) return
    api.getGbpPhotos(location.key).then((p) => setPhotos(p || [])).catch(() => setPhotos([]))
  }, [location.key, post])

  const problem = !summary.trim() ? ''
    : summary.trim().length > POST_MAX ? `Google allows up to ${POST_MAX} characters in a post.`
    : ctaType && ctaType !== 'CALL' && !/^https?:\/\//.test(ctaUrl.trim()) ? 'The button needs a web address starting with https://.'
    : ''

  async function save() {
    if (!summary.trim() || problem) return
    setBusy(true)
    setErr('')
    const body = { summary, ctaType, ctaUrl: ctaType === 'CALL' ? '' : ctaUrl, photoUrl }
    try {
      onSaved(post ? await api.updateGbpPost(location.key, post.id, body) : await api.createGbpPost(location.key, body))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ border: '1px solid ' + C.gray200, borderRadius: 10, padding: 12, marginBottom: 12, background: C.gray50 }}>
      <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} aria-label="Post text"
                placeholder="What's new at this location - a special, an update, an event. It shows on the Google profile."
                style={{ ...input, resize: 'vertical', marginBottom: 4 }} />
      <div style={{ fontSize: 11, textAlign: 'right', color: summary.trim().length > POST_MAX ? C.red600 : C.gray400, marginBottom: 8 }}>
        {summary.trim().length} / {POST_MAX}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <select value={ctaType} onChange={(e) => setCtaType(e.target.value)} style={{ ...input, width: 'auto' }} aria-label="Button">
          {CTA_TYPES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        {ctaType && ctaType !== 'CALL' && (
          <input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://" aria-label="Button link"
                 style={{ ...input, flex: '1 1 240px', width: 'auto' }} />
        )}
        {ctaType === 'CALL' && <span style={{ fontSize: 12, color: C.gray500, alignSelf: 'center' }}>Calls {location.phone || 'the listing phone'}</span>}
      </div>
      {!post && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 4 }}>Picture (optional)</div>
          {photos === null ? <SkeletonBlocks count={1} height={56} borderRadius={6} />
            : photos.length === 0 ? <div style={{ fontSize: 12, color: C.gray400 }}>Add photos on the Photos tab to use one here.</div>
            : (
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
                {photos.slice(0, 24).map((p) => {
                  const on = photoUrl === p.url
                  return (
                    <button key={p.id} onClick={() => setPhotoUrl(on ? '' : p.url)} aria-pressed={on} aria-label="Use this photo"
                            style={{ position: 'relative', padding: 0, border: '2px solid ' + (on ? C.emerald600 : 'transparent'), borderRadius: 6, background: 'none', cursor: 'pointer', flexShrink: 0 }}>
                      <img src={p.thumbnailUrl} alt="" referrerPolicy="no-referrer" style={{ width: 72, height: 54, objectFit: 'cover', borderRadius: 4, display: 'block' }} />
                      {on && <Check size={14} style={{ position: 'absolute', top: 2, right: 2, color: C.white, background: C.emerald600, borderRadius: 9999 }} />}
                    </button>
                  )
                })}
              </div>
            )}
        </div>
      )}
      {(problem || err) && <div role="alert" style={{ fontSize: 12, color: C.red600, marginBottom: 8 }}>{problem || err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={save} disabled={!summary.trim() || !!problem || busy} style={{ ...primaryBtn, opacity: !summary.trim() || problem || busy ? 0.6 : 1 }}>
          {busy ? 'Publishing...' : post ? 'Save Post' : 'Publish to Google'}
        </button>
        <button onClick={onCancel} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
      </div>
    </div>
  )
}

// Posts on one location's Google profile ("What's new"): publish, edit the
// text and button, delete. Who did each is in the location's History.
export default function GooglePostsTab({ location, canEdit }) {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)      // 'new' | post id
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setPosts(await api.getGbpPosts(location.key) || [])
    } catch (e) {
      setError(errorText(e, 'The Google posts could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [location.key])

  useEffect(() => { load() }, [load])

  async function remove(id) {
    setBusy(id)
    setErr('')
    try {
      await api.deleteGbpPost(location.key, id)
      setPosts((ps) => ps.filter((p) => p.id !== id))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy('')
      setConfirming('')
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.gray500 }}>
          {posts.length} post{posts.length === 1 ? '' : 's'}{posts[0] && <> &middot; latest {formatDate(posts[0].createdAt)}</>}
        </span>
        {canEdit && editing !== 'new' && <button onClick={() => setEditing('new')} style={primaryBtn}><Megaphone size={12} />New Post</button>}
      </div>
      {editing === 'new' && (
        <PostForm location={location} onCancel={() => setEditing(null)}
                  onSaved={(p) => { setPosts((ps) => [p, ...ps]); setEditing(null) }} />
      )}
      {err && <div role="alert" style={{ fontSize: 12, color: C.red600, marginBottom: 8 }}>{err}</div>}
      <AsyncSection
        loading={loading}
        error={!!error}
        errorMessage={error}
        onRetry={load}
        isEmpty={posts.length === 0}
        skeleton={<SkeletonBlocks count={2} height={70} />}
        emptyContent={<div style={{ fontSize: 12.5, color: C.gray400, padding: '16px 0' }}>No posts on this Google profile yet.</div>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {posts.map((p) => {
            if (editing === p.id) {
              return (
                <PostForm key={p.id} location={location} post={p} onCancel={() => setEditing(null)}
                          onSaved={(next) => { setPosts((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...next, imageUrl: x.imageUrl } : x))); setEditing(null) }} />
              )
            }
            const st = STATE_STYLE[p.state]
            return (
              <div key={p.id} style={{ display: 'flex', gap: 12, border: '1px solid ' + C.gray100, borderRadius: 10, padding: 12 }}>
                {p.imageUrl && <img src={p.imageUrl} alt="" referrerPolicy="no-referrer" style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    {st && <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 500, background: st.background, color: st.color }}>{st.label}</span>}
                    <span style={{ fontSize: 11.5, color: C.gray400 }}>{formatDate(p.createdAt)}</span>
                    {p.ctaType && <span style={{ fontSize: 11.5, color: C.gray500 }}>&middot; {CTA_LABEL[p.ctaType] || p.ctaType} button</span>}
                  </div>
                  {p.eventTitle && <div style={{ fontSize: 13, fontWeight: 500, color: C.gray900 }}>{p.eventTitle}</div>}
                  <p style={{ fontSize: 13, color: C.gray700, whiteSpace: 'pre-wrap', margin: 0 }}>{p.summary}</p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {p.searchUrl && <a href={p.searchUrl} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: 'none' }}><ExternalLink size={12} />View on Google</a>}
                    {canEdit && confirming !== p.id && (
                      <>
                        <button onClick={() => setEditing(p.id)} style={btn}><Pencil size={12} />Edit</button>
                        <button onClick={() => setConfirming(p.id)} style={btn}><Trash2 size={12} />Delete</button>
                      </>
                    )}
                    {canEdit && confirming === p.id && (
                      <>
                        <button onClick={() => remove(p.id)} disabled={busy === p.id} style={{ ...btn, border: 'none', background: C.red600, color: C.white }}>
                          {busy === p.id ? 'Deleting...' : 'Delete From Google'}
                        </button>
                        <button onClick={() => setConfirming('')} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </AsyncSection>
    </div>
  )
}
