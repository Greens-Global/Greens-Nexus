import { Star } from 'lucide-react'
import { C } from '../theme'

// Renders a fractional fill per star (e.g. 4.6 -> four full stars + a star
// that's 60% filled) rather than rounding to the nearest whole star, which
// would misrepresent 4.6 as a perfect 5.
export default function StarRating({ value, size = 11, max = 5 }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
      {Array.from({ length: max }).map((_, i) => {
        const fill = Math.max(0, Math.min(1, value - i))
        return (
          <span key={i} style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
            <Star size={size} color={C.gray200} style={{ position: 'absolute', inset: 0 }} />
            {fill > 0 && (
              <span style={{ position: 'absolute', inset: 0, overflow: 'hidden', width: `${fill * 100}%` }}>
                <Star size={size} color={C.amber400} fill={C.amber400} />
              </span>
            )}
          </span>
        )
      })}
    </span>
  )
}
