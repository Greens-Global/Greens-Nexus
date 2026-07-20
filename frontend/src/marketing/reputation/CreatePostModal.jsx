import { useMemo, useRef, useState } from 'react'
import { Megaphone, Tag, CalendarDays, MapPin, Upload } from 'lucide-react'
import Modal from '../shared/Modal'
import { ANCHOR_DATE, addDays, formatDateLabel } from '../shared/utils'
import { C } from '../theme'

const TYPES = ['STANDARD', 'OFFER', 'EVENT']

const DEFAULT_LIFESPAN = { STANDARD: 7, OFFER: 14, EVENT: 10 }

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

const CTA_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'Book', label: 'Book' },
  { value: 'Order online', label: 'Order online' },
  { value: 'Buy', label: 'Buy' },
  { value: 'Learn more', label: 'Learn more' },
  { value: 'Sign up', label: 'Sign up' },
  { value: 'Call now', label: 'Call now' },
  { value: 'Redeem', label: 'Redeem offer' },
]

const SURFACE_LABEL = {
  google: 'Maps and Search',
  facebook: 'your Page',
  instagram: 'your profile',
}

const SHOWS_ON_LABEL = {
  google: 'Show on Google until',
  facebook: 'Show on Facebook until',
  instagram: 'Show on Instagram until',
}

