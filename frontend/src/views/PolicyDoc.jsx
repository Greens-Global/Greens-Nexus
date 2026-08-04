// ── Shared shell for the Privacy Policy / Terms & Conditions content ────────
// Two render modes:
//  - Public (default): the standalone /privacy and /terms pages, rendered
//    OUTSIDE the MSAL gate (same reasoning as PublicSign.jsx / PublicVerify.jsx)
//    for a candidate reading the login page, or anyone sent the link, who has
//    no Nexus login. Fixed light styling to match LoginPage.
//  - Embedded (embedded=true): mounted inside the signed-in app shell as its
//    own sidebar entry (System group) - drops the "back to Nexus" link and the
//    full-bleed background, and switches to the app's own theme variables so
//    it follows light/dark mode like every other module.
// Plain static content either way, no API calls.

export default function PolicyDoc({ title, updated, sections, embedded = false }) {
  const wrapStyle = embedded
    ? { fontFamily: "'Inter',sans-serif", color: 'var(--ink, #111827)' }
    : { minHeight: '100dvh', background: '#f6f7f9', fontFamily: "'Figtree','Inter',sans-serif", color: '#323338' };
  const mutedColor = embedded ? 'var(--muted, #6b7280)' : '#9699a6';
  const bodyColor = embedded ? 'var(--ink, #111827)' : '#3d3f47';

  return (
    <div style={wrapStyle}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: embedded ? '0 0 40px' : '48px 24px 80px' }}>
        {!embedded && <a href="/" style={{ fontSize: 13, fontWeight: 600, color: '#676879', textDecoration: 'none' }}>&larr; Back to Nexus</a>}
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em', margin: embedded ? '0 0 4px' : '20px 0 4px' }}>{title}</h1>
        <p style={{ fontSize: 13, color: mutedColor, margin: '0 0 32px' }}>Last updated: {updated}</p>
        {sections.map(s => (
          <div key={s.h} style={{ marginBottom: 26 }}>
            <h2 style={{ fontSize: 15.5, fontWeight: 800, margin: '0 0 8px' }}>{s.h}</h2>
            {s.p.map((para, i) => (
              <p key={i} style={{ fontSize: 14, lineHeight: 1.65, color: bodyColor, margin: '0 0 10px' }}>{para}</p>
            ))}
            {s.list && (
              <ul style={{ margin: '0 0 10px', paddingLeft: 20 }}>
                {s.list.map((li, i) => (
                  <li key={i} style={{ fontSize: 14, lineHeight: 1.65, color: bodyColor, marginBottom: 4 }}>{li}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
