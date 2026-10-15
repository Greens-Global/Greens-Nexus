// The clock chip's punch flourishes, as motion (Neil, Oct 14 2026: "jittery
// ... needs more frames ... make it look professional").
//
// Why not CSS keyframes: a timing function applies to EACH keyframe segment,
// so a path drawn with waypoints (14%, 28%, 42%...) eases to a stop at every
// one of them - the cup stuttered at each waypoint. Here every property is a
// continuous function of time (springs, damped oscillation, eased drift),
// sampled at 60 frames a second and played LINEARLY by the browser's
// animation engine, so velocity never jumps. Only transform and opacity
// move, which the compositor runs off the main thread; nothing animates a
// filter (the old drop-shadow repainted every frame).

const FPS = 60;

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const easeOutCubic = (t) => 1 - (1 - clamp01(t)) ** 3;
export const easeInOutSine = (t) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

/** Underdamped spring from 0 to 1: `zeta` damping ratio, `freq` in Hz, t in seconds. */
export function spring(t, zeta = 0.5, freq = 2) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
}

/** Keyframes sampled from fn(t seconds) -> { x, y, s, r, o } over `ms`. */
export function sample(ms, fn) {
  const n = Math.max(2, Math.round((ms / 1000) * FPS));
  const frames = [];
  for (let i = 0; i <= n; i += 1) {
    const t = (i / n) * (ms / 1000);
    const { x = 0, y = 0, s = 1, sx, sy, r = 0, o = 1 } = fn(t);
    const scale = sx != null || sy != null ? `scale(${(sx ?? s).toFixed(4)}, ${(sy ?? s).toFixed(4)})` : `scale(${s.toFixed(4)})`;
    frames.push({ transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${r.toFixed(2)}deg) ${scale}`, opacity: +clamp01(o).toFixed(3) });
  }
  return frames;
}

// ── The four flourishes ─────────────────────────────────────────────────────
// Each returns [{ sel, frames, ms, delay?, iterations? , draw? }] for the
// elements in Flourish (ClockChip.jsx). `draw` animates stroke-dashoffset on a
// path with pathLength=1 (a line drawing itself).

export const COFFEE_MS = 2300;
/** Start Break: the cup springs up out of Pause with a little overshoot,
 *  tips and settles like something set down, glides right on one smooth
 *  ease, and fades - steam curling off it the whole way. */
export function coffeePlan() {
  const cup = sample(COFFEE_MS, (t) => ({
    x: 66 * easeInOutSine((t - 0.32) / 1.75),
    y: -22 * spring(t, 0.55, 1.9) + 1.2 * Math.sin(2 * Math.PI * 0.8 * t) * smoothstep(0.6, 1.2, t),
    s: 0.35 + 0.65 * spring(t, 0.42, 2.6),
    r: -10 * Math.exp(-2.4 * t) * Math.sin(2 * Math.PI * 1.7 * t),
    o: smoothstep(0, 0.2, t) * (1 - smoothstep(1.75, 2.3, t)),
  }));
  // A wisp: draws itself upward, rises, sways on a slow sine, widens and
  // thins out. Three, staggered, each puffing twice - unbroken steam.
  const wisp = (phase) => sample(900, (t) => {
    const u = t / 0.9;
    return {
      x: 1.6 * Math.sin(2 * Math.PI * (1.1 * u + phase)),
      y: -6 * easeOutCubic(u),
      sx: 1 + 0.6 * u, sy: 1 - 0.1 * u,
      o: 0.8 * smoothstep(0, 0.22, u) * (1 - smoothstep(0.5, 1, u)),
    };
  });
  return [
    { sel: '[data-fx=body]', frames: cup, ms: COFFEE_MS },
    { sel: '[data-fx=w0]', frames: wisp(0), ms: 900, delay: 300, iterations: 2 },
    { sel: '[data-fx=w1]', frames: wisp(0.33), ms: 900, delay: 520, iterations: 2 },
    { sel: '[data-fx=w2]', frames: wisp(0.66), ms: 900, delay: 740, iterations: 2 },
    // Each wisp draws itself as it appears, every puff.
    { sel: '[data-fx=w0] path', draw: true, ms: 900, delay: 300, iterations: 2 },
    { sel: '[data-fx=w1] path', draw: true, ms: 900, delay: 520, iterations: 2 },
    { sel: '[data-fx=w2] path', draw: true, ms: 900, delay: 740, iterations: 2 },
  ];
}

export const CHECK_MS = 1900;
/** End Break: a green disc springs in, its ring and then the check draw
 *  themselves, a soft ring pulses out, and it glides right and fades -
 *  the same exit as the cup, so the pair reads as one idea. */
export function checkPlan() {
  return [
    { sel: '[data-fx=body]', ms: CHECK_MS, frames: sample(CHECK_MS, (t) => ({
      x: 52 * easeInOutSine((t - 0.55) / 1.25),
      y: -14 * spring(t, 0.6, 2),
      s: 0.4 + 0.6 * spring(t, 0.45, 2.8),
      o: smoothstep(0, 0.2, t) * (1 - smoothstep(1.45, 1.9, t)),
    })) },
    { sel: '[data-fx=ring]', draw: true, ms: 380, delay: 60 },
    { sel: '[data-fx=tick]', draw: true, ms: 340, delay: 300 },
    { sel: '[data-fx=pulse]', ms: 700, delay: 360, frames: sample(700, (t) => ({ s: 1 + 1.1 * easeOutCubic(t / 0.7), o: 0.45 * smoothstep(0, 0.1, t) * (1 - smoothstep(0.1, 0.7, t)) })) },
  ];
}

export const STARS_MS = 1600;
// [angle deg (0 = right, negative = up), distance px, size px, spin deg, delay ms]
const IN = [[-78, 46, 15, 140, 0], [-52, 62, 11, 220, 40], [-30, 54, 17, 180, 80], [-12, 70, 10, 260, 30], [-64, 32, 9, 200, 120], [-40, 80, 12, 160, 150]];
const OUT = [[-8, 58, 16, -160, 0], [12, 70, 11, -220, 40], [30, 52, 15, -180, 80], [48, 40, 10, -260, 30], [4, 82, 9, -200, 120], [22, 34, 12, -140, 150]];
export const starSpec = (kind) => (kind === 'in' ? IN : OUT);

/** Punch In / Punch Out: a soft burst ring, then stars that spring out to
 *  full size, travel on an ease-out (out: with a touch of gravity, settling
 *  down - the day done), spin, twinkle once and shrink away. */
export function starsPlan(kind) {
  const g = kind === 'out' ? 26 : -6;
  const stars = starSpec(kind).map(([deg, dist, , spin, delay], i) => {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a) * dist, dy = Math.sin(a) * dist;
    const life = (STARS_MS - delay) / 1000;
    return { sel: `[data-fx=s${i}]`, ms: STARS_MS - delay, delay, frames: sample(STARS_MS - delay, (t) => {
      const u = t / life;
      const pop = 0.15 + 0.85 * spring(t, 0.4, 3.2);
      const twinkle = 1 + 0.18 * Math.sin(2 * Math.PI * 3 * u) * smoothstep(0.25, 0.4, u) * (1 - smoothstep(0.55, 0.7, u));
      return {
        x: dx * easeOutCubic(u * 1.15),
        y: dy * easeOutCubic(u * 1.15) + g * u * u,
        s: pop * twinkle * (1 - 0.75 * smoothstep(0.55, 1, u)),
        r: spin * easeOutCubic(u),
        o: smoothstep(0, 0.12, u) * (1 - smoothstep(0.62, 1, u)),
      };
    }) };
  });
  return [
    { sel: '[data-fx=pulse]', ms: 650, frames: sample(650, (t) => ({ s: 0.6 + 1.6 * easeOutCubic(t / 0.65), o: 0.5 * smoothstep(0, 0.1, t) * (1 - smoothstep(0.1, 0.65, t)) })) },
    ...stars,
  ];
}

export const planFor = (kind) => (kind === 'coffee' ? coffeePlan() : kind === 'check' ? checkPlan() : starsPlan(kind));
export const FLOURISH_MS = { coffee: COFFEE_MS, check: CHECK_MS, in: STARS_MS, out: STARS_MS };

/** Run a plan on the elements under `root`. Returns a stop function. */
export function playPlan(root, plan) {
  const running = [];
  if (!root || typeof root.querySelectorAll !== 'function') return () => {};
  for (const step of plan) {
    for (const el of root.querySelectorAll(step.sel)) {
      if (typeof el.animate !== 'function') continue;   // jsdom, very old browsers
      // A line drawing itself: hidden until it starts (a round cap on an
      // undrawn stroke shows as a dot in Safari), drawn in the first part.
      const frames = step.draw
        ? [{ strokeDashoffset: 1, opacity: 0 }, { strokeDashoffset: 0.97, opacity: 1, offset: 0.04 }, { strokeDashoffset: 0, opacity: 1, offset: step.iterations ? 0.45 : 1 }, { strokeDashoffset: 0, opacity: 1 }]
        : step.frames;
      running.push(el.animate(frames, {
        duration: step.ms, delay: step.delay || 0, iterations: step.iterations || 1,
        easing: step.draw ? 'cubic-bezier(.65,0,.35,1)' : 'linear', fill: 'both',
      }));
    }
  }
  return () => running.forEach((an) => { try { an.cancel(); } catch { /* finished */ } });
}
