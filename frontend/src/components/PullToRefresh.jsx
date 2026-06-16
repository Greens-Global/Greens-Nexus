import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

const ARM_AT = 70; // indicator travel (px) that arms the refresh

// Phone-only pull-to-refresh. Reloads the page — the URL mirrors view/sub so
// the user lands back on the same screen with completely fresh data. Ignores
// gestures that start inside dialogs/drawers or while one is open, and never
// preventDefaults (listeners are passive), so native scrolling is untouched.
export default function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const gesture = useRef(null);
  const pullRef = useRef(0);

  useEffect(() => {
    const setBoth = v => { pullRef.current = v; setPull(v); };

    const onStart = e => {
      if (!window.matchMedia('(max-width: 900px)').matches) return;
      if (window.scrollY > 0 || document.body.style.overflow === 'hidden') return;
      if (e.target.closest('[role="dialog"], .cart-drawer, .notif-drawer, .mobile-menu, .mobile-submenu, .gs-overlay, .swipe-row')) return;
      gesture.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, locked: null };
    };

    const onMove = e => {
      const g = gesture.current;
      if (!g) return;
      const dy = e.touches[0].clientY - g.y;
      const dx = e.touches[0].clientX - g.x;
      if (g.locked === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // not decided yet
        g.locked = dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'pull' : 'off';
      }
      if (g.locked !== 'pull') return;
      if (window.scrollY > 0) { setBoth(0); return; } // page started scrolling instead
      setBoth(Math.min(120, Math.max(0, dy * 0.4))); // rubber-band damping
    };

    const onEnd = () => {
      if (!gesture.current) return;
      gesture.current = null;
      if (pullRef.current >= ARM_AT) {
        setBusy(true);
        setBoth(ARM_AT);
        setTimeout(() => window.location.reload(), 180);
      } else {
        setBoth(0);
      }
    };

    window.addEventListener('touchstart',  onStart, { passive: true });
    window.addEventListener('touchmove',   onMove,  { passive: true });
    window.addEventListener('touchend',    onEnd,   { passive: true });
    window.addEventListener('touchcancel', onEnd,   { passive: true });
    return () => {
      window.removeEventListener('touchstart',  onStart);
      window.removeEventListener('touchmove',   onMove);
      window.removeEventListener('touchend',    onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  if (pull <= 0 && !busy) return null;

  const armed = pull >= ARM_AT || busy;
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 3000,
      display: 'flex', justifyContent: 'center', pointerEvents: 'none',
      transform: `translateY(${Math.max(pull - 34, 8)}px)`,
      transition: busy ? 'transform 0.2s ease' : 'none',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        background: 'var(--card)', border: '1px solid var(--line)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <RefreshCw size={16} style={{
          color: armed ? 'hsl(var(--color-green))' : 'var(--muted)',
          transform: `rotate(${pull * 2.4}deg)`,
          animation: busy ? 'spin 0.8s linear infinite' : 'none',
        }} />
      </div>
    </div>
  );
}
