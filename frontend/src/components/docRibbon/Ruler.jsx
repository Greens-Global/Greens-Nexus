// Word's horizontal ruler: inches across the page, the margins shaded. Display
// only - drag to set an indent is not built.
import { PAGE_SIZE_DIMS, DEFAULT_PAGE_SETUP, marginsOf } from '../../lib/pageSetup';

export default function Ruler({ pageSetup, zoom = 1 }) {
  const ps = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const dims = PAGE_SIZE_DIMS[ps.size] || PAGE_SIZE_DIMS.letter;
  const wIn = ps.orientation === 'landscape' ? dims.hIn : dims.wIn;
  const m = marginsOf(ps);
  const px = 96 * zoom;
  const ticks = [];
  for (let i = 0; i <= wIn * 8; i += 1) {
    const inch = i / 8;
    if (inch > wIn) break;
    ticks.push({ left: inch * px, major: i % 8 === 0, mid: i % 4 === 0, label: i % 8 === 0 && inch > 0 && inch < wIn ? String(Math.round(inch - m.left)) : '' });
  }
  return (
    <div className="doc-ruler" style={{ width: wIn * px }} aria-hidden="true">
      <div className="doc-ruler-margin" style={{ left: 0, width: m.left * px }} />
      <div className="doc-ruler-margin" style={{ right: 0, width: m.right * px }} />
      {ticks.map((t) => (
        <span key={t.left} className={`doc-ruler-tick${t.major ? ' is-major' : t.mid ? ' is-mid' : ''}`} style={{ left: t.left }}>
          {t.label && <em>{t.label}</em>}
        </span>
      ))}
    </div>
  );
}
