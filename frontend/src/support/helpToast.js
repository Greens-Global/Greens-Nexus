// A small confirmation toast that outlives the component that raised it (the
// ticket form closes in the same click). Plain DOM on purpose: there is no
// app-wide toast host, and this needs nothing from React.
let current = null;

export function showHelpToast(message, ms = 3200) {
  if (typeof document === 'undefined') return;
  if (current) { current.remove(); current = null; }
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.className = 'help-toast';
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: 'max(24px, env(safe-area-inset-bottom))',
    transform: 'translateX(-50%)', zIndex: '10000', maxWidth: 'calc(100vw - 32px)',
    padding: '10px 16px', borderRadius: '10px', background: 'var(--ink)', color: 'var(--card)',
    fontFamily: 'Inter, sans-serif', fontSize: '13px', fontWeight: '600', lineHeight: '1.4',
    boxShadow: '0 12px 32px rgba(0,0,0,0.25)', pointerEvents: 'none', textAlign: 'center',
  });
  document.body.appendChild(el);
  current = el;
  setTimeout(() => { el.remove(); if (current === el) current = null; }, ms);
}
