import { useEffect, useRef, useState } from 'react'
import { Settings, ChevronDown, Megaphone, PenSquare, Wallet, Target, MapPin, Share2, Camera } from 'lucide-react'
import { C, FONT } from '../theme'

const QUICK_ACTIONS = [
  { key: 'create-campaign', label: 'Create Campaign', icon: Megaphone, tab: 'google-ads', action: 'create-campaign' },
  { key: 'edit-campaign', label: 'Edit Campaign', icon: PenSquare, tab: 'google-ads', action: 'edit-campaign' },
  { key: 'set-budget', label: 'Set Budget', icon: Wallet, tab: 'google-ads', action: 'set-budget' },
  { key: 'set-goals', label: 'Set Goals', icon: Target, tab: 'insights', action: 'set-goals' },
  { key: 'google-posts', label: 'Google Posts', icon: MapPin, tab: 'listings', action: 'google-posts' },
  { key: 'facebook-posts', label: 'Facebook Posts', icon: Share2, tab: 'listings', action: 'facebook-posts' },
  { key: 'instagram-posts', label: 'Instagram Posts', icon: Camera, tab: 'listings', action: 'instagram-posts' },
]

export default function ManageButton({ onNavigate }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div style={{ position: 'relative', fontFamily: FONT }} ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.gray800)}
        onMouseLeave={(e) => (e.currentTarget.style.background = C.gray900)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 9999,
          fontSize: 13,
          fontWeight: 500,
          background: C.gray900,
          color: C.white,
          border: 'none',
          transition: 'all .15s',
          cursor: 'pointer',
        }}
      >
        <Settings size={14} />
        Manage
        <ChevronDown
          size={13}
          color={C.gray400}
          style={{ transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            width: 240,
            borderRadius: 12,
            border: '1px solid ' + C.gray200,
            background: C.white,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 30,
            padding: 6,
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              fontSize: 10.5,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.025em',
              color: C.gray400,
            }}
          >
            Quick Actions
          </div>
          {QUICK_ACTIONS.map((a) => {
            const Icon = a.icon
            return (
              <button
                key={a.key}
                onClick={() => {
                  onNavigate(a.tab, a.action)
                  setOpen(false)
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 8,
                  fontSize: 13,
                  color: C.gray600,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <Icon size={15} color={C.gray400} />
                {a.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
