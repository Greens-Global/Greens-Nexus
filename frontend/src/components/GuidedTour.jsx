import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { X, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { rootZoom } from '../lib/utils';

// ── GuidedTour - spotlight walkthrough ("Simulate" mode) ─────────────────────
// Highlights one element at a time (found via [data-tour="<target>"]), explains
// what it does and what to click, and moves on with Next/Back. While the tour is
// open a full-screen shield swallows every click outside the popover, so the
// walkthrough can never change real data - it simulates, it doesn't do.
//
// steps: [{ target, title, body, before?() }]
//   target  - value of the data-tour attribute to spotlight (null = centered card)
//   before  - run before locating the element (switch tab, select a row, …)

export default function GuidedTour({ steps, onClose }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = steps[i];
  const findTries = useRef(0);

  const locate = useCallback(() => {
    if (!step?.target) { setRect(null); return; }
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      // The element may still be rendering after before() switched tabs - retry briefly.
      if (findTries.current < 20) { findTries.current += 1; setTimeout(locate, 60); }
      else setRect(null);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Normalize into the INNER coordinate space at measurement time, so the
    // spotlight ring and popover below - both plain CSS lengths - line up with
    // the element they're highlighting under <html>'s CSS zoom. See rootZoom.
    const z = rootZoom();
    const r = el.getBoundingClientRect();
    setRect({ top: r.top / z, left: r.left / z, width: r.width / z, height: r.height / z });
  }, [step]);

  useLayoutEffect(() => {
    findTries.current = 0;
    let cancelled = false;
    Promise.resolve(step?.before?.()).then(() => { if (!cancelled) requestAnimationFrame(locate); });
    return () => { cancelled = true; };
  }, [i, step, locate]);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && i < steps.length - 1) setI(i + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    const reflow = () => locate();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [i, steps.length, onClose, locate]);

  const last = i === steps.length - 1;
  const pad = 6;

  // popover position: below the spotlight when there's room, else above, else centered
  let pop;
  if (rect) {
    // rect is already in the inner space, so the viewport bounds must be too.
    const z = rootZoom();
    const vw = window.innerWidth / z, vh = window.innerHeight / z;
    const below = rect.top + rect.height + 12;
    const fitsBelow = below + 210 < vh;
    pop = {
      position: 'fixed',
      top: fitsBelow ? below : Math.max(12, rect.top - 12 - 210),
      left: Math.min(Math.max(12, rect.left), Math.max(12, vw - 344)),
    };
  } else {
    pop = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1400 }} role="dialog" aria-label="Guided walkthrough">
      {/* click shield - the whole point of Simulate: nothing underneath is clickable */}
      <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', inset: 0 }} />
      {rect ? (
        <div style={{
          position: 'fixed', top: rect.top - pad, left: rect.left - pad,
          width: rect.width + pad * 2, height: rect.height + pad * 2,
          borderRadius: 12, boxShadow: '0 0 0 9999px rgba(15,18,25,0.62)',
          border: '2px solid #fff', pointerEvents: 'none', transition: 'all .25s ease',
        }} />
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,18,25,0.62)' }} />
      )}

      <div style={{ ...pop, width: 332, maxWidth: 'calc(100vw - 24px)', background: 'var(--card)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', padding: 16, fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Walkthrough · step {i + 1} of {steps.length}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close walkthrough" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2 }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 6 }}>{step.title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}>{step.body}</div>
        <div style={{ display: 'flex', gap: 4, margin: '14px 0 12px' }}>
          {steps.map((_, d) => (
            <span key={d} style={{ height: 4, flex: 1, borderRadius: 4, background: d <= i ? 'var(--ink)' : 'var(--line)' }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="secondary-btn" onClick={onClose} style={{ fontSize: 12.5 }}>Skip</button>
          <span style={{ flex: 1 }} />
          {i > 0 && (
            <button className="secondary-btn" onClick={() => setI(i - 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
              <ArrowLeft size={13} /> Back
            </button>
          )}
          <button className="primary-btn" onClick={() => (last ? onClose() : setI(i + 1))} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
            {last ? <>Done <Check size={13} /></> : <>Next <ArrowRight size={13} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
