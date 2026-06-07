import { AlertCircle } from 'lucide-react';

// Shared "couldn't load this" presentation — never surfaces raw exception text
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

// Pulsing placeholder rows/cards while content loads — keeps layout stable and
// avoids a jarring blank-then-pop transition.
export function SkeletonBlocks({ count = 3, height = 120, borderRadius = 14, gridTemplateColumns }) {
  return (
    <div style={gridTemplateColumns
      ? { display: 'grid', gridTemplateColumns, gap: 14 }
      : { display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[...Array(count)].map((_, i) => (
        <div key={i} style={{ height, borderRadius, background: 'var(--mist)', opacity: 1 - (i % 3) * 0.15, animation: 'pulse 1.5s ease-in-out infinite' }} />
      ))}
    </div>
  );
}

// Wraps the load → error → empty → content lifecycle for a section so every
// view handles it the same friendly way instead of rolling its own.
export default function AsyncSection({
  loading, error, isEmpty,
  errorMessage = "This couldn't be loaded right now — please try again.",
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
