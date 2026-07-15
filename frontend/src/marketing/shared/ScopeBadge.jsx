import { C, FONT } from '../theme'

export default function ScopeBadge({ label }) {
  return (
    <h2 style={{ fontSize: 16, fontWeight: 700, color: C.gray900, lineHeight: 1.25, fontFamily: FONT, margin: 0 }}>
      {label}
    </h2>
  )
}
