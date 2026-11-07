// Drawings (Neil, 11/07/2026: "put a drawing of what they look like"). A
// library of line drawings the courses show by name - RVs, boats, the
// kinds of space, how to measure, locks, unit types - drawn in one style:
// a 200 x 110 canvas, the ground at y=96, a 2.25px ink line with round
// joins, a soft fill for bodies, the green tint for glass, one accent for
// what the drawing is about. Everything is theme tokens, so a drawing is
// right in dark mode and the Warm sand theme without a second copy.
// backend/kb_blocks.py DRAWING_NAMES lists the same names; drawings.test.jsx
// keeps the two lists equal.

const INK = 'var(--kb-ink)';
const DIM = 'var(--kb-dim)';
const LINE = 'var(--kb-line)';
const BODY = 'var(--kb-paper)';
const GLASS = 'var(--kb-green-soft)';
const ACCENT = 'var(--kb-green)';
const CARD = 'var(--kb-card)';
const S = { fill: BODY, stroke: INK, strokeWidth: 2.25, strokeLinejoin: 'round', strokeLinecap: 'round' };
const G = { fill: GLASS, stroke: INK, strokeWidth: 1.75, strokeLinejoin: 'round' };
const L = { fill: 'none', stroke: INK, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const T = { fill: 'none', stroke: DIM, strokeWidth: 1.5, strokeLinecap: 'round' };

const Ground = ({ y = 96 }) => <line x1="4" y1={y} x2="196" y2={y} stroke={LINE} strokeWidth="2" strokeLinecap="round" />;
const Wheel = ({ x, y = 86, r = 10 }) => <g><circle cx={x} cy={y} r={r} fill={INK} /><circle cx={x} cy={y} r={r * 0.42} fill={CARD} /></g>;
const Win = ({ x, y, w, h, r = 3 }) => <rect x={x} y={y} width={w} height={h} rx={r} {...G} />;
// a trailer tongue running left from the body's front at `x`, with the coupler and the jack
const Tongue = ({ x, y = 74, jack = true }) => (
  <g>
    <line x1={x} y1={y} x2="14" y2={y} {...L} />
    <rect x="8" y={y - 4} width="10" height="8" rx="2" fill={INK} />
    {jack && <><line x1="30" y1={y} x2="30" y2="92" {...L} /><line x1="25" y1="92" x2="35" y2="92" {...L} /></>}
  </g>
);
// a boat trailer: frame, tongue, one wheel
const Trailer = ({ x1 = 24, x2 = 184, y = 76, wx = 120 }) => (
  <g>
    <line x1={x1} y1={y} x2={x2} y2={y} {...L} />
    <line x1={x1} y1={y} x2="14" y2={y} {...L} />
    <rect x="8" y={y - 4} width="10" height="8" rx="2" fill={INK} />
    <Wheel x={wx} y={86} r={9} />
  </g>
);
const Outboard = ({ x, y = 44, tall = 22 }) => (
  <g>
    <rect x={x} y={y} width="13" height={tall} rx="3" {...S} />
    <line x1={x + 6} y1={y + tall} x2={x + 6} y2={y + tall + 18} {...L} />
    <path d={`M ${x + 2} ${y + tall + 18} L ${x + 14} ${y + tall + 18} L ${x + 10} ${y + tall + 24} L ${x + 5} ${y + tall + 24} Z`} fill={INK} />
  </g>
);
// a dimension line with arrowheads at both ends
const Dim = ({ x1, y1, x2, y2, color = ACCENT }) => {
  const dx = x2 - x1; const dy = y2 - y1; const len = Math.hypot(dx, dy) || 1; const ux = dx / len; const uy = dy / len;
  const head = (x, y, dir) => `M ${x} ${y} L ${x - dir * ux * 7 - uy * 3.5} ${y - dir * uy * 7 + ux * 3.5} L ${x - dir * ux * 7 + uy * 3.5} ${y - dir * uy * 7 - ux * 3.5} Z`;
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="2" />
      <path d={head(x1, y1, -1)} fill={color} /><path d={head(x2, y2, 1)} fill={color} />
      <line x1={x1} y1={y1 - uy * 0 - ux * 0 - 6 * (uy ? 0 : 1)} x2={x1} y2={y1 + (uy ? 0 : 6)} stroke={color} strokeWidth="1.5" />
      <line x1={x2} y1={y2 - (uy ? 0 : 6)} x2={x2} y2={y2 + (uy ? 0 : 6)} stroke={color} strokeWidth="1.5" />
    </g>
  );
};

// ── RVs (facing left) ───────────────────────────────────────────────────
const TravelTrailerBody = ({ spare = false, ac = false, x1 = 40, x2 = 186 }) => (
  <g>
    {ac && <rect x="96" y="12" width="26" height="9" rx="2" {...S} />}
    <path d={`M ${x1} 84 L ${x1} 30 Q ${x1} 20 ${x1 + 10} 20 L ${x2 - 10} 20 Q ${x2} 20 ${x2} 30 L ${x2} 84 Z`} {...S} />
    <Win x={x1 + 18} y="32" w="30" h="18" /><Win x={x1 + 66} y="32" w="30" h="18" />
    <rect x={x2 - 36} y="36" width="20" height="48" rx="2" fill="none" stroke={INK} strokeWidth="1.75" />
    <circle cx={x2 - 30} cy="60" r="1.6" fill={INK} />
    <line x1={x1} y1="66" x2={x2} y2="66" stroke={DIM} strokeWidth="1.25" />
    {spare && <circle cx={x2 + 4} cy="58" r="9" fill={INK} stroke={CARD} strokeWidth="1.5" />}
    <Wheel x={(x1 + x2) / 2 + 6} />
  </g>
);

