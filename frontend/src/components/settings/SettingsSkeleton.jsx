// What Settings shows while its code and its first data arrive (11/05/2026):
// the page's own frame - the subject rail on the left, the subject header and
// its groups on the right - drawn with the real .nx-set-* classes, so the
// screen fills in where it will be instead of sitting blank (or as a lone
// ring) for the seconds the Settings chunk takes on a cold load. Kept out of
// views/AdminConsole.jsx on purpose: App.jsx shows it before that chunk is in.
const RAIL = [4, 5, 3];
const GROUPS = 3;

export default function SettingsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="nx-settings" data-settings-skeleton="">
      <span className="dk-sr-only">Loading Settings…</span>
      <div className="nx-set-shell is-skel" aria-hidden="true">
        <div className="nx-set-rail">
          <span className="nx-skel" style={{ height: 34, borderRadius: 8, marginBottom: 4 }} />
          {RAIL.map((n, s) => (
            <div key={s}>
              <div className="nx-set-rail-section"><span className="skel" style={{ width: 90, height: 10 }} /></div>
              {[...Array(n)].map((_, i) => (
                <div key={i} className="nx-set-rail-item" style={{ cursor: 'default' }}>
                  <span className="skel" style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0 }} />
                  <span className="skel" style={{ width: `${55 + ((i * 17 + s * 11) % 35)}%`, height: 11 }} />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="nx-set-main">
          <div className="nx-set-head">
            <div className="nx-set-head-text" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="skel" style={{ width: 180, height: 20 }} />
              <span className="skel" style={{ width: '45%', height: 12 }} />
            </div>
            <span className="skel" style={{ width: 220, height: 34, borderRadius: 8 }} />
          </div>
          {[...Array(GROUPS)].map((_, i) => (
            <div key={i} className="nx-set-group">
              <div className="nx-set-group-head" style={{ flexDirection: 'column', gap: 6 }}>
                <span className="skel" style={{ width: 160, height: 14 }} />
                <span className="skel" style={{ width: '38%', height: 11 }} />
              </div>
              <span className="nx-skel" style={{ height: i === 0 ? 168 : 112, borderRadius: 12, '--i': i }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
