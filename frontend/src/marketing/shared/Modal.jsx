import { useEffect, useRef, useState } from 'react'
import { isBypassing } from '../../lib/dialogGuard'
import { useExit, MOTION } from '../../lib/motion'
import { useIsMobile } from '../../lib/useIsMobile'
import { useSheetStack, useSheetEntering, SHEET_SHADOW, SHEET_EDGE } from '../../lib/sheetStack'
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
// `placement` (Neil, 11/01/2026): a desktop popup is a SHEET from the right
// edge by default (style.css "Sheets"); a question passes placement="center".
export default function Modal({ title, onClose, children, width, isDirty = false, onSave, placement = 'sheet' }) {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const isMobile = useIsMobile()
  const sheet = !isMobile && placement === 'sheet'
  const panelRef = useRef(null)
  // Exit motion (lib/motion.js): a close the Modal performs itself plays the
  // exit first - a sheet's slide-out runs --dur-md (220ms), a card's 150.
  const [closing, exit] = useExit(onClose, sheet ? MOTION.md : MOTION.exit)
  const requestClose = () => { if (isDirty && !isBypassing()) setConfirming(true); else exit() }
  // z 50 is this overlay's own (below the app's 3500+ drawers and Modals).
  useSheetStack(panelRef, sheet, closing, 50)
  // The body's cascade plays only while the sheet arrives.
  const entering = useSheetEntering(sheet)
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, isDirty])
  const saveAndClose = async () => {
    if (!onSave) { setConfirming(false); exit(); return }
    setSaving(true)
    try { await onSave() } finally { setSaving(false); setConfirming(false) }
  }

  // Every caller of this Modal is a real content form (add/edit/detail), so it
  // always takes the app-wide popup size (.nx-popup: 60vw x 60vh). The width
  // token only matters when it asks for something bigger (max-w-4xl and up).
  const tokenWidth = MAX_W[width] || 0

  return (
    <div
      className={`nx-overlay${closing ? ' is-closing' : ''}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: sheet ? 'stretch' : 'center',
        justifyContent: sheet ? 'flex-end' : 'center',
        background: alpha(C.black, 0.3),
        padding: sheet ? 0 : 16,
        fontFamily: FONT,
      }}
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        className={sheet ? `nx-sheet-right nx-popup${entering ? ' is-entering' : ''}` : 'nx-panel nx-popup'}
        style={{
          ...(tokenWidth > 900 ? { width: `max(60vw, min(${tokenWidth}px, 100%))` } : null),
          // The sheet runs the full height against the right edge, rounded
          // only where it meets the page (.nx-popup's 85vh cap is overridden).
          ...(sheet ? { height: '100%', maxHeight: '100%', minHeight: 0, borderLeft: SHEET_EDGE } : null),
          display: 'flex',
          flexDirection: 'column',
          borderRadius: sheet ? '16px 0 0 16px' : 16,
          background: C.white,
          boxShadow: sheet ? SHEET_SHADOW : '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
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
            borderTopRightRadius: sheet ? 0 : 16,
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
        <div className={sheet ? 'nx-cascade' : undefined} style={{ padding: 20, flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>{children}</div>
      </div>
      {confirming && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: alpha(C.black, 0.2) }}
          onClick={(e) => e.stopPropagation()}>
          <div className="nx-popup" style={{ background: C.white, borderRadius: 14, padding: 20, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.gray900, marginBottom: 6 }}>Save your changes?</div>
            <div style={{ fontSize: 13, color: C.gray500, lineHeight: 1.5, marginBottom: 18 }}>
              You have unsaved changes. Closing now will discard them.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
              <button onClick={() => setConfirming(false)} style={{ background: C.gray100, color: C.gray700, border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Keep Editing</button>
              <button onClick={exit} style={{ background: C.gray100, color: C.gray700, border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Discard</button>
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
