import { C } from '../theme'

const STYLES = {
  Google: { label: 'G', bg: C.blue500, text: C.white },
  Yelp: { label: 'Y', bg: C.red500, text: C.white },
  Facebook: { label: 'f', bg: C.indigo600, text: C.white },
  'Storage Facility Finder': { label: 'SFF', bg: C.emerald500, text: C.white },
  Other: { label: 'O', bg: C.gray400, text: C.white },
}

export default function PlatformBadge({ platform, size = 20 }) {
  const s = STYLES[platform]
  const fontSize = s.label.length > 1 ? size * 0.34 : size * 0.5
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 9999,
        fontWeight: 700,
        flexShrink: 0,
        background: s.bg,
        color: s.text,
        width: size,
        height: size,
        fontSize,
      }}
      title={platform}
    >
      {s.label}
    </span>
  )
}
