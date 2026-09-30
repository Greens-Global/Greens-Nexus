import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';

// Shared "couldn't load this" presentation - never surfaces raw exception text
// (e.g. "Failed to fetch", "API error 500") to end users. The technical reason
// stays in the console for whoever's debugging; the user just sees a friendly,
// retry-able message.
export function ErrorBanner({ message, onRetry, retryLabel = 'Retry' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 16px', borderRadius: 10, background: 'hsla(var(--color-red),0.08)', color: 'hsl(var(--color-red))', fontSize: '13.5px' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AlertCircle size={16} /> {message}
      </span>
      {onRetry && (
        <button className="secondary-btn" style={{ flexShrink: 0 }} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

// The one Nexus loader (Neil, Sep 29): a green sweep ring, styled by `.nxl` in
// style.css. Four named sizes cover every screen; a number is for the ring
// standing in for an icon inside a button, so the button keeps its shape.
// It is green by default and white inside .primary-btn; pass
// `color="currentColor"` (or className "nxl-inherit") on any other dark surface.
export const LOADER_SIZES = { page: 88, view: 64, section: 40, inline: 20 };

export function Spinner({ size = 'inline', color, label = 'Loading', className, style }) {
  const px = typeof size === 'number' ? size : (LOADER_SIZES[size] || LOADER_SIZES.inline);
  const cls = ['nxl', 'nxl-in', px <= 20 ? 'nxl-sm' : '', className].filter(Boolean).join(' ');
  return (
    <span className={cls} role="img" aria-label={label} style={{ '--s': `${px}px`, ...(color ? { color } : null), ...style }}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle className="nxl-track" cx="24" cy="24" r="20" />
        <circle className="nxl-arc" cx="24" cy="24" r="20" />
      </svg>
    </span>
  );
}

// A loader filling a screen, panel or modal body. Shows nothing for the first
// 150 ms so a fast answer never flashes a ring, arrives with the `.nxl-in`
// motion, and after 8 s adds a plain note (and Try Again when there is a
// retry) so a long wait never looks like a frozen screen.
// `compact` is the one-line form for a widget body, dropdown or drawer
// section: the inline ring beside the label, no minimum height.
export function LoadingState({ size = 'section', label, onRetry, minHeight = 160, delay = 150, slowAfter = 8000, compact = false, style }) {
  const [shown, setShown] = useState(delay <= 0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setShown(true), Math.max(0, delay));
    const b = setTimeout(() => setSlow(true), slowAfter);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [delay, slowAfter]);
  if (compact) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 4px', minHeight: 44, fontSize: 13, color: 'var(--muted)', ...style }}>
        {shown && (
          <span className="nxl-in" style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <Spinner size="inline" label={label || 'Loading'} />
            <span>{slow ? 'Still working. This is taking longer than usual.' : (label || 'Loading…')}</span>
          </span>
        )}
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight, padding: '24px 16px', textAlign: 'center', ...style }}>
      {shown && (
        <div className="nxl-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <Spinner size={size} label={label || 'Loading'} />
          {label && <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{label}</div>}
          {slow && (
            <div className="nxl-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>
              <span>Still working. This is taking longer than usual.</span>
              {onRetry && <button type="button" className="secondary-btn" onClick={onRetry}>Try Again</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Full-height version for lazy-loaded screens (Suspense fallbacks) - the ring
// sits where the screen's content will be, at the "view" size.
export function ViewLoading({ label, minHeight = '60vh' }) {
  return <LoadingState size="view" label={label} minHeight={minHeight} />;
}

// Fallback for a lazy-loaded modal or drawer: dims the screen at once (so the
// click is seen to do something) and shows a white ring only if the code takes
// more than a moment to arrive.
export function ModalLoading({ zIndex = 1200 }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShown(true), 150); return () => clearTimeout(t); }, []);
  return (
    <div role="status" aria-busy="true" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.32)', zIndex, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {shown && <Spinner size="section" color="#fff" />}
    </div>
  );
}

// Placeholder rows/cards while content loads - keeps layout stable and avoids
// a jarring blank-then-pop transition. Blocks sheen one after another (--i).
export function SkeletonBlocks({ count = 3, height = 120, borderRadius = 14, gridTemplateColumns }) {
  return (
    <div aria-hidden="true" style={gridTemplateColumns
      ? { display: 'grid', gridTemplateColumns, gap: 14 }
      : { display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[...Array(count)].map((_, i) => (
        <div key={i} className="nx-skel" style={{ height, borderRadius, '--i': i }} />
      ))}
    </div>
  );
}

// Wraps the load → error → empty → content lifecycle for a section so every
// view handles it the same friendly way instead of rolling its own.
export default function AsyncSection({
  loading, error, isEmpty,
  errorMessage = "This couldn't be loaded right now - please try again.",
  emptyContent = null,
  onRetry,
  skeleton = <SkeletonBlocks />,
  children,
}) {
  if (error) return <ErrorBanner message={errorMessage} onRetry={onRetry} />;
  if (loading) return skeleton;
  if (isEmpty) return emptyContent;
  return children;
}
