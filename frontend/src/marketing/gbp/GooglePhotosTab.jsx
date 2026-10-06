import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2, Upload } from 'lucide-react'
import { api } from '../../api'
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState'
import { formatDate } from '../../lib/datetime'
import { C } from '../theme'
import { announceGbpChange, errorText } from './useGbp'

const PHOTO_CATEGORIES = [
  { key: 'EXTERIOR', label: 'Exterior' },
  { key: 'INTERIOR', label: 'Interior' },
  { key: 'AT_WORK', label: 'At Work' },
  { key: 'TEAMS', label: 'Team' },
  { key: 'COMMON_AREA', label: 'Common Area' },
  { key: 'ADDITIONAL', label: 'Additional' },
  { key: 'COVER', label: 'Cover' },
  { key: 'LOGO', label: 'Logo' },
]
const CATEGORY_LABEL = Object.fromEntries(PHOTO_CATEGORIES.map((c) => [c.key, c.label]))
const MIN_BYTES = 10 * 1024
const MAX_BYTES = 5 * 1024 * 1024

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 6,
  border: '1px solid ' + C.gray200, fontSize: 12, fontWeight: 500, color: C.gray600, background: C.white, cursor: 'pointer',
}
const primaryBtn = { ...btn, border: 'none', background: C.emerald600, color: C.white }

// Same pattern as tasks/lib.js filesFromPaste - every image upload in Nexus
// takes Ctrl+V.
function imageFromPaste(e) {
  for (const item of e.clipboardData?.items || []) {
    if (item.type?.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) return f.name ? f : new File([f], `paste-${Date.now()}.png`, { type: f.type || 'image/png' })
    }
  }
  return null
}

function checkFile(f) {
  if (!f) return 'Choose a photo.'
  if (!['image/jpeg', 'image/png'].includes(f.type)) return 'Google takes JPG or PNG photos.'
  if (f.size < MIN_BYTES || f.size > MAX_BYTES) return 'Google takes photos between 10 KB and 5 MB.'
  return ''
}

function AddPhoto({ location, onAdded, onCancel }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [category, setCategory] = useState('EXTERIOR')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  function pick(f) {
    setErr(checkFile(f))
    setFile(f)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(f ? URL.createObjectURL(f) : '')
  }

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  async function upload() {
    const problem = checkFile(file)
    if (problem) { setErr(problem); return }
    setBusy(true)
    setErr('')
    try {
      onAdded(await api.addGbpPhoto(location.key, file, category))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onPaste={(e) => { const f = imageFromPaste(e); if (f) { e.preventDefault(); pick(f) } }}
      tabIndex={0}
      style={{ border: '1px dashed ' + C.gray300, borderRadius: 10, padding: 12, marginBottom: 12, background: C.gray50, outline: 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {preview
          ? <img src={preview} alt="Photo to upload" style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 6 }} />
          : <div style={{ width: 96, height: 72, borderRadius: 6, background: C.gray100, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray400 }}><ImagePlus size={20} /></div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 220px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => inputRef.current?.click()} style={btn}><Upload size={12} />Choose Photo</button>
            <input ref={inputRef} type="file" accept="image/jpeg,image/png" hidden onChange={(e) => pick(e.target.files?.[0] || null)} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={btn} aria-label="Photo category">
              {PHOTO_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <span style={{ fontSize: 11.5, color: C.gray400 }}>
            {file ? file.name : 'JPG or PNG, 10 KB to 5 MB'} - or press Ctrl+V to paste an image.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={upload} disabled={!file || !!err || busy} style={{ ...primaryBtn, opacity: !file || err || busy ? 0.6 : 1 }}>
            {busy ? 'Uploading...' : 'Add to Google'}
          </button>
          <button onClick={onCancel} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
        </div>
      </div>
      {err && <div role="alert" style={{ fontSize: 12, color: C.red600, marginTop: 8 }}>{err}</div>}
    </div>
  )
}

// The photos on one location's Google profile, newest first. Uploads go
// straight to Google; nothing is stored in Nexus but who did it.
export default function GooglePhotosTab({ location, canEdit, onCountChange }) {
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setPhotos(await api.getGbpPhotos(location.key) || [])
    } catch (e) {
      setError(errorText(e, 'The Google photos could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [location.key])

  useEffect(() => { load() }, [load])

  async function remove(id) {
    setBusy(id)
    setErr('')
    try {
      await api.deleteGbpPhoto(location.key, id)
      const next = photos.filter((p) => p.id !== id)
      setPhotos(next)
      onCountChange?.(next.length)
      announceGbpChange()
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
          {photos.length} photo{photos.length === 1 ? '' : 's'}
          {photos[0] && <> &middot; newest {formatDate(photos[0].createdAt)}</>}
        </span>
        {canEdit && !adding && <button onClick={() => setAdding(true)} style={primaryBtn}><ImagePlus size={12} />Add Photo</button>}
      </div>
      {adding && (
        <AddPhoto
          location={location}
          onCancel={() => setAdding(false)}
          onAdded={(p) => {
            const next = [p, ...photos]
            setPhotos(next)
            setAdding(false)
            onCountChange?.(next.length)
            announceGbpChange()
          }}
        />
      )}
      {err && <div role="alert" style={{ fontSize: 12, color: C.red600, marginBottom: 8 }}>{err}</div>}
      <AsyncSection
        loading={loading}
        error={!!error}
        errorMessage={error}
        onRetry={load}
        isEmpty={photos.length === 0}
        skeleton={<SkeletonBlocks count={1} height={110} />}
        emptyContent={<div style={{ fontSize: 12.5, color: C.gray400, padding: '16px 0' }}>No photos on this Google profile yet.</div>}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
          {photos.map((p) => (
            <figure key={p.id} style={{ margin: 0, border: '1px solid ' + C.gray200, borderRadius: 8, overflow: 'hidden', background: C.white }}>
              <a href={p.url} target="_blank" rel="noreferrer">
                <img src={p.thumbnailUrl} alt={`${CATEGORY_LABEL[p.category] || 'Location'} photo`} loading="lazy"
                     referrerPolicy="no-referrer" style={{ width: '100%', height: 100, objectFit: 'cover', display: 'block' }} />
              </a>
              <figcaption style={{ padding: '6px 8px', fontSize: 11, color: C.gray500 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                  <span>{CATEGORY_LABEL[p.category] || 'Photo'}</span>
                  <span>{formatDate(p.createdAt)}</span>
                </div>
                {canEdit && (confirming === p.id ? (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <button onClick={() => remove(p.id)} disabled={busy === p.id} style={{ ...btn, padding: '3px 6px', fontSize: 11, border: 'none', background: C.red600, color: C.white }}>
                      {busy === p.id ? 'Removing...' : 'Remove From Google'}
                    </button>
                    <button onClick={() => setConfirming('')} style={{ ...btn, padding: '3px 6px', fontSize: 11, border: 'none', background: 'transparent' }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirming(p.id)} style={{ ...btn, padding: '3px 6px', fontSize: 11, marginTop: 4 }}>
                    <Trash2 size={11} />Remove
                  </button>
                ))}
              </figcaption>
            </figure>
          ))}
        </div>
      </AsyncSection>
    </div>
  )
}
