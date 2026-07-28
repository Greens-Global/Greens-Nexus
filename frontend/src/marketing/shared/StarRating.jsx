import { Star } from 'lucide-react'
import { C } from '../theme'

// Renders a fractional fill per star (e.g. 4.6 -> four full stars + a star
// that's 60% filled) rather than rounding to the nearest whole star, which
// would misrepresent 4.6 as a perfect 5.
export default function StarRating({ value, size = 11, max = 5 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      {Array.from({ length: max }).map((_, i) => {
        const fill = Math.max(0, Math.min(1, value - i))
        return (
          // lineHeight:0 + both stars absolutely pinned to top/left keeps the
          // amber fill layer exactly over the grey base - an inline fill star
          // would sit a few px lower on the text baseline and look misaligned.
          <span key={i} style={{ position: 'relative', display: 'inline-block', width: size, height: size, lineHeight: 0 }}>
            <Star size={size} color={C.gray200} style={{ position: 'absolute', top: 0, left: 0, display: 'block' }} />
            {fill > 0 && (
              <span style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${fill * 100}%`, overflow: 'hidden' }}>
                <Star size={size} color={C.amber500} fill={C.amber500} style={{ position: 'absolute', top: 0, left: 0, display: 'block' }} />
              </span>
            )}
          </span>
        )
      })}
    </span>
  )
}
