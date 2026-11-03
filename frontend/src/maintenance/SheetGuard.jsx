// A lazy maintenance sheet that cannot load (a deploy swapped the chunks) or
// throws says so and closes - it never takes the screen beneath down with it
// (CLAUDE.md: never let a screen render blank). The centered card is a
// question, not a sheet.
import { Component } from 'react';

export default class SheetGuard extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* the message below is the report */ }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alertdialog" aria-label="Could not open" style={{ position: 'fixed', inset: 0, zIndex: 4300, background: 'rgba(17,24,39,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div className="nx-popup nx-center" style={{ background: 'var(--card)', color: 'var(--ink)', borderRadius: 14, padding: 20, maxWidth: 420, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>This Could Not Open</div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>Nexus may have just been updated. Reload the page and try again.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={this.props.onClose}>Close</button>
            <button type="button" className="primary-btn" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
