// Small shared pieces for list widgets (Oct 14 widget pass).
//
// A list tile shows at most N rows. It used to stop there in silence, with a
// subtitle that read as if the list were complete ("Next 30 days" over 8 of
// 23 birthdays); `MoreRow` names what was left out and opens the screen that
// has all of it. A failed fetch used to fall through to the empty state
// ("Everyone is in"), which is a false statement, not an empty one;
// `WidgetError` says the list did not load and offers a retry instead.
import { AlertCircle, ArrowRight } from 'lucide-react';
import { SkeletonBlocks } from '../components/AsyncState';

export function MoreRow({ count, noun = 'more', onClick, label }) {
  if (!count || count <= 0) return null;
  const text = label || `+${count} ${noun}`;
  const style = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, width: '100%',
    minHeight: 36, padding: '6px 8px', marginTop: 4, border: 'none', borderTop: '1px solid var(--line)',
    background: 'transparent', color: onClick ? 'hsl(var(--color-blue))' : 'var(--muted)',
    fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: onClick ? 'pointer' : 'default',
  };
  return onClick
    ? <button type="button" onClick={(e) => { e.stopPropagation(); onClick(); }} style={style}>{text} <ArrowRight size={12} /></button>
    : <div style={style}>{text}</div>;
}

export function WidgetError({ message = "Couldn't load this list.", onRetry }) {
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 8px', textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'hsl(var(--color-red))', fontWeight: 600 }}>
        <AlertCircle size={14} /> {message}
      </span>
      {onRetry && (
        <button type="button" className="secondary-btn" onClick={(e) => { e.stopPropagation(); onRetry(); }}
          style={{ minHeight: 36, padding: '6px 14px', fontSize: 12.5 }}>Try Again</button>
      )}
    </div>
  );
}

// The card a crashed widget leaves in its place (CustomDashboard wraps every
// tile in a WidgetBoundary with this as the fallback), so one bad tile no
// longer takes the whole board down with it.
export function WidgetCrashCard({ title }) {
  return (
    <div className="dash-card" role="alert" style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 14 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-red))' }}>
        <AlertCircle size={14} /> {title ? `${title} hit a snag.` : 'This widget hit a snag.'}
      </span>
      <button type="button" className="secondary-btn" onClick={() => window.location.reload()}
        style={{ minHeight: 36, padding: '6px 14px', fontSize: 12.5 }}>Reload</button>
    </div>
  );
}

// What a widget shows while its data loads (11/05/2026): a few placeholder
// rows the shape of the list that is coming, never a spinner - a ring and
// "Loading..." in every tile made the board read as broken.
export function WidgetSkeleton({ rows = 3, rowHeight = 30, label = 'Loading' }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} data-widget-skeleton style={{ padding: '2px 0' }}>
      <SkeletonBlocks count={rows} height={rowHeight} borderRadius={8} />
    </div>
  );
}
