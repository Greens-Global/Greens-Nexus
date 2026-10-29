import { SearchX, ArrowLeft, LifeBuoy } from "lucide-react";

// What an address Nexus does not know shows (Oct 29 2026). It used to be a
// mock "Sub-Application ... Micro-App Handshake Established ... Awaiting
// final UI build pipelines" screen that looked like a half-built module;
// a mistyped or retired address is simply not a page.
export default function Placeholder({ viewName, onBack }) {
  const help = () => window.dispatchEvent(new CustomEvent("nexus:navigate", { detail: { view: "support" } }));
  return (
    <div role="status" style={{ maxWidth: 560, margin: "64px auto", padding: "0 16px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--mist, rgba(100,116,139,0.1))", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <SearchX style={{ width: 30, height: 30 }} aria-hidden="true" />
      </div>
      <div>
        <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>Page Not Found</h2>
        <p style={{ color: "var(--muted)", margin: 0, lineHeight: 1.5 }}>
          There is no page at this address{viewName ? ` ("/${viewName}")` : ""}. The link may be old or mistyped.
        </p>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" className="primary-btn" onClick={onBack}>
          <ArrowLeft style={{ width: 16, height: 16 }} /> Go to Dashboard
        </button>
        <button type="button" className="secondary-btn" onClick={help}>
          <LifeBuoy style={{ width: 16, height: 16 }} /> Help Center
        </button>
      </div>
    </div>
  );
}
