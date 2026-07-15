import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import Modal from '../shared/Modal'
import { C } from '../theme'

const CATEGORIES = ['EXTERIOR', 'INTERIOR', 'TEAM']

export default function AddPhotoModal({ facilities, defaultFacility, onAdd, onClose }) {
  const [facility, setFacility] = useState(defaultFacility)
  const [category, setCategory] = useState('EXTERIOR')
  const [url, setUrl] = useState('')
  const fileInputRef = useRef(null)

  function onFileChosen(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setUrl(String(reader.result))
    reader.readAsDataURL(file)
  }

  function submit() {
    if (!url.trim()) return
    onAdd({ facility, category, url: url.trim() })
  }

  return (
    <Modal title="Add Photo" onClose={onClose} width="max-w-md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }}>Property</label>
          <select
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, color: C.gray700, outline: 'none' }}
          >
            {facilities.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }}>Category</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {CATEGORIES.map((c) => {
              const active = category === c
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
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
                  {c.charAt(0) + c.slice(1).toLowerCase()}
                </button>
              )
            })}
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }}>Photo</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={url.startsWith('data:') ? '' : url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={url.startsWith('data:') ? 'Photo uploaded from device' : 'Paste an image URL...'}
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
        </div>
        {url && (
          <img src={url} alt="" style={{ width: '100%', height: 128, objectFit: 'cover', borderRadius: 8, border: '1px solid ' + C.gray200, background: C.gray100 }} />
        )}
        <button
          onClick={submit}
          disabled={!url.trim()}
          style={{ marginTop: 4, width: '100%', padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500, border: 'none', cursor: url.trim() ? 'pointer' : 'default', opacity: url.trim() ? 1 : 0.5 }}
          onMouseEnter={(e) => { if (url.trim()) e.currentTarget.style.background = C.emerald700 }}
          onMouseLeave={(e) => { if (url.trim()) e.currentTarget.style.background = C.emerald600 }}
        >
          Add Photo
        </button>
      </div>
    </Modal>
  )
}
