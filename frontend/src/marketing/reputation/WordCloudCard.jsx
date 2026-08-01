import { useMemo } from 'react'
import { C, FONT } from '../theme'

const MIN_SIZE = 10
const MAX_SIZE = 28
const PAD = 2 // breathing room between packed words, px
// Packing reference canvas - deliberately wide/flat (matches the card's own
// shape) so the cluster it produces is wide/flat too, instead of the roughly
// circular blob a square canvas produces (which then either forces the box
// too tall to fill the card's width, or leaves empty margins on the sides).
const REF_WIDTH = 1000
const REF_HEIGHT = 200

// Color leans toward red/emerald based on how lopsided a word's sentiment
// split is, so the cloud reads as a diagnostic ("what's driving low ratings")
// rather than a random-color decoration.
function wordColor({ positive, negative, count }) {
  if (positive + negative === 0) return C.gray600
  const skew = (positive - negative) / count
  if (skew <= -0.35) return C.red600
  if (skew >= 0.5) return C.emerald600
  return C.gray700
}

let _measureCtx = null
function measureText(word, fontSize, weight) {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  _measureCtx.font = `${weight} ${fontSize}px ${FONT}`
  return { boxW: _measureCtx.measureText(word).width, boxH: fontSize * 1.15 }
}

// Real word-cloud packing (à la d3-cloud, simplified to AABB collision instead
// of per-pixel sprite masks): walk an outward spiral from center for each
// word - largest first - and drop it at the first spot that doesn't overlap
// anything already placed.
function packWords(words, width, height) {
  const cx = width / 2
  const cy = height / 2
  const yScale = height / width
  const placed = []
  const positioned = []

  for (const w of words) {
    const { boxW, boxH } = w.box
    let t = 0
    const maxT = 2500
    while (t < maxT) {
      const angle = 0.1 * t
      const radius = 0.5 * t
      const x = cx + radius * Math.cos(angle) - boxW / 2
      const y = cy + radius * Math.sin(angle) * yScale - boxH / 2
      const x0 = x - PAD, y0 = y - PAD, x1 = x + boxW + PAD, y1 = y + boxH + PAD
      const inBounds = x0 >= 0 && y0 >= 0 && x1 <= width && y1 <= height
      if (inBounds) {
        const collides = placed.some((p) => !(x1 < p.x0 || x0 > p.x1 || y1 < p.y0 || y0 > p.y1))
        if (!collides) {
          placed.push({ x0, y0, x1, y1 })
          positioned.push({ ...w, x, y })
          break
        }
      }
      t += 1
    }
    // Words that never find a free spot (very long tail in a small canvas)
    // are simply omitted - matches d3-cloud's own give-up behavior.
  }
  return positioned
}

// Crop to the actual cluster bounds on all four sides - the reference canvas
// above is deliberately generous so the spiral has room to work, but the
// visible box should hug exactly what got drawn, not the scratch space.
function tightBox(positioned, pad) {
  if (!positioned.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  positioned.forEach((w) => {
    minX = Math.min(minX, w.x)
    minY = Math.min(minY, w.y)
    maxX = Math.max(maxX, w.x + w.box.boxW)
    maxY = Math.max(maxY, w.y + w.box.boxH)
  })
  return { minX: minX - pad, minY: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
}

export default function WordCloudCard({ words, activeWord, onSelectWord }) {
  const sized = useMemo(() => {
    const maxCount = Math.max(...words.map((w) => w.count), 1)
    return words.map((w) => {
      const fontSize = Math.round(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * Math.sqrt(w.count / maxCount))
      const weight = fontSize > 22 ? 800 : fontSize > 15 ? 700 : 600
      return { ...w, fontSize, weight, box: measureText(w.word, fontSize, weight) }
    })
  }, [words])

  // Packed once against the fixed reference canvas above, not the live DOM
  // width - rendering it as an SVG with a viewBox is what makes this actually
  // responsive (scales with the container, and with browser zoom, exactly
  // like any vector graphic) without re-running the layout on every resize.
  const positioned = useMemo(() => packWords(sized, REF_WIDTH, REF_HEIGHT), [sized])
  const box = useMemo(() => tightBox(positioned, 6), [positioned])

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>Word Cloud</h3>
        {activeWord && (
          <button
            onClick={() => onSelectWord(null)}
            style={{ fontSize: 11.5, color: C.gray500, border: 'none', background: 'transparent', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Clear "{activeWord}"
          </button>
        )}
      </div>
      <p style={{ fontSize: 11.5, color: C.gray400, marginBottom: 10 }}>
        What customers mention most across every review in this range and property. Size = frequency; red leans negative, green leans positive. Click a word to jump to the matching reviews below, highlighted.
      </p>

      {!box ? (
        <div style={{ textAlign: 'center', color: C.gray400, fontSize: 12.5, padding: '24px 0' }}>No review text matches this filter.</div>
      ) : (
        <svg
          viewBox={`${box.minX} ${box.minY} ${box.width} ${box.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: '100%', height: 'auto', display: 'block' }}
        >
          {positioned.map((w) => {
            const active = activeWord === w.word
            const baselineY = w.y + w.box.boxH * 0.8
            return (
              <g
                key={w.word}
                onClick={() => onSelectWord(active ? null : w.word)}
                style={{ cursor: 'pointer' }}
              >
                <title>{`${w.word}: ${w.count}`}</title>
                {active && (
                  <rect
                    x={w.x - 4}
                    y={w.y - 2}
                    width={w.box.boxW + 8}
                    height={w.box.boxH + 4}
                    rx={5}
                    fill={C.gray900}
                  />
                )}
                <text
                  x={w.x}
                  y={baselineY}
                  fontSize={w.fontSize}
                  fontWeight={w.weight}
                  fontFamily={FONT}
                  fill={active ? C.white : wordColor(w)}
                >
                  {w.word}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}
