import { Layers, ArrowLeft } from "lucide-react";

export default function Placeholder({ viewName, onBack }) {
  const title = viewName
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <div style={{ maxWidth: 800, margin: "60px auto", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
      <div style={{ width: 80, height: 80, borderRadius: 20, backgroundColor: "hsla(var(--color-blue), 0.1)", color: "hsl(var(--color-blue))", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Layers style={{ width: 40, height: 40 }} />
      </div>
      <div>
        <h2 style={{ fontSize: "2rem", marginBottom: 8 }}>{title} Sub-Application</h2>
        <p style={{ color: "var(--text-secondary)", maxWidth: 500, margin: "0 auto" }}>
          This micro-application is registered in the Greens Nexus Master Portal. The sub-application sandbox container is loaded and ready for integration.
        </p>
      </div>
      <div style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: 8, padding: "16px 24px", fontFamily: "monospace", fontSize: "0.85rem", color: "var(--text-secondary)", textAlign: "left", width: "100%" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}><span style={{ color: "hsl(var(--color-green))" }}>✓</span> Micro-App Handshake Established</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}><span style={{ color: "hsl(var(--color-green))" }}>✓</span> Context tokens injected successfully</div>
        <div style={{ display: "flex", gap: 8 }}><span style={{ color: "hsl(var(--color-orange))" }}>•</span> Awaiting final UI build pipelines for production release...</div>
      </div>
      <button className="primary-btn" onClick={onBack}>
        <ArrowLeft style={{ width: 16, height: 16 }} /> Return to Dashboard
      </button>
    </div>
  );
}
