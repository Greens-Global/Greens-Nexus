import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { C, FONT, alpha } from '../theme'

// Map the Tailwind max-w-* tokens the export passes as `width` to pixel maxWidths.
const MAX_W = {
  'max-w-sm': 384,
  'max-w-md': 448,
  'max-w-lg': 512,
  'max-w-xl': 576,
  'max-w-2xl': 672,
  'max-w-3xl': 768,
  'max-w-4xl': 896,
  'max-w-5xl': 1024,
  'max-w-6xl': 1152,
  'max-w-7xl': 1280,
}

// `isDirty` + `onSave`: an unintentional exit (overlay click, Escape, the X
// button) used to silently discard an in-progress form. When isDirty is set,
// those three now ask first instead of closing straight away.
export default function Modal({ title, onClose, children, width, isDirty = false, onSave }) {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const requestClose = () => { if (isDirty) setConfirming(true); else onClose() }
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, isDirty])
  const saveAndClose = async () => {
    if (!onSave) { setConfirming(false); onClose(); return }
    setSaving(true)
    try { await onSave() } finally { setSaving(false); setConfirming(false) }
  }

  // Every caller of this Modal is a real content form (add/edit/detail), never
  // a small confirm, so it always sizes to ~60% of the viewport - clamped so
  // it never overflows a narrow laptop or shrinks below a usable floor -
  // matching the app-wide modal default in style.css. The width token is kept
  // only as a floor: a caller that asked for something bigger than 60vw (e.g.
  // max-w-4xl on a wide report) still gets that larger fixed size.
  const tokenWidth = MAX_W[width] || 0
  const maxWidth = tokenWidth > 900 ? tokenWidth : 'clamp(520px, 60vw, 980px)'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: alpha(C.black, 0.3),
        padding: 16,
        fontFamily: FONT,
      }}
      onClick={requestClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth,
          maxHeight: '85vh',
          overflowY: 'auto',
          borderRadius: 16,
          background: C.white,
          boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid ' + C.gray100,
            position: 'sticky',
            top: 0,
            background: C.white,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
          }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 600, color: C.gray900, margin: 0 }}>{title}</h2>
          <button
            onClick={requestClose}
            style={{
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              color: C.gray400,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
      {confirming && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: alpha(C.black, 0.2) }}
          onClick={(e) => e.stopPropagation()}>
          <div style={{ width: 340, maxWidth: '90vw', background: C.white, borderRadius: 14, padding: 20, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.15)' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.gray900, marginBottom: 6 }}>Save your changes?</div>
            <div style={{ fontSize: 13, color: C.gray500, lineHeight: 1.5, marginBottom: 18 }}>
              You have unsaved changes. Closing now will discard them.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setConfirming(false)} style={{ background: C.gray100, color: C.gray700, border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Keep Editing</button>
              <button onClick={onClose} style={{ background: C.gray100, color: C.gray700, border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Discard</button>
              {onSave && (
                <button onClick={saveAndClose} disabled={saving} style={{ background: C.emerald600, color: C.white, border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
