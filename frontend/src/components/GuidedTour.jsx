import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { X, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { rootZoom } from '../lib/utils';
import { useIsMobile } from '../lib/useIsMobile';

// A phone, or any screen too short for the card - a phone held landscape is
// ~390px tall and wider than the 640px phone breakpoint. Only here does the
// popover clamp itself into the VISUAL viewport and scroll its own text, so
// Next/Done can always be reached; larger screens keep the original placement.
const COMPACT_QUERY = '(max-width: 640px), (max-height: 560px)';
const EDGE = 12;

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
  const [rawI, setI] = useState(0);
  const [rect, setRect] = useState(null);
  // A caller may hand over a SHORTER step list mid-tour (Tickets rebuilds its
  // steps when a rotate flips the phone layout: 7 steps -> 3). Clamp so a
  // stale index can never read past the end and crash on step.title.
  const i = Math.max(0, Math.min(rawI, steps.length - 1));
  const step = steps[i];
  const findTries = useRef(0);
  const compact = useIsMobile(COMPACT_QUERY);
  const cardRef = useRef(null);
  const [cardH, setCardH] = useState(0);
  // Re-render on visual-viewport changes (pinch zoom, on-screen keyboard,
  // the browser's toolbar sliding away) - compact placement is measured
  // against it, not against the layout viewport.
  const [vvTick, setVvTick] = useState(0);

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

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!compact || !vv) return undefined;
    const bump = () => { setVvTick((n) => n + 1); locate(); };
    vv.addEventListener('resize', bump);
    vv.addEventListener('scroll', bump);
    return () => { vv.removeEventListener('resize', bump); vv.removeEventListener('scroll', bump); };
  }, [compact, locate]);

  // The card's real height, for the compact clamp below (its text varies by
  // step). Only stored when it changes, so this settles after one pass.
  useLayoutEffect(() => {
    if (!compact || !cardRef.current) return;
    const h = cardRef.current.offsetHeight;
    if (h) setCardH((prev) => (prev === h ? prev : h));
  }, [compact, i, rect, vvTick]);

  const last = i === steps.length - 1;
  const pad = 6;

  // popover position: below the spotlight when there's room, else above, else centered
  let pop;
  let maxH;
  if (compact) {
    // Everything in the inner (zoom-normalized) space, against the VISUAL
    // viewport: position:fixed is laid out from the layout viewport, so the
    // visual one's offset is added back in.
    const z = rootZoom();
    const vv = window.visualViewport;
    const vTop = (vv ? vv.offsetTop : 0) / z;
    const vLeft = (vv ? vv.offsetLeft : 0) / z;
    const vh = (vv ? vv.height : window.innerHeight) / z;
    const vw = (vv ? vv.width : window.innerWidth) / z;
    maxH = Math.max(120, vh - EDGE * 2);
    const h = Math.min(cardH || 210, maxH);
    const lo = vTop + EDGE;
    const hi = vTop + vh - EDGE - h;   // lowest top that still shows the whole card
    let top;
    if (rect) {
      const below = rect.top + rect.height + EDGE;
      const above = rect.top - EDGE - h;
      // Neither fits (a tall target such as a whole list): the top edge, as
      // the original placement did - the bottom is where the floating bars sit.
      top = below <= hi ? below : above >= lo ? above : lo;
    } else {
      top = vTop + (vh - h) / 2;
    }
    top = Math.max(lo, Math.min(top, hi));
    const w = Math.min(332, vw - EDGE * 2);
    const left = rect ? Math.min(Math.max(vLeft + EDGE, rect.left), vLeft + vw - EDGE - w) : vLeft + (vw - w) / 2;
    pop = { position: 'fixed', top, left: Math.max(vLeft + EDGE, left), width: w };
  } else if (rect) {
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
    // .guided-tour - lets phone-wide [role=dialog] sheet styling (style.css)
    // exclude this overlay, which is a spotlight, not a sheet.
    // Compact screens also lift it over the phone's floating bars
    // (MobileTaskBar is zIndex 2500) so they are dimmed and blocked too.
    <div className="guided-tour" style={{ position: 'fixed', inset: 0, zIndex: compact ? 2600 : 1400 }} role="dialog" aria-label="Guided walkthrough">
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

      <div ref={cardRef} data-testid="guided-tour-card" style={{ width: 332, maxWidth: 'calc(100vw - 24px)', ...pop, background: 'var(--card)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', padding: 16, fontFamily: 'Inter,sans-serif',
        ...(compact ? { maxHeight: maxH, display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } : null) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Walkthrough · step {i + 1} of {steps.length}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close walkthrough" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2 }}><X size={16} /></button>
        </div>
        {/* The only part that scrolls when the card is capped (compact):
            the step count above and Back/Next/Done below stay put. */}
        <div data-testid="guided-tour-body" style={compact ? { minHeight: 0, flex: '0 1 auto', overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' } : undefined}>
          <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 6 }}>{step.title}</div>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}>{step.body}</div>
        </div>
        <div style={{ display: 'flex', gap: 4, margin: '14px 0 12px', flexShrink: 0 }}>
          {steps.map((_, d) => (
            <span key={d} style={{ height: 4, flex: 1, borderRadius: 4, background: d <= i ? 'var(--ink)' : 'var(--line)' }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
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