export default function CreatePostModal({ facilities, defaultFacility, platform, editing, onSubmit, onClose }) {
  const isEdit = !!editing
  const surface = SURFACE_LABEL[platform]
  const showsOnLabel = SHOWS_ON_LABEL[platform]
  const [facility, setFacility] = useState(editing?.facility ?? defaultFacility)
  const [type, setType] = useState(editing?.type ?? 'STANDARD')
  const [text, setText] = useState(editing?.text ?? '')
  const [imageUrl, setImageUrl] = useState(editing?.imageUrl ?? '')
  const [expiresDate, setExpiresDate] = useState(editing?.expiresDate ?? (() => addDays(ANCHOR_DATE, DEFAULT_LIFESPAN.STANDARD))())
  const [ctaLabel, setCtaLabel] = useState(editing?.ctaLabel ?? '')
  const [ctaUrl, setCtaUrl] = useState(editing?.ctaUrl ?? '')
  const fileInputRef = useRef(null)

  const minDate = addDays(ANCHOR_DATE, 1)
  const Icon = TYPE_ICON[type]

  function changeType(t) {
    setType(t)
    if (!isEdit) setExpiresDate(addDays(ANCHOR_DATE, DEFAULT_LIFESPAN[t]))
  }

  function readFile(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImageUrl(String(reader.result))
    reader.readAsDataURL(file)
  }

  function onFileChosen(e) {
    readFile(e.target.files?.[0])
  }

  // Ctrl+V a screenshot → same path as choosing a file. Pasting text (a URL)
  // into the link box still works normally.
  function handlePaste(e) {
    const list = e.clipboardData?.items || []
    for (const it of list) {
      if (it.type && it.type.startsWith('image/')) {
        const blob = it.getAsFile()
        if (blob) {
          e.preventDefault()
          readFile(blob.name ? blob : new File([blob], `paste-${Date.now()}.png`, { type: blob.type || 'image/png' }))
          return
        }
      }
    }
  }

  const showsUntil = useMemo(() => formatDateLabel(expiresDate), [expiresDate])

  function submit() {
    if (!text.trim() || !expiresDate) return
    onSubmit({
      facility,
      type,
      text: text.trim(),
      imageUrl: imageUrl.trim() || undefined,
      expiresDate,
      ctaLabel: ctaLabel || undefined,
      ctaUrl: ctaLabel ? ctaUrl.trim() || undefined : undefined,
    })
  }

  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }
  const inputStyle = { width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, outline: 'none' }
  const previewChipStyle =
    type === 'OFFER'
      ? { color: C.amber600, background: C.amber50 }
      : type === 'EVENT'
      ? { color: C.purple600, background: C.purple50 }
      : { color: C.blue600, background: C.blue50 }

  return (
    <Modal title={isEdit ? 'Edit Post' : 'Create Post'} onClose={onClose} width="max-w-3xl">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>Property</label>
            <select
              value={facility}
              onChange={(e) => setFacility(e.target.value)}
              style={{ ...inputStyle, color: C.gray700 }}
            >
              {facilities.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Post Type</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {TYPES.map((t) => {
                const active = type === t
                return (
                  <button
                    key={t}
                    onClick={() => changeType(t)}
                    style={{
                      flex: 1,
                      padding: '6px 12px',
                      borderRadius: 8,
                      border: '1px solid ' + (active ? C.gray900 : C.gray200),
                      fontSize: 12.5,
                      fontWeight: 500,
                      background: active ? C.gray900 : C.white,
                      color: active ? C.white : C.gray600,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = C.white }}
                  >
                    {t.charAt(0) + t.slice(1).toLowerCase()}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Post Text</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="e.g. Move in this month and get 50% off your first month..."
              style={{ ...inputStyle, resize: 'none' }}
            />
          </div>
          <div onPaste={handlePaste} tabIndex={0} style={{ outline: 'none' }}>
            <label style={labelStyle}>Photo (optional)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={imageUrl.startsWith('data:') ? '' : imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                onPaste={handlePaste}
                placeholder={imageUrl.startsWith('data:') ? 'Photo uploaded from device' : 'Paste an image URL...'}
                style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, outline: 'none' }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12.5, fontWeight: 500, color: C.gray600, background: C.white, flexShrink: 0, cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
              >
                <Upload size={13} />
                Upload
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChosen} style={{ display: 'none' }} />
            </div>
            <p style={{ marginTop: 4, fontSize: 11, color: C.gray400 }}>or press Ctrl+V to paste a screenshot</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 }}>
            <div>
              <label style={labelStyle}>Button (optional)</label>
              <select
                value={ctaLabel}
                onChange={(e) => setCtaLabel(e.target.value)}
                style={{ ...inputStyle, color: C.gray700 }}
              >
                {CTA_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Button link</label>
              <input
                value={ctaUrl}
                onChange={(e) => setCtaUrl(e.target.value)}
                disabled={!ctaLabel}
                placeholder="https://..."
                style={{ ...inputStyle, background: !ctaLabel ? C.gray50 : C.white, color: !ctaLabel ? C.gray300 : C.gray700 }}
              />
            </div>
          </div>
          <div>
            <label style={labelStyle}>{showsOnLabel}</label>
            <input
              type="date"
              value={expiresDate}
              min={minDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              style={{ ...inputStyle, color: C.gray700 }}
            />
            <p style={{ marginTop: 4, fontSize: 11, color: C.gray400 }}>
              {type === 'OFFER'
                ? `The offer disappears from ${surface} after this date.`
                : `The post disappears from ${surface} after this date.`}
            </p>
          </div>
          <button
            onClick={submit}
            disabled={!text.trim() || !expiresDate}
            style={{ marginTop: 4, width: '100%', padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500, border: 'none', cursor: (!text.trim() || !expiresDate) ? 'default' : 'pointer', opacity: (!text.trim() || !expiresDate) ? 0.5 : 1 }}
            onMouseEnter={(e) => { if (text.trim() && expiresDate) e.currentTarget.style.background = C.emerald700 }}
            onMouseLeave={(e) => { if (text.trim() && expiresDate) e.currentTarget.style.background = C.emerald600 }}
          >
            {isEdit ? 'Save Changes' : 'Publish Post'}
          </button>
        </div>

        <div>
          <label style={labelStyle}>Preview</label>
          <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, overflow: 'hidden', background: C.white, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
            {imageUrl ? (
              <img src={imageUrl} alt="" style={{ width: '100%', height: 144, objectFit: 'cover', background: C.gray100 }} />
            ) : (
              <div style={{ width: '100%', height: 144, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TYPE_GRADIENT[type] }}>
                <Icon size={32} style={{ color: 'rgba(255,255,255,0.9)' }} />
              </div>
            )}
            <div style={{ padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 11, color: C.gray500 }}>
                <MapPin size={12} />
                {facility}
              </div>
              <span
                style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 500, marginBottom: 8, ...previewChipStyle }}
              >
                {type}
              </span>
              <p style={{ fontSize: 12.5, color: C.gray700, lineHeight: 1.375, minHeight: '3em' }}>
                {text.trim() || 'Your post text will appear here...'}
              </p>
              {ctaLabel && (
                <button style={{ marginTop: 12, width: '100%', padding: '6px 12px', borderRadius: 8, border: '1px solid ' + C.gray300, fontSize: 12, fontWeight: 500, color: C.gray700, background: C.white, cursor: 'pointer' }}>
                  {ctaLabel}
                </button>
              )}
              <p style={{ marginTop: 8, fontSize: 11, color: C.gray400 }}>Visible on {surface} until {showsUntil}</p>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
