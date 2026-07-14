import { useEffect } from 'react'
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

export default function Modal({ title, onClose, children, width = 'max-w-2xl' }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const maxWidth = MAX_W[width] || 672

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
      onClick={onClose}
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
            onClick={onClose}
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
    </div>
  )
}
