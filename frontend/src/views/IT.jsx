import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Download, ArrowLeft, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

const BASE = `${import.meta.env.VITE_API_BASE ?? "http://localhost:8000"}/unifi`;

export default function IT({ activeSub = "network" }) {
  if (activeSub === "network") return <NetworkDashboard />;
  return null;
}

function NetworkDashboard() {
  const [view, setView] = useState("overview");
  const [sites, setSites] = useState([]);
  const [detail, setDetail] = useState(null);
  const [currentSite, setCurrentSite] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${BASE}/overview`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      const data = await r.json();
      setSites(data.data || []);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (siteId) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${BASE}/stats?siteId=${encodeURIComponent(siteId)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      setDetail(await r.json());
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOverview(); // eslint-disable-line react-hooks/set-state-in-effect
    const iv = setInterval(loadOverview, 60000);
    return () => clearInterval(iv);
  }, [loadOverview]);

  function openDetail(site) {
    setCurrentSite(site);
    setDetail(null);
    setView("detail");
    loadDetail(site.siteId);
  }

  function backToOverview() {
    setView("overview");
    setCurrentSite(null);
    setDetail(null);
    setError(null);
  }

  function exportCSV() {
    if (!currentSite) return;
    const a = document.createElement("a");
    a.href = `${BASE}/export/csv?siteId=${encodeURIComponent(currentSite.siteId)}`;
    a.download = "";
    a.click();
  }

  const allOffline = sites.flatMap(s =>
    s.offline_devices.map(d => ({ ...d, siteName: s.name, siteId: s.siteId }))
  );
  const allOutdated = sites.flatMap(s =>
    s.outdated_devices.map(d => ({ ...d, siteName: s.name, siteId: s.siteId }))
  );
  const totalAlerts = allOffline.length + allOutdated.length;

  return (
    <div>
      {/* Header */}
      <div className="view-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {view === "detail" && (
            <button
              className="secondary-btn"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              onClick={backToOverview}
            >
              <ArrowLeft style={{ width: 14, height: 14 }} /> Overview
            </button>
          )}
          <div className="view-title-group">
            <h2>{view === "detail" ? currentSite?.name : "Network Dashboard"}</h2>
            <p>{view === "overview" ? "UniFi site overview — devices, clients, and alerts" : "Site devices, clients, and statistics"}</p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastUpdated && (
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Updated {lastUpdated}</span>
          )}
          {view === "detail" && (
            <button
              className="secondary-btn"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              onClick={exportCSV}
            >
              <Download style={{ width: 14, height: 14 }} /> Export CSV
            </button>
          )}
          <button
            className="secondary-btn"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => view === "overview" ? loadOverview() : loadDetail(currentSite.siteId)}
            disabled={loading}
          >
            <RefreshCw style={{ width: 14, height: 14, animation: loading ? "spin 1s linear infinite" : "none" }} />
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: "hsla(0,80%,50%,0.08)", border: "1px solid hsla(0,80%,50%,0.25)", color: "hsl(var(--color-red))", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: "0.875rem" }}>
          ⚠ {error}
        </div>
      )}

      {/* ── OVERVIEW ── */}
      {view === "overview" && (
        <>
          {/* Alert banner */}
          {totalAlerts > 0 && (
            <div style={{ background: "hsla(38,90%,50%,0.08)", border: "1px solid hsla(38,90%,50%,0.25)", borderRadius: 8, marginBottom: 20, overflow: "hidden" }}>
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", cursor: "pointer", userSelect: "none" }}
                onClick={() => setAlertsOpen(o => !o)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "hsl(var(--color-orange))", fontSize: "0.82rem", fontWeight: 600 }}>
                  <AlertTriangle style={{ width: 14, height: 14 }} />
                  {[allOffline.length && `${allOffline.length} OFFLINE`, allOutdated.length && `${allOutdated.length} FIRMWARE UPDATES`].filter(Boolean).join(" · ")}
                  <span style={{ background: "hsl(var(--color-orange))", color: "#000", fontSize: "0.7rem", fontWeight: 700, padding: "1px 7px", borderRadius: 10 }}>
                    {totalAlerts}
                  </span>
                </div>
                {alertsOpen
                  ? <ChevronUp style={{ width: 14, height: 14, color: "hsl(var(--color-orange))" }} />
                  : <ChevronDown style={{ width: 14, height: 14, color: "hsl(var(--color-orange))" }} />}
              </div>

              {alertsOpen && (
                <div style={{ borderTop: "1px solid hsla(38,90%,50%,0.15)" }}>
                  {allOffline.length > 0 && <>
                    <div style={{ padding: "6px 16px 2px", fontSize: "0.7rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "hsl(var(--color-red))", opacity: 0.8 }}>Offline Devices</div>
                    {allOffline.map((d, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 16px", borderTop: "1px solid hsla(38,90%,50%,0.08)", fontSize: "0.82rem" }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", background: "hsl(var(--color-red))", flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{d.name}</span>
                        <span style={{ color: "var(--text-secondary)" }}>{d.model}</span>
                        <button className="secondary-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: "0.7rem" }}
                          onClick={() => openDetail({ siteId: d.siteId, name: d.siteName })}>{d.siteName}</button>
                      </div>
                    ))}
                  </>}
                  {allOutdated.length > 0 && <>
                    <div style={{ padding: "6px 16px 2px", fontSize: "0.7rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "hsl(var(--color-orange))", opacity: 0.8 }}>Firmware Updates</div>
                    {allOutdated.map((d, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 16px", borderTop: "1px solid hsla(38,90%,50%,0.08)", fontSize: "0.82rem" }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", background: "hsl(var(--color-orange))", flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{d.name}</span>
                        <span style={{ color: "var(--text-secondary)" }}>{d.model} · v{d.version}</span>
                        <button className="secondary-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: "0.7rem" }}
                          onClick={() => openDetail({ siteId: d.siteId, name: d.siteName })}>{d.siteName}</button>
                      </div>
                    ))}
                  </>}
                </div>
              )}
            </div>
          )}

          {/* Site cards */}
          {sites.length === 0 && !loading ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--text-secondary)", border: "1px dashed var(--border-color)", borderRadius: 12 }}>
              No sites found — check that the backend is running and the UniFi API key is configured.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {sites.map(site => {
                const hasOffline = site.offline_devices.length > 0;
                const hasOutdated = site.outdated_devices.length > 0;
                const dotColor = hasOffline ? "hsl(var(--color-red))" : hasOutdated ? "hsl(var(--color-orange))" : "hsl(var(--color-green))";
                return (
                  <div
                    key={site.siteId}
                    onClick={() => openDetail(site)}
                    style={{
                      background: "var(--bg-card)",
                      border: `1px solid ${hasOffline ? "hsla(0,80%,50%,0.3)" : "var(--border-color)"}`,
                      borderRadius: 12,
                      padding: 20,
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 14,
                      transition: "border-color 0.15s, box-shadow 0.15s",
                    }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.1))"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{site.name}</span>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, boxShadow: `0 0 6px ${dotColor}`, marginTop: 5, flexShrink: 0 }} />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>Devices</div>
                        <div style={{ fontSize: "1.75rem", fontWeight: 700, lineHeight: 1, color: hasOffline ? "hsl(var(--color-red))" : "hsl(var(--color-green))" }}>
                          {site.online_devices}
                          <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400 }}>/{site.total_devices}</span>
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 3 }}>online</div>
                      </div>
                      <div>
                        <div style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>Clients</div>
                        <div style={{ fontSize: "1.75rem", fontWeight: 700, lineHeight: 1, color: "hsl(var(--color-blue))" }}>
                          {site.wifi_clients + site.wired_clients}
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 3 }}>
                          {site.wifi_clients} WiFi · {site.wired_clients} wired
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 12, borderTop: "1px solid var(--border-color)" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        {hasOffline && <span className="status-badge status-rejected" style={{ fontSize: "0.68rem" }}>{site.offline_devices.length} OFFLINE</span>}
                        {hasOutdated && <span className="status-badge" style={{ background: "hsla(38,90%,50%,0.12)", color: "hsl(var(--color-orange))", fontSize: "0.68rem" }}>{site.outdated_devices.length} FIRMWARE</span>}
                        {site.wan_uptime > 0 && (
                          <span style={{ fontSize: "0.75rem", color: site.wan_uptime < 95 ? "hsl(var(--color-orange))" : "hsl(var(--color-green))" }}>
                            WAN {site.wan_uptime}%
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: "0.75rem", color: "hsl(var(--color-blue))", fontWeight: 600 }}>VIEW →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── DETAIL ── */}
      {view === "detail" && (
        <>
          {!detail && loading && (
            <div style={{ padding: 60, textAlign: "center", color: "var(--text-secondary)" }}>Loading site data...</div>
          )}

          {detail && (
            <>
              {/* Stats strip */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 1, background: "var(--border-color)", border: "1px solid var(--border-color)", borderRadius: 10, overflow: "hidden", marginBottom: 28 }}>
                {[
                  { label: "Total Devices", value: detail.total_devices, color: "hsl(var(--color-blue))" },
                  { label: "Online",         value: detail.online_devices, color: "hsl(var(--color-green))" },
                  { label: "Offline",        value: detail.offline_devices, color: detail.offline_devices > 0 ? "hsl(var(--color-red))" : "var(--text-secondary)" },
                  { label: "Total Clients",  value: detail.total_clients, color: "hsl(var(--color-blue))" },
                  { label: "Wireless",       value: detail.wireless_clients, color: "var(--text-primary)" },
                  { label: "Wired",          value: detail.wired_clients, color: "var(--text-primary)" },
                ].map(s => (
                  <div key={s.label} style={{ background: "var(--bg-card)", padding: "18px 16px" }}>
                    <div style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 10 }}>{s.label}</div>
                    <div style={{ fontSize: "2rem", fontWeight: 700, lineHeight: 1, color: s.color }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Devices table */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--border-color)" }}>
                  <span style={{ fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600 }}>Devices</span>
                  <span className="status-badge" style={{ background: "hsla(215,100%,50%,0.1)", color: "hsl(var(--color-blue))" }}>{detail.devices?.length || 0}</span>
                </div>
                <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: 8, overflow: "hidden" }}>
                  <table className="req-table">
                    <thead>
                      <tr><th>Name</th><th>Model</th><th>IP Address</th><th>MAC</th><th>Firmware</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {!detail.devices?.length ? (
                        <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--text-secondary)", padding: 32 }}>No devices found</td></tr>
                      ) : detail.devices.map((d, i) => (
                        <tr key={i}>
                          <td style={{ fontWeight: 600 }}>{d.name || "—"}</td>
                          <td><span className="status-badge" style={{ background: "var(--border-color)", color: "var(--text-secondary)", fontSize: "0.7rem" }}>{d.model || "—"}</span></td>
                          <td style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{d.ip || "—"}</td>
                          <td style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "var(--text-muted)" }}>{d.mac || "—"}</td>
                          <td>
                            {!d.firmwareStatus || d.firmwareStatus === "upToDate"
                              ? <span className="status-badge status-approved">Up to date</span>
                              : d.firmwareStatus === "upgradeable"
                                ? <span className="status-badge" style={{ background: "hsla(38,90%,50%,0.12)", color: "hsl(var(--color-orange))" }}>Update available</span>
                                : <span className="status-badge" style={{ background: "var(--border-color)", color: "var(--text-secondary)" }}>{d.firmwareStatus}</span>
                            }
                          </td>
                          <td>
                            <span className={`status-badge ${d.status === "online" ? "status-approved" : "status-rejected"}`}>{d.status || "—"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Client summary */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                {[
                  { label: "Wireless Clients", count: detail.wireless_clients, desc: "connected via WiFi" },
                  { label: "Wired Clients",    count: detail.wired_clients,    desc: "connected via ethernet" },
                ].map(c => (
                  <div key={c.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--border-color)" }}>
                      <span style={{ fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600 }}>{c.label}</span>
                      <span className="status-badge" style={{ background: "hsla(215,100%,50%,0.1)", color: "hsl(var(--color-blue))" }}>{c.count}</span>
                    </div>
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                      {c.count ? `${c.count} device${c.count !== 1 ? "s" : ""} ${c.desc}` : `No ${c.label.toLowerCase()}`}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
