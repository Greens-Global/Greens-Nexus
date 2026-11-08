// Confetti, well done (Neil, 11/08/2026): a short celebration when a kudos
// arrives - two bursts from the top edge of the arriving card, about 120
// small pieces in the company's own colors, falling and fluttering for
// under two seconds, then gone. One canvas over the page (pointer-events
// none, under any dialog), removed when the last piece dies. Runs ONCE per
// call, never loops, no sound; nothing at all under reduced motion, and a
// hidden tab skips the rest. No dependency - plain canvas + rAF.
//
//   const stop = burstConfetti(cardEl.getBoundingClientRect());
//   stop();   // optional: drop the canvas early
import { prefersReducedMotion } from '../lib/motion';

const PIECES = 120;
const BURSTS = 2;
const BURST_GAP_MS = 150;
const LIFE_MS = [1600, 2000];   // each piece's life, spread over this range
const GRAVITY = 0.0011;         // px per ms^2
const DRAG = 0.0009;            // per ms
const Z = 3400;                 // over the page, under the moment card (3500) and every dialog

// Six colors read at run time so a company's brand carries through.
function palette() {
  let s;
  try { s = getComputedStyle(document.documentElement); } catch { s = null; }
  const v = (name, fallback) => (s && s.getPropertyValue(name).trim()) || fallback;
  return [
    v('--wk-brand', '#1a7f4b'),
    v('--wk-brand-tint', '#d9f2e3'),
    '#e8b53a',                   // warm gold
    '#8fb8f0',                   // soft blue
    '#ffffff',
    withAlpha(v('--ink', '#0f172a'), 0.35),
  ];
}

function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function makePiece(rect, colors, now) {
  const x = rect.left + rect.width * (0.15 + Math.random() * 0.7);
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.3;    // up, with spread
  const speed = 0.32 + Math.random() * 0.34;                     // px per ms
  return {
    x, y: rect.top, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, circle: Math.random() < 0.18,
    rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.012,
    flutter: Math.random() * Math.PI * 2, flutterSpeed: 0.006 + Math.random() * 0.006,
    color: colors[Math.floor(Math.random() * colors.length)],
    born: now, life: LIFE_MS[0] + Math.random() * (LIFE_MS[1] - LIFE_MS[0]),
  };
}

export function burstConfetti(rect, { pieces = PIECES } = {}) {
  if (!rect || prefersReducedMotion() || typeof document === 'undefined' || document.hidden) return () => {};
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return () => {};
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('data-nx-confetti', '');
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${Z}`;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.appendChild(canvas);

  const colors = palette();
  const perBurst = Math.ceil(pieces / BURSTS);
  const start = performance.now();
  let live = [];
  let launched = 0;
  let raf = 0;
  let last = start;
  let done = false;

  const stop = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onHide);
    canvas.remove();
  };
  function onHide() { if (document.hidden) stop(); }   // a hidden tab skips the rest
  document.addEventListener('visibilitychange', onHide);

  function frame(now) {
    if (done) return;
    const dt = Math.min(48, now - last);
    last = now;
    while (launched < BURSTS && now - start >= launched * BURST_GAP_MS) {
      for (let i = 0; i < perBurst; i++) live.push(makePiece(rect, colors, now));
      launched++;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    live = live.filter((p) => now - p.born < p.life);
    for (const p of live) {
      p.vy += GRAVITY * dt;
      p.vx *= 1 - DRAG * dt;
      p.vy *= 1 - DRAG * dt * 0.5;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.flutter += p.flutterSpeed * dt;
      const age = (now - p.born) / p.life;
      const alpha = age > 0.7 ? 1 - (age - 0.7) / 0.3 : 1;   // fades out in the last 30%
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(Math.max(0.15, Math.abs(Math.cos(p.flutter))), 1);   // the flutter: a thin edge, then a face
      ctx.fillStyle = p.color;
      if (p.circle) { ctx.beginPath(); ctx.arc(0, 0, p.h / 2 + 1, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (launched >= BURSTS && !live.length) { stop(); return; }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return stop;
}

export default burstConfetti;
