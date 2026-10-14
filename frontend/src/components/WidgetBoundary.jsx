import { Component } from 'react';
import { reportError } from '../lib/errorReporter';

// A boundary for the pieces of the shell that sit OUTSIDE the routed view: the
// floating widgets (toasts, time clock pill, search, banners) and the
// navigation chrome. ViewErrorBoundary only guards the view, so a render crash
// in any of these used to reach RootErrorBoundary - one reload, then a
// full-screen card for everyone on every screen, for a problem local to one
// widget. This keeps the failure where it happened.
//
//   <WidgetBoundary name="toasts" resetKey={view}><NotificationToasts /></WidgetBoundary>
//
// fallback  what to show in the widget's place (default: nothing). Navigation
//           passes a <NavFallback> so there is always a way out.
// resetKey  when it changes the boundary tries the child again, so one bad
//           render does not hide the widget for the rest of the session.
// name      prefixes the report in the server's error trail.
export default class WidgetBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // Reporting must never add an error of its own (lib/errorReporter dedupes
    // and caps what it sends).
    try {
      reportError(`${this.props.name || 'widget'}: ${error?.message || String(error)}`, error?.stack);
    } catch { /* ignore */ }
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return this.props.fallback ?? null;
  }
}

// The stand-in for a crashed piece of navigation: a thin strip that keeps the
// crashed element's own class (so it sits exactly where the real one did and
// follows the same phone/desktop rules) with a Reload button.
export function NavFallback({ as: Tag = 'div', className, label = 'This menu hit a snag.', style }) {
  return (
    // No inline `display`: the class owns it (.mobile-nav is display:none on
    // desktop, and every nav class is already a flex box).
    <Tag className={className} role="alert" style={{
      alignItems: 'center', justifyContent: 'center',
      gap: 8, padding: '8px 10px', fontFamily: 'Inter, sans-serif', ...style,
    }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>{label}</span>
      <button
        onClick={() => window.location.reload()}
        style={{ background: 'var(--ink)', color: 'var(--card)', border: 'none', borderRadius: 8, padding: '6px 12px', fontWeight: 700, fontSize: 12, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
        Reload
      </button>
    </Tag>
  );
}