const DRAW = {
  'rv-class-a': () => (
    <g>
      <rect x="78" y="14" width="22" height="9" rx="2" {...S} /><rect x="128" y="14" width="22" height="9" rx="2" {...S} />
      <path d="M 22 84 L 22 32 Q 22 22 32 22 L 182 22 Q 190 22 190 30 L 190 84 Z" {...S} />
      <path d="M 24 60 L 24 32 Q 24 26 32 26 L 48 26 L 48 60 Z" {...G} />
      <Win x="58" y="34" w="30" h="18" /><Win x="96" y="34" w="30" h="18" /><Win x="134" y="34" w="28" h="18" />
      <path d="M 22 68 Q 100 60 190 70" fill="none" stroke={ACCENT} strokeWidth="2.5" />
      <line x1="180" y1="26" x2="180" y2="84" {...L} /><line x1="186" y1="26" x2="186" y2="84" {...L} />
      {[34, 44, 54, 64, 74].map((y) => <line key={y} x1="180" y1={y} x2="186" y2={y} {...L} />)}
      <Wheel x="52" /><Wheel x="146" /><Wheel x="170" />
      <Ground />
    </g>
  ),
  'rv-class-b': () => (
    <g>
      <path d="M 18 84 L 18 62 L 32 44 Q 36 38 46 38 L 62 38 L 62 24 Q 62 16 72 16 L 174 16 Q 184 16 184 26 L 184 84 Z" {...S} />
      <path d="M 24 58 L 36 44 Q 38 42 42 42 L 60 42 L 60 58 Z" {...G} />
      <Win x="74" y="28" w="34" h="20" /><Win x="118" y="28" w="40" h="20" />
      <line x1="112" y1="52" x2="112" y2="84" stroke={INK} strokeWidth="1.75" /><line x1="160" y1="52" x2="160" y2="84" stroke={INK} strokeWidth="1.75" />
      <line x1="118" y1="60" x2="130" y2="60" stroke={INK} strokeWidth="2.5" />
      <line x1="18" y1="70" x2="184" y2="70" stroke={DIM} strokeWidth="1.25" />
      <Wheel x="44" r="9" /><Wheel x="156" r="9" />
      <Ground />
    </g>
  ),
  'rv-class-c': () => (
    <g>
      <path d="M 14 84 L 14 64 L 26 46 L 56 46 L 56 84 Z" {...S} />
      <path d="M 24 60 L 32 50 L 54 50 L 54 60 Z" {...G} />
      <path d="M 34 44 L 34 22 Q 34 14 44 14 L 182 14 Q 190 14 190 22 L 190 84 L 56 84 L 56 44 Z" {...S} />
      <Win x="42" y="22" w="12" h="14" /><Win x="80" y="26" w="32" h="20" /><Win x="124" y="26" w="36" h="20" />
      <rect x="166" y="34" width="16" height="50" rx="2" fill="none" stroke={INK} strokeWidth="1.75" />
      <line x1="56" y1="70" x2="190" y2="70" stroke={DIM} strokeWidth="1.25" />
      <Wheel x="38" /><Wheel x="150" /><Wheel x="170" />
      <Ground />
    </g>
  ),
  'rv-travel-trailer': () => (<g><TravelTrailerBody /><Tongue x="40" /><Ground /></g>),
  'rv-fifth-wheel': () => (
    <g>
      <rect x="104" y="6" width="22" height="8" rx="2" {...S} />
      <path d="M 30 58 L 30 22 Q 30 14 38 14 L 180 14 Q 188 14 188 22 L 188 84 L 82 84 L 82 58 Z" {...S} />
      <Win x="40" y="24" w="30" h="18" /><Win x="98" y="30" w="30" h="20" /><Win x="138" y="30" w="28" h="20" />
      <line x1="82" y1="70" x2="188" y2="70" stroke={DIM} strokeWidth="1.25" />
      <line x1="52" y1="58" x2="52" y2="68" {...L} /><rect x="44" y="68" width="16" height="5" rx="1.5" fill={INK} />
      <line x1="88" y1="84" x2="88" y2="92" {...L} /><line x1="84" y1="92" x2="92" y2="92" {...L} />
      <Wheel x="130" r="9" /><Wheel x="154" r="9" />
      <Ground />
    </g>
  ),
  'rv-toy-hauler': () => (
    <g>
      <path d="M 36 84 L 36 30 Q 36 20 46 20 L 168 20 Q 176 20 176 28 L 176 84 Z" {...S} />
      <Win x="54" y="32" w="30" h="18" /><Win x="100" y="32" w="30" h="18" />
      <line x1="36" y1="66" x2="176" y2="66" stroke={DIM} strokeWidth="1.25" />
      <path d="M 176 82 L 198 94 L 198 98 L 176 86 Z" fill={ACCENT} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="148" y1="24" x2="148" y2="84" stroke={INK} strokeWidth="1.5" strokeDasharray="3 3" />
      <Tongue x="36" />
      <Wheel x="96" r="9" /><Wheel x="120" r="9" />
      <Ground />
    </g>
  ),
  'rv-pop-up': () => (
    <g>
      <rect x="22" y="38" width="30" height="16" rx="3" {...G} /><rect x="148" y="38" width="30" height="16" rx="3" {...G} />
      <path d="M 54 58 L 54 36 Q 54 28 64 28 L 136 28 Q 146 28 146 36 L 146 58" {...G} />
      <rect x="48" y="22" width="104" height="7" rx="2" {...S} />
      <rect x="44" y="58" width="112" height="26" rx="3" {...S} />
      <Tongue x="44" />
      <Wheel x="102" r="9" />
      <Ground />
    </g>
  ),
  'rv-truck-camper': () => (
    <g>
      <path d="M 14 84 L 14 62 L 26 46 L 62 46 L 62 84 Z" {...S} />
      <path d="M 24 60 L 32 50 L 60 50 L 60 60 Z" {...G} />
      <rect x="62" y="62" width="114" height="22" rx="2" {...S} />
      <path d="M 40 36 L 40 20 Q 40 12 48 12 L 180 12 Q 188 12 188 20 L 188 64 L 64 64 L 64 36 Z" {...S} />
      <Win x="46" y="18" w="14" h="12" /><Win x="100" y="24" w="30" h="18" />
      <rect x="150" y="30" width="18" height="34" rx="2" fill="none" stroke={INK} strokeWidth="1.75" />
      <Wheel x="40" /><Wheel x="146" />
      <Ground />
    </g>
  ),
  'rv-teardrop': () => (
    <g>
      <path d="M 42 84 Q 38 40 82 30 Q 124 24 160 46 Q 186 64 190 84 Z" {...S} />
      <rect x="70" y="42" width="26" height="18" rx="4" {...G} />
      <line x1="106" y1="40" x2="106" y2="84" stroke={INK} strokeWidth="1.5" />
      <Tongue x="42" y="76" />
      <Wheel x="116" r="9" />
      <Ground />
    </g>
  ),

  // ── boats, on their trailers ──────────────────────────────────────────
  'boat-bass': () => (
    <g>
      <path d="M 22 72 L 44 56 L 178 56 L 178 72 Z" {...S} />
      <line x1="22" y1="72" x2="178" y2="72" stroke={ACCENT} strokeWidth="2.5" />
      <line x1="36" y1="56" x2="36" y2="40" {...L} /><rect x="30" y="34" width="12" height="7" rx="2" fill={INK} />
      <path d="M 96 56 L 100 46 L 112 46 L 112 56" {...G} />
      <Outboard x="180" y="40" tall="20" />
      <Trailer x1="30" x2="180" y="78" wx="118" />
      <Ground />
    </g>
  ),
  'boat-pontoon': () => (
    <g>
      <path d="M 104 40 Q 142 14 180 40 L 180 44 Q 142 20 104 44 Z" fill={ACCENT} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="108" y1="42" x2="108" y2="60" {...L} /><line x1="176" y1="42" x2="176" y2="60" {...L} />
      <line x1="28" y1="46" x2="100" y2="46" {...L} />{[34, 46, 58, 70, 82, 94].map((x) => <line key={x} x1={x} y1="46" x2={x} y2="60" stroke={INK} strokeWidth="1.5" />)}
      <rect x="24" y="60" width="160" height="7" rx="2" {...S} />
      <rect x="26" y="67" width="156" height="12" rx="6" {...S} />
      <Outboard x="184" y="46" tall="20" />
      <Trailer x1="30" x2="184" y="82" wx="118" />
      <Ground />
    </g>
  ),
  'boat-wake': () => (
    <g>
      <path d="M 98 50 Q 118 14 150 16 Q 160 16 162 50" fill="none" stroke={INK} strokeWidth="2.5" />
      <path d="M 106 36 L 158 30" fill="none" stroke={INK} strokeWidth="2" />
      <path d="M 24 72 L 46 48 L 178 50 Q 186 52 186 72 Z" {...S} />
      <path d="M 70 48 L 76 36 L 96 36 L 96 48" {...G} />
      <rect x="186" y="62" width="12" height="6" rx="2" {...S} />
      <line x1="24" y1="72" x2="186" y2="72" stroke={ACCENT} strokeWidth="2.5" />
      <Trailer x1="30" x2="186" y="78" wx="118" />
      <Ground />
    </g>
  ),
  'boat-bowrider': () => (
    <g>
      <path d="M 24 72 L 46 48 L 178 50 Q 186 52 186 72 Z" {...S} />
      <path d="M 86 48 L 92 34 L 112 34 L 112 48" {...G} />
      <line x1="54" y1="54" x2="80" y2="54" stroke={INK} strokeWidth="1.5" /><line x1="120" y1="54" x2="170" y2="54" stroke={INK} strokeWidth="1.5" />
      <line x1="24" y1="72" x2="186" y2="72" stroke={ACCENT} strokeWidth="2.5" />
      <path d="M 184 72 L 184 86 L 192 90 L 192 78 Z" fill={INK} />
      <Trailer x1="30" x2="184" y="78" wx="118" />
      <Ground />
    </g>
  ),
  'boat-center-console': () => (
    <g>
      <rect x="78" y="18" width="56" height="6" rx="2" {...S} />
      <line x1="88" y1="24" x2="88" y2="38" {...L} /><line x1="124" y1="24" x2="124" y2="38" {...L} />
      <path d="M 20 72 L 42 42 L 180 52 L 180 72 Z" {...S} />
      <rect x="92" y="36" width="28" height="22" rx="3" {...G} />
      <line x1="20" y1="72" x2="180" y2="72" stroke={ACCENT} strokeWidth="2.5" />
      <Outboard x="186" y="40" tall="22" /><Outboard x="178" y="44" tall="20" />
      <Trailer x1="30" x2="178" y="78" wx="112" />
      <Ground />
    </g>
  ),
  'boat-cuddy': () => (
    <g>
      <path d="M 22 72 L 40 46 L 100 44 L 108 32 Q 110 28 116 28 L 160 28 L 176 48 L 182 72 Z" {...S} />
      <circle cx="62" cy="54" r="4" {...G} /><circle cx="80" cy="53" r="4" {...G} />
      <path d="M 110 30 L 114 32 L 158 32 L 170 46 L 112 46 Z" {...G} />
      <line x1="22" y1="72" x2="182" y2="72" stroke={ACCENT} strokeWidth="2.5" />
      <path d="M 180 72 L 180 86 L 188 90 L 188 78 Z" fill={INK} />
      <Trailer x1="30" x2="180" y="78" wx="114" />
      <Ground />
    </g>
  ),
  'boat-sailboat': () => (
    <g>
      <line x1="4" y1="40" x2="196" y2="40" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      <line x1="60" y1="40" x2="60" y2="46" {...L} /><line x1="150" y1="40" x2="150" y2="46" {...L} />
      <path d="M 30 70 L 48 46 L 168 48 L 176 70 Z" {...S} />
      <rect x="96" y="46" width="30" height="8" rx="3" {...G} />
      <path d="M 94 70 L 102 82 L 122 82 L 128 70 Z" fill={INK} />
      <line x1="30" y1="70" x2="176" y2="70" stroke={DIM} strokeWidth="1.5" />
      <Trailer x1="34" x2="176" y="84" wx="150" />
      <Ground />
    </g>
  ),
  'boat-jet-ski': () => (
    <g>
      {[0, 92].map((dx) => (
        <g key={dx}>
          <path d={`M ${26 + dx} 70 L ${36 + dx} 56 L ${70 + dx} 54 L ${96 + dx} 60 L ${100 + dx} 70 Z`} {...S} />
          <path d={`M ${56 + dx} 54 Q ${66 + dx} 44 ${84 + dx} 50`} fill="none" stroke={INK} strokeWidth="2.5" />
          <line x1={46 + dx} y1="54" x2={46 + dx} y2="44" {...L} /><line x1={40 + dx} y1="44" x2={52 + dx} y2="44" {...L} />
          <line x1={26 + dx} y1="70" x2={100 + dx} y2="70" stroke={ACCENT} strokeWidth="2.5" />
        </g>
      ))}
      <Trailer x1="30" x2="190" y="76" wx="118" />
      <Ground />
    </g>
  ),

  // ── the kinds of space ────────────────────────────────────────────────
  'space-open': () => (
    <g>
      <circle cx="168" cy="26" r="9" fill={ACCENT} />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1={168 + 13 * Math.cos((a * Math.PI) / 180)} y1={26 + 13 * Math.sin((a * Math.PI) / 180)} x2={168 + 17 * Math.cos((a * Math.PI) / 180)} y2={26 + 17 * Math.sin((a * Math.PI) / 180)} stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />)}
      <g opacity=".55"><TravelTrailerBody x1="46" x2="150" /><Tongue x="46" /></g>
      {[20, 60, 100, 140, 180].map((x) => <circle key={x} cx={x} cy="101" r="1.3" fill={DIM} />)}
      <line x1="12" y1="92" x2="12" y2="100" {...L} /><line x1="188" y1="92" x2="188" y2="100" {...L} />
      <Ground />
    </g>
  ),
  'space-covered': () => (
    <g>
      <rect x="14" y="10" width="172" height="8" rx="2" {...S} />
      <line x1="26" y1="18" x2="26" y2="96" stroke={INK} strokeWidth="3" /><line x1="174" y1="18" x2="174" y2="96" stroke={INK} strokeWidth="3" />
      <g opacity=".55"><TravelTrailerBody x1="50" x2="150" ac /><Tongue x="50" /></g>
      <Ground />
    </g>
  ),
  'space-enclosed': () => (
    <g>
      <path d="M 20 96 L 20 22 L 100 10 L 180 22 L 180 96 Z" {...S} />
      <rect x="38" y="30" width="124" height="66" fill={GLASS} stroke={INK} strokeWidth="2" />
      {[40, 50, 60, 70, 80, 90].map((y) => <line key={y} x1="40" y1={y} x2="160" y2={y} stroke={INK} strokeWidth="1.25" />)}
      <rect x="92" y="82" width="16" height="4" rx="1" fill={INK} />
      <Ground />
    </g>
  ),

  // ── measuring ─────────────────────────────────────────────────────────
  'measure-length': () => (
    <g>
      <TravelTrailerBody spare x1="44" x2="182" /><Tongue x="44" />
      <Ground />
      <Dim x1="8" y1="106" x2="191" y2="106" />
    </g>
  ),
  'measure-height': () => (
    <g>
      <TravelTrailerBody ac x1="60" x2="190" /><Tongue x="60" />
      <line x1="150" y1="12" x2="150" y2="4" {...L} /><circle cx="150" cy="4" r="1.8" fill={INK} />
      <Ground />
      <Dim x1="22" y1="96" x2="22" y2="4" />
      <line x1="22" y1="4" x2="150" y2="4" stroke={ACCENT} strokeWidth="1" strokeDasharray="3 3" />
    </g>
  ),

  // ── locks ─────────────────────────────────────────────────────────────
  'lock-disc': () => (
    <g>
      <path d="M 70 54 Q 70 30 100 30 Q 130 30 130 54" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <circle cx="100" cy="66" r="32" {...S} />
      <circle cx="100" cy="66" r="24" fill="none" stroke={DIM} strokeWidth="1.25" />
      <circle cx="100" cy="78" r="4" fill={INK} /><rect x="98.5" y="78" width="3" height="9" fill={INK} />
    </g>
  ),
  'lock-cylinder': () => (
    <g>
      <rect x="30" y="40" width="140" height="42" rx="4" {...S} />
      <rect x="110" y="48" width="52" height="26" rx="3" fill={GLASS} stroke={INK} strokeWidth="1.75" />
      <circle cx="68" cy="61" r="14" fill={CARD} stroke={INK} strokeWidth="2.25" />
      <circle cx="68" cy="61" r="9" fill={ACCENT} /><rect x="66.5" y="54" width="3" height="14" fill={CARD} />
      <line x1="40" y1="30" x2="40" y2="40" {...L} /><line x1="160" y1="30" x2="160" y2="40" {...L} />
      <line x1="20" y1="30" x2="180" y2="30" stroke={DIM} strokeWidth="1.5" />
    </g>
  ),
  'lock-padlock': () => (
    <g>
      <path d="M 78 60 L 78 36 Q 78 16 100 16 Q 122 16 122 36 L 122 60" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <rect x="62" y="56" width="76" height="46" rx="6" {...S} />
      <circle cx="100" cy="76" r="5" fill={INK} /><rect x="98" y="76" width="4" height="12" fill={INK} />
    </g>
  ),

  // ── unit types ────────────────────────────────────────────────────────
  'unit-drive-up': () => (
    <g>
      <rect x="30" y="14" width="140" height="82" {...S} />
      <rect x="46" y="26" width="108" height="70" fill={GLASS} stroke={INK} strokeWidth="2" />
      {[36, 46, 56, 66, 76, 86].map((y) => <line key={y} x1="48" y1={y} x2="152" y2={y} stroke={INK} strokeWidth="1.25" />)}
      <rect x="92" y="84" width="16" height="4" rx="1" fill={INK} />
      <Ground />
      <line x1="4" y1="104" x2="196" y2="104" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
    </g>
  ),
  'unit-interior': () => (
    <g>
      <path d="M 8 96 L 70 60 L 130 60 L 192 96 Z" fill={BODY} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M 8 8 L 70 36 L 70 60 L 8 96 Z" fill={CARD} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M 192 8 L 130 36 L 130 60 L 192 96 Z" fill={CARD} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M 70 36 L 130 36 L 130 60 L 70 60 Z" fill={GLASS} stroke={INK} strokeWidth="2" />
      <path d="M 14 20 L 34 29 L 34 80 L 14 90 Z" fill={GLASS} stroke={INK} strokeWidth="1.5" /><path d="M 42 33 L 56 39 L 56 69 L 42 76 Z" fill={GLASS} stroke={INK} strokeWidth="1.5" />
      <path d="M 186 20 L 166 29 L 166 80 L 186 90 Z" fill={GLASS} stroke={INK} strokeWidth="1.5" /><path d="M 158 33 L 144 39 L 144 69 L 158 76 Z" fill={GLASS} stroke={INK} strokeWidth="1.5" />
      <rect x="92" y="18" width="16" height="4" rx="2" fill={ACCENT} />
    </g>
  ),
  'unit-climate': () => (
    <g>
      <rect x="30" y="14" width="100" height="82" {...S} />
      <rect x="44" y="26" width="72" height="70" fill={GLASS} stroke={INK} strokeWidth="2" />
      {[36, 46, 56, 66, 76, 86].map((y) => <line key={y} x1="46" y1={y} x2="114" y2={y} stroke={INK} strokeWidth="1.25" />)}
      <rect x="156" y="20" width="12" height="52" rx="6" fill={CARD} stroke={INK} strokeWidth="2" />
      <rect x="159" y="40" width="6" height="30" rx="3" fill={ACCENT} /><circle cx="162" cy="78" r="9" fill={ACCENT} stroke={INK} strokeWidth="2" />
      {[30, 42, 54].map((y) => <line key={y} x1="172" y1={y} x2="180" y2={y} stroke={DIM} strokeWidth="1.5" />)}
      <Ground />
    </g>
  ),
  // ── the building and its parts (11/07/2026) ───────────────────────────
  // a roll-up door, front on: the hood over the drum, the guides, the
  // corrugated curtain, the bottom bar with its handle and the latch (accent)
  'door-roll-up': () => (
    <g>
      <path d="M 30 22 L 30 14 Q 30 8 36 8 L 164 8 Q 170 8 170 14 L 170 22 Z" {...S} />
      <rect x="30" y="22" width="6" height="74" fill={INK} /><rect x="164" y="22" width="6" height="74" fill={INK} />
      <rect x="36" y="22" width="128" height="64" fill={GLASS} stroke={INK} strokeWidth="2" />
      {[30, 38, 46, 54, 62, 70, 78].map((y) => <line key={y} x1="38" y1={y} x2="162" y2={y} stroke={INK} strokeWidth="1.25" />)}
      <rect x="36" y="86" width="128" height="7" fill={INK} />
      <rect x="92" y="80" width="16" height="4" rx="1" fill={CARD} stroke={INK} strokeWidth="1.5" />
      <rect x="138" y="62" width="30" height="12" rx="2" fill={ACCENT} stroke={INK} strokeWidth="1.75" />
      <rect x="146" y="66" width="12" height="4" rx="1" fill={CARD} />
      <Ground />
    </g>
  ),
  // a hasp, close up: the hinged plate swung over the staple (accent), a shackle through the staple
  'hasp': () => (
    <g>
      <rect x="14" y="24" width="78" height="62" rx="3" {...S} />
      <rect x="108" y="24" width="78" height="62" rx="3" fill={CARD} stroke={INK} strokeWidth="2.25" strokeLinejoin="round" />
      <path d="M 132 92 L 132 64 Q 132 50 144 50 Q 156 50 156 64 L 156 92" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
      <rect x="44" y="46" width="104" height="18" rx="3" {...S} />
      <circle cx="52" cy="55" r="5.5" fill={INK} /><circle cx="52" cy="55" r="2" fill={CARD} />
      <circle cx="30" cy="34" r="2" fill={INK} /><circle cx="30" cy="76" r="2" fill={INK} /><circle cx="76" cy="34" r="2" fill={INK} /><circle cx="76" cy="76" r="2" fill={INK} />
      <rect x="126" y="49" width="12" height="12" rx="2" fill={CARD} stroke={INK} strokeWidth="1.25" />
      <ellipse cx="132" cy="55" rx="6" ry="9" fill="none" stroke={ACCENT} strokeWidth="3.5" />
      <rect x="120" y="86" width="48" height="20" rx="4" {...S} />
      <circle cx="144" cy="94" r="3" fill={INK} /><rect x="142.5" y="94" width="3" height="7" fill={INK} />
    </g>
  ),
  // a door latch with two holes: the tenant's disc lock in one, the facility's overlock (accent) in the other
  'hasp-overlock': () => (
    <g>
      <rect x="14" y="28" width="172" height="28" rx="3" {...S} />
      <rect x="20" y="36" width="78" height="12" rx="2" fill={CARD} stroke={INK} strokeWidth="1.5" />
      <line x1="104" y1="22" x2="104" y2="62" stroke={DIM} strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="M 62 72 L 62 60 Q 62 48 72 48 Q 82 48 82 60 L 82 72" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
      <ellipse cx="62" cy="52" rx="5" ry="8" fill="none" stroke={INK} strokeWidth="3" />
      <circle cx="72" cy="86" r="20" {...S} /><circle cx="72" cy="86" r="14" fill="none" stroke={DIM} strokeWidth="1.25" />
      <circle cx="72" cy="94" r="3" fill={INK} /><rect x="70.5" y="94" width="3" height="7" fill={INK} />
      <path d="M 126 74 L 126 60 Q 126 48 134 48 Q 142 48 142 60 L 142 74" fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round" />
      <ellipse cx="126" cy="52" rx="5" ry="8" fill="none" stroke={INK} strokeWidth="3" />
      <rect x="112" y="72" width="44" height="32" rx="5" fill={ACCENT} stroke={INK} strokeWidth="2.25" />
      <circle cx="134" cy="86" r="3.5" fill={CARD} /><rect x="132.5" y="86" width="3" height="8" fill={CARD} />
    </g>
  ),
  // a cylinder lock apart: the housing with its round hole, the core pulled out (accent), the key
  'lock-cylinder-core': () => (
    <g>
      <rect x="10" y="40" width="92" height="42" rx="4" {...S} />
      <line x1="20" y1="30" x2="20" y2="40" {...L} /><line x1="92" y1="30" x2="92" y2="40" {...L} />
      <line x1="4" y1="30" x2="108" y2="30" stroke={DIM} strokeWidth="1.5" />
      <circle cx="44" cy="61" r="14" fill={CARD} stroke={INK} strokeWidth="2.25" />
      <circle cx="44" cy="61" r="9" fill="none" stroke={DIM} strokeWidth="1.25" strokeDasharray="3 2" />
      <line x1="64" y1="61" x2="96" y2="61" stroke={ACCENT} strokeWidth="2" />
      <path d="M 96 61 L 88 56 L 88 66 Z" fill={ACCENT} />
      <rect x="118" y="50" width="26" height="22" rx="3" {...S} />
      <circle cx="118" cy="61" r="11" fill={ACCENT} stroke={INK} strokeWidth="2.25" />
      <rect x="116.5" y="53" width="3" height="16" rx="1" fill={CARD} />
      <circle cx="184" cy="61" r="7" fill="none" stroke={INK} strokeWidth="2.5" />
      <rect x="152" y="58" width="26" height="6" rx="1" fill={INK} />
      <rect x="156" y="64" width="3" height="4" fill={INK} /><rect x="163" y="64" width="3" height="6" fill={INK} /><rect x="170" y="64" width="3" height="4" fill={INK} />
    </g>
  ),

  // ── the lot from above ────────────────────────────────────────────────
  // a drive-in (back-in) space: open at one end only; in and out the same way
  'plan-drive-in': () => (
    <g>
      <line x1="12" y1="14" x2="188" y2="14" stroke={INK} strokeWidth="2.5" />
      {[20, 36, 52, 68, 84, 100, 116, 132, 148, 164, 180].map((x) => <line key={x} x1={x} y1="10" x2={x + 6} y2="18" stroke={INK} strokeWidth="1.25" />)}
      {[60, 100, 140].map((x) => <line key={x} x1={x} y1="18" x2={x} y2="78" stroke={DIM} strokeWidth="1.5" />)}
      <line x1="12" y1="78" x2="188" y2="78" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <line x1="12" y1="104" x2="188" y2="104" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <rect x="70" y="22" width="20" height="50" rx="4" {...S} />
      <line x1="80" y1="72" x2="80" y2="84" {...L} /><rect x="77" y="82" width="6" height="5" rx="1" fill={INK} />
      <line x1="120" y1="26" x2="120" y2="98" stroke={ACCENT} strokeWidth="2" />
      <path d="M 120 24 L 115 32 L 125 32 Z" fill={ACCENT} /><path d="M 120 100 L 115 92 L 125 92 Z" fill={ACCENT} />
    </g>
  ),
  // a pull-through space: an aisle at each end; in one end, out the other
  'plan-pull-through': () => (
    <g>
      <line x1="12" y1="8" x2="188" y2="8" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <line x1="12" y1="30" x2="188" y2="30" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <line x1="12" y1="80" x2="188" y2="80" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <line x1="12" y1="102" x2="188" y2="102" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      {[60, 100, 140].map((x) => <line key={x} x1={x} y1="30" x2={x} y2="80" stroke={DIM} strokeWidth="1.5" />)}
      <rect x="70" y="32" width="20" height="46" rx="4" {...S} />
      <line x1="80" y1="78" x2="80" y2="88" {...L} /><rect x="77" y="86" width="6" height="5" rx="1" fill={INK} />
      <line x1="120" y1="100" x2="120" y2="14" stroke={ACCENT} strokeWidth="2" />
      <path d="M 120 10 L 115 20 L 125 20 Z" fill={ACCENT} />
      <path d="M 24 19 L 36 19 M 33 16 L 36 19 L 33 22" fill="none" stroke={DIM} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M 176 91 L 164 91 M 167 88 L 164 91 L 167 94" fill="none" stroke={DIM} strokeWidth="1.5" strokeLinecap="round" />
    </g>
  ),
  // angled spaces on a one-way aisle: come in from the right direction and the turn is easy
  'plan-angled': () => (
    <g>
      {[22, 62, 102, 142].map((x) => <line key={x} x1={x} y1="78" x2={x + 34} y2="16" stroke={DIM} strokeWidth="1.5" />)}
      <line x1="12" y1="78" x2="188" y2="78" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <line x1="12" y1="104" x2="188" y2="104" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
      <path d="M 70 74 L 92 34 Q 94 29 99 32 L 109 37 Q 114 40 111 45 L 89 85 Z" {...S} />
      <path d="M 20 91 L 120 91 Q 134 91 141 79 L 150 63" fill="none" stroke={ACCENT} strokeWidth="2" />
      <path d="M 152 58 L 150 68 L 143 62 Z" fill={ACCENT} />
      <path d="M 166 91 L 184 91 M 180 88 L 184 91 L 180 94" fill="none" stroke={DIM} strokeWidth="1.5" strokeLinecap="round" />
    </g>
  ),

  // ── the site ──────────────────────────────────────────────────────────
  // the gate: a sliding gate between two runs of fence, the keypad pedestal (accent), the loop in the pavement
  'facility-gate': () => (
    <g>
      {[8, 58, 142, 192].map((x) => <rect key={x} x={x - 2} y="28" width="4" height="68" fill={INK} />)}
      <rect x="10" y="32" width="46" height="62" fill="none" stroke={INK} strokeWidth="1.5" />
      <rect x="144" y="32" width="46" height="62" fill="none" stroke={INK} strokeWidth="1.5" />
      {[16, 28, 40, 52].map((x) => <line key={x} x1={x} y1="32" x2={x - 6} y2="94" stroke={DIM} strokeWidth="1" />)}
      {[150, 162, 174, 186].map((x) => <line key={x} x1={x} y1="32" x2={x - 6} y2="94" stroke={DIM} strokeWidth="1" />)}
      <rect x="64" y="38" width="72" height="56" rx="2" {...S} />
      {[76, 88, 100, 112, 124].map((x) => <line key={x} x1={x} y1="42" x2={x} y2="90" stroke={INK} strokeWidth="1.5" />)}
      <rect x="64" y="90" width="72" height="4" fill={INK} />
      <rect x="40" y="62" width="4" height="34" fill={INK} />
      <rect x="32" y="50" width="20" height="14" rx="2" fill={ACCENT} stroke={INK} strokeWidth="1.75" />
      {[37, 42, 47].map((x) => [54, 59].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.1" fill={CARD} />))}
      <rect x="70" y="100" width="60" height="7" rx="3" fill="none" stroke={DIM} strokeWidth="1.5" strokeDasharray="4 3" />
      <Ground />
    </g>
  ),
  // a row of drive-up units: roll-up doors along a drive aisle, a bollard (accent) guarding the corner
  'building-drive-up': () => (
    <g>
      <path d="M 24 30 L 196 24 L 196 96 L 24 96 Z" {...S} />
      {[32, 72, 112, 152].map((x, i) => (
        <g key={x}>
          <rect x={x} y={40 - i} width="32" height={56 + i} fill={GLASS} stroke={INK} strokeWidth="1.75" />
          {[48, 56, 64, 72, 80, 88].map((y) => <line key={y} x1={x + 2} y1={y - i} x2={x + 30} y2={y - i} stroke={INK} strokeWidth="1" />)}
          <rect x={x + 12} y="33" width="8" height="4" rx="1" fill={INK} />
        </g>
      ))}
      <rect x="10" y="66" width="8" height="30" rx="3" fill={ACCENT} stroke={INK} strokeWidth="1.75" />
      <Ground />
      <line x1="4" y1="104" x2="196" y2="104" stroke={DIM} strokeWidth="1.5" strokeDasharray="8 6" />
    </g>
  ),
  // a multi-story building: climate-controlled floors, the loading door under a canopy, a cart
  'building-multi-story': () => (
    <g>
      <rect x="30" y="10" width="124" height="86" {...S} />
      <line x1="30" y1="38" x2="154" y2="38" stroke={DIM} strokeWidth="1.25" /><line x1="30" y1="66" x2="154" y2="66" stroke={DIM} strokeWidth="1.25" />
      {[42, 68, 94, 120].map((x) => <g key={x}><Win x={x} y="18" w="18" h="12" r="1" /><Win x={x} y="46" w="18" h="12" r="1" /></g>)}
      <rect x="40" y="70" width="34" height="26" fill={GLASS} stroke={INK} strokeWidth="1.75" />
      {[76, 82, 88].map((y) => <line key={y} x1="42" y1={y} x2="72" y2={y} stroke={INK} strokeWidth="1" />)}
      <rect x="120" y="74" width="16" height="22" rx="1" fill={CARD} stroke={INK} strokeWidth="1.75" /><circle cx="132" cy="86" r="1.3" fill={INK} />
      <rect x="18" y="62" width="60" height="5" rx="1" fill={ACCENT} stroke={INK} strokeWidth="1.5" />
      <line x1="22" y1="67" x2="22" y2="96" {...L} />
      <rect x="166" y="76" width="22" height="14" rx="2" fill="none" stroke={INK} strokeWidth="2" />
      <line x1="188" y1="76" x2="194" y2="62" {...L} />
      <circle cx="170" cy="92" r="3.5" fill={INK} /><circle cx="184" cy="92" r="3.5" fill={INK} />
      <Ground />
    </g>
  ),
  // inside a unit: steel partitions, the mesh above them, the building's own roof, a sprinkler and a light (accent)
  'unit-mesh-ceiling': () => (
    <g>
      <line x1="4" y1="8" x2="196" y2="8" stroke={INK} strokeWidth="2.5" />
      <path d="M 40 44 L 150 44 L 150 96 L 40 96 Z" fill={BODY} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      {[52, 64, 76, 88, 100, 112, 124, 136].map((x) => <line key={x} x1={x} y1="46" x2={x} y2="94" stroke={DIM} strokeWidth="1" />)}
      <path d="M 8 24 L 40 44 L 40 96 L 8 106 Z" fill={CARD} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      {[14, 20, 26, 32].map((x) => <line key={x} x1={x} y1={24 + (x - 8) * 0.62} x2={x} y2={106 - (x - 8) * 0.31} stroke={DIM} strokeWidth="1" />)}
      <path d="M 40 44 L 150 44 L 150 18 L 40 18 Z" fill={GLASS} fillOpacity=".5" stroke={INK} strokeWidth="1.5" />
      {[52, 64, 76, 88, 100, 112, 124, 136].map((x) => <line key={x} x1={x} y1="18" x2={x} y2="44" stroke={INK} strokeWidth=".8" />)}
      {[24, 30, 36].map((y) => <line key={y} x1="40" y1={y} x2="150" y2={y} stroke={INK} strokeWidth=".8" />)}
      <line x1="170" y1="8" x2="170" y2="20" {...L} /><path d="M 163 20 L 177 20 L 170 27 Z" fill={INK} />
      <line x1="95" y1="8" x2="95" y2="13" {...L} /><rect x="78" y="13" width="34" height="5" rx="1" fill={ACCENT} stroke={INK} strokeWidth="1.5" />
    </g>
  ),
  // the perimeter: chain-link with privacy slats on the left, a block wall on the right, a camera on the post
  'facility-fence': () => (
    <g>
      <rect x="6" y="30" width="90" height="66" fill="none" stroke={INK} strokeWidth="1.5" />
      {[14, 22, 30, 38, 46, 54, 62, 70, 78, 86].map((x) => <line key={x} x1={x} y1="32" x2={x} y2="94" stroke={DIM} strokeWidth="3" />)}
      {[10, 34, 58, 82].map((x) => <line key={x} x1={x} y1="30" x2={x + 14} y2="96" stroke={INK} strokeWidth=".8" />)}
      <rect x="4" y="26" width="4" height="70" fill={INK} /><rect x="96" y="22" width="5" height="74" fill={INK} />
      <rect x="104" y="30" width="92" height="66" {...S} />
      {[44, 58, 72, 86].map((y) => <line key={y} x1="104" y1={y} x2="196" y2={y} stroke={DIM} strokeWidth="1.25" />)}
      {[0, 1, 2, 3, 4].map((r) => [0, 1, 2].map((c) => <line key={`${r}${c}`} x1={104 + (r % 2 ? 14 : 28) + c * 28} y1={30 + r * 14} x2={104 + (r % 2 ? 14 : 28) + c * 28} y2={44 + r * 14} stroke={DIM} strokeWidth="1.25" />))}
      <rect x="104" y="26" width="92" height="5" fill={INK} />
      <rect x="92" y="10" width="16" height="9" rx="2" fill={ACCENT} stroke={INK} strokeWidth="1.5" /><line x1="98" y1="19" x2="98" y2="22" {...L} />
      <Ground />
    </g>
  ),
};

export const DRAWING_NAMES = Object.keys(DRAW);

export default function Drawing({ name, title, className, style }) {
  const Body = DRAW[name];
  if (!Body) return null;
  return (
    <svg viewBox="0 0 200 110" className={`kb-drawing${className ? ` ${className}` : ''}`} style={style} role="img" aria-label={title || name} xmlns="http://www.w3.org/2000/svg">
      <Body />
    </svg>
  );
}
