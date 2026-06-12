import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Download, ArrowLeft, AlertTriangle, ChevronDown, ChevronUp, Globe, Wifi, Plus, ExternalLink, AlertCircle } from "lucide-react";
import { msalInstance, msalReady } from "../msalInstance";
import { apiTokenRequest } from "../authConfig";

const BASE = `${import.meta.env.VITE_API_BASE ?? "http://localhost:8000"}/unifi`;

// Asset Management tab removed Jun 12 (Visesh) — the legacy hardware_assets
// flow is superseded by the Items module; equipment lives on the items table.
const TABS = [
  { key: 'network',     label: 'Network Dashboard',  Icon: Wifi },
  { key: 'it-websites', label: 'Website Management', Icon: Globe },
];

export default function IT({ activeSub = "network", onSubChange }) {
  const sub = activeSub || 'network';

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 }}>
        {TABS.map(({ key, label, Icon }) => (
          <button key={key} onClick={() => onSubChange && onSubChange(key)}
            style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative', transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={18} /> {label}
            {sub === key && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>
      {sub === 'network'     && <NetworkDashboard />}
      {sub === 'it-websites' && <ITWebsites />}
    </div>
  );
}


// ── Website Management ───────────────────────────────────────────────────────

const TODAY_DATE = new Date('2026-05-28'); // SSL/domain expiry countdowns

const INIT_SITES = [
  { id: 1, name: 'Greens Global',        url: 'https://greensglobal.com',       platform: 'WordPress',  hosting: 'WP Engine',    domainExpiry: '2027-01-14', sslExpiry: '2026-08-01', status: 'Live',           analytics: '4,280 visits/mo' },
  { id: 2, name: 'Greens Nexus App',     url: 'https://vlow2k.github.io/Greens-Nexus', platform: 'React/Vite', hosting: 'GitHub Pages', domainExpiry: '—',         sslExpiry: 'Auto',       status: 'Live',           analytics: 'Internal' },
  { id: 3, name: 'Greens Global Ads LP', url: 'https://greensglobal.com/promo', platform: 'WordPress',  hosting: 'WP Engine',    domainExpiry: '2027-01-14', sslExpiry: '2026-08-01', status: 'Live',           analytics: '1,050 visits/mo' },
  { id: 4, name: 'Investor Portal',      url: 'https://investors.greensglobal.com', platform: 'Custom',  hosting: 'AWS',          domainExpiry: '2027-01-14', sslExpiry: '2026-11-20', status: 'In Development', analytics: '—' },
  { id: 5, name: 'OPS Field App',        url: 'https://ops.greensglobal.com',   platform: 'React',      hosting: 'Render',       domainExpiry: '2027-01-14', sslExpiry: 'Auto',       status: 'Staging',        analytics: 'Internal' },
];

function ITWebsites() {
  const [sites, setSites] = useState(INIT_SITES);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', platform: '', hosting: '', domainExpiry: '', sslExpiry: '', status: 'Live', analytics: '' });

  const sslDaysLeft = (val) => {
    if (val === 'Auto' || val === '—') return null;
    return Math.ceil((new Date(val) - TODAY_DATE) / (1000 * 3600 * 24));
  };

  const submit = (e) => {
    e.preventDefault();
    setSites(prev => [{ id: Date.now(), ...form }, ...prev]);
    setShowModal(false);
    setForm({ name: '', url: '', platform: '', hosting: '', domainExpiry: '', sslExpiry: '', status: 'Live', analytics: '' });
  };

  const statusColor = (s) => s === 'Live' ? 'status-approved' : s === 'Staging' ? 'status-pending' : 'status-badge';

  return (
    <div>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Website Management</h2>
          <p>Monitor domains, SSL certificates, hosting, and site status</p>
        </div>
        <button className="primary-btn" onClick={() => setShowModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Site
        </button>
      </div>

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Sites',   value: sites.length,                                       color: 'hsl(var(--color-blue))' },
          { label: 'Live',          value: sites.filter(s => s.status === 'Live').length,       color: 'hsl(var(--color-green))' },
          { label: 'Staging / Dev', value: sites.filter(s => s.status !== 'Live').length,      color: 'hsl(var(--color-orange))' },
          { label: 'SSL Alerts',    value: sites.filter(s => { const d = sslDaysLeft(s.sslExpiry); return d !== null && d <= 60; }).length, color: 'hsl(var(--color-red))' },
        ].map(s => (
          <div key={s.label} className="motion-card" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 18px' }}>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Site cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {sites.map(site => {
          const sslDays = sslDaysLeft(site.sslExpiry);
          const sslWarn = sslDays !== null && sslDays <= 60;
          return (
            <div key={site.id} className="motion-card" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 4 }}>{site.name}</div>
                  <a href={site.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.78rem', color: 'hsl(var(--color-blue))', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
                    {site.url.replace('https://', '')} <ExternalLink size={10} />
                  </a>
                </div>
                <span className={`status-badge ${statusColor(site.status)}`}>{site.status}</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: '0.82rem' }}>
                {[
                  { label: 'Platform', value: site.platform },
                  { label: 'Hosting',  value: site.hosting },
                  { label: 'Domain Expiry', value: site.domainExpiry },
                  { label: 'Analytics', value: site.analytics },
                ].map(r => (
                  <div key={r.label}>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{r.label}</div>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{r.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
                {sslWarn && <AlertCircle size={13} style={{ color: 'hsl(var(--color-orange))' }} />}
                <span style={{ fontSize: '0.78rem', color: sslWarn ? 'hsl(var(--color-orange))' : 'var(--text-secondary)', fontWeight: sslWarn ? 600 : 400 }}>
                  SSL: {site.sslExpiry === 'Auto' ? 'Auto-renew' : site.sslExpiry === '—' ? 'N/A' : sslDays !== null && sslDays < 0 ? 'EXPIRED' : `${sslDays}d remaining`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 28, width: 480, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ marginBottom: 20, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Add New Site</h3>
            <form onSubmit={submit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {[
                  { label: 'Site Name', key: 'name', type: 'text', full: true },
                  { label: 'URL', key: 'url', type: 'url', full: true },
                  { label: 'Platform', key: 'platform', type: 'text' },
                  { label: 'Hosting', key: 'hosting', type: 'text' },
                  { label: 'Domain Expiry', key: 'domainExpiry', type: 'date' },
                  { label: 'SSL Expiry', key: 'sslExpiry', type: 'text' },
                  { label: 'Status', key: 'status', type: 'select', options: ['Live', 'Staging', 'In Development', 'Offline'] },
                  { label: 'Analytics', key: 'analytics', type: 'text' },
                ].map(f => (
                  <div key={f.key} className="form-group" style={f.full ? { gridColumn: '1/-1' } : {}}>
                    <label>{f.label}</label>
                    {f.type === 'select'
                      ? <select className="form-select" value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}>
                          {f.options.map(o => <option key={o}>{o}</option>)}
                        </select>
                      : <input className="form-input" type={f.type} required={f.key !== 'analytics'} value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} />
                    }
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" className="secondary-btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Add Site</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const CACHE_KEY = "unifi_overview_cache";

function WanPortDot({ plugged }) {
  const color = plugged ? "hsl(var(--color-green))" : "hsl(var(--color-red))";
  return <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, boxShadow: `0 0 4px ${color}`, flexShrink: 0 }} />;
}

function IssueTypeBadge({ period }) {
  if (period.wan_downtime) return <span style={{ fontSize: "0.65rem", background: "hsla(0,80%,50%,0.12)", color: "hsl(var(--color-red))", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>WAN DOWN</span>;
  if (period.packet_loss)  return <span style={{ fontSize: "0.65rem", background: "hsla(38,90%,50%,0.12)", color: "hsl(var(--color-orange))", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>PACKET LOSS</span>;
  if (period.not_reported) return <span style={{ fontSize: "0.65rem", background: "hsla(215,100%,50%,0.1)", color: "hsl(var(--color-blue))", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>UNREPORTED</span>;
  return null;
}

function NetworkDashboard() {
  const [view, setView] = useState("overview");
  const [sites, setSites] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(CACHE_KEY)) || []; } catch { return []; }
  });
  const [detail, setDetail] = useState(null);
  const [currentSite, setCurrentSite] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const getAuthHeader = async () => {
    await msalReady;
    const accounts = msalInstance.getAllAccounts();
    if (!accounts.length) return {};
    try {
      const result = await msalInstance.acquireTokenSilent({ ...apiTokenRequest, account: accounts[0] });
      return { Authorization: `Bearer ${result.idToken}` };
    } catch { return {}; }
  };

  const fetchWithTimeout = async (url, timeoutMs = 12000, attempt = 1) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const authHeader = await getAuthHeader();
      const r = await fetch(url, { signal: controller.signal, headers: authHeader });
      clearTimeout(timer);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      return r.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Request timed out — backend may be waking up. Try refreshing in a few seconds.', { cause: e });
      // "Failed to fetch" — fetch() couldn't even complete (dropped connection,
      // brief network blip). Usually transient, so retry with backoff rather
      // than showing the user a cryptic browser-level error.
      if (e instanceof TypeError && attempt < 3) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        return fetchWithTimeout(url, timeoutMs, attempt + 1);
      }
      throw e;
    }
  };

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWithTimeout(`${BASE}/overview`);
      const fresh = data.data || [];
      setSites(fresh);
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
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
      const data = await fetchWithTimeout(`${BASE}/stats?siteId=${encodeURIComponent(siteId)}`);
      setDetail(data);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOverview();
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

  async function exportCSV() {
    // A plain <a href> can't carry the Authorization header — the backend
    // rejected it with 401. Fetch with the token, download the blob instead.
    if (!currentSite) return;
    try {
      const authHeader = await getAuthHeader();
      const r = await fetch(`${BASE}/export/csv?siteId=${encodeURIComponent(currentSite.siteId)}`, { headers: authHeader });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `unifi_${currentSite.siteId}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || "Export failed");
    }
  }

  const allOffline       = sites.flatMap(s => s.offline_devices.map(d => ({ ...d, siteName: s.name, siteId: s.siteId })));
  const allOutdated      = sites.flatMap(s => s.outdated_devices.map(d => ({ ...d, siteName: s.name, siteId: s.siteId })));
  const allIssues        = sites.filter(s => s.has_internet_issues).map(s => ({ siteName: s.name, siteId: s.siteId, isp: s.isp_name }));
  const allCritical      = sites.filter(s => s.critical_notifications > 0).map(s => ({ siteName: s.name, siteId: s.siteId, count: s.critical_notifications }));
  const totalAlerts      = allOffline.length + allOutdated.length + allIssues.length + allCritical.length;

  const detailOfflineCount = detail ? (detail.offline_wired_devices || 0) + (detail.offline_wifi_devices || 0) : 0;

  return (
    <div>
      <div className="view-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {view === "detail" && (
            <button className="secondary-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} onClick={backToOverview}>
              <ArrowLeft style={{ width: 14, height: 14 }} /> Overview
            </button>
          )}
          <div className="view-title-group">
            <h2>
              {view === "detail" ? currentSite?.name : "Network Dashboard"}
              {view === "detail" && detail?.firmware_version && (
                <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--text-muted)", marginLeft: 10 }}>OS {detail.firmware_version}</span>
              )}
            </h2>
            <p>
              {view === "overview"
                ? "UniFi site overview — devices, clients, and alerts"
                : `${detail?.isp_name || ""}${detail?.location?.text ? ` · ${detail.location.text}` : ""}`}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastUpdated && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Updated {lastUpdated}</span>}
          {view === "detail" && detail?.hostId && (
            <a
              href={`https://unifi.ui.com/consoles/${detail.hostId}/network/default/dashboard`}
              target="_blank" rel="noopener noreferrer"
              className="secondary-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
              <ExternalLink style={{ width: 14, height: 14 }} /> Open in UniFi
            </a>
          )}
          {view === "detail" && (
            <button className="secondary-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} onClick={exportCSV}>
              <Download style={{ width: 14, height: 14 }} /> Export CSV
            </button>
          )}
          <button className="secondary-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => view === "overview" ? loadOverview() : loadDetail(currentSite.siteId)} disabled={loading}>
            <RefreshCw style={{ width: 14, height: 14, animation: loading ? "spin 1s linear infinite" : "none" }} />
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: "hsla(0,80%,50%,0.08)", border: "1px solid hsla(0,80%,50%,0.25)", color: "hsl(var(--color-red))", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: "0.875rem" }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Overview ── */}
      {view === "overview" && (
        <>
          {totalAlerts > 0 && (
            <div style={{ background: "hsla(38,90%,50%,0.08)", border: "1px solid hsla(38,90%,50%,0.25)", borderRadius: 8, marginBottom: 20, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", cursor: "pointer", userSelect: "none" }} onClick={() => setAlertsOpen(o => !o)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "hsl(var(--color-orange))", fontSize: "0.82rem", fontWeight: 600 }}>
                  <AlertTriangle style={{ width: 14, height: 14 }} />
                  {[
                    allOffline.length   && `${allOffline.length} OFFLINE`,
                    allOutdated.length  && `${allOutdated.length} FIRMWARE`,
                    allIssues.length    && `${allIssues.length} INTERNET ISSUES`,
                    allCritical.length  && `${allCritical.reduce((a, s) => a + s.count, 0)} CRITICAL`,
                  ].filter(Boolean).join(" · ")}
                  <span style={{ background: "hsl(var(--color-orange))", color: "#000", fontSize: "0.7rem", fontWeight: 700, padding: "1px 7px", borderRadius: 10 }}>{totalAlerts}</span>
                </div>
                {alertsOpen ? <ChevronUp style={{ width: 14, height: 14, color: "hsl(var(--color-orange))" }} /> : <ChevronDown style={{ width: 14, height: 14, color: "hsl(var(--color-orange))" }} />}
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
                        <button className="secondary-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: "0.7rem" }} onClick={() => openDetail({ siteId: d.siteId, name: d.siteName })}>{d.siteName}</button>
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
                        <button className="secondary-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: "0.7rem" }} onClick={() => openDetail({ siteId: d.siteId, name: d.siteName })}>{d.siteName}</button>
                      </div>
                    ))}
                  </>}
                  {allIssues.length > 0 && <>
                    <div style={{ padding: "6px 16px 2px", fontSize: "0.7rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "hsl(var(--color-red))", opacity: 0.8 }}>Internet Issues</div>
                    {allIssues.map((s, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 16px", borderTop: "1px solid hsla(38,90%,50%,0.08)", fontSize: "0.82rem" }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", background: "hsl(var(--color-red))", flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{s.siteName}</span>
                        {s.isp && <span style={{ color: "var(--text-secondary)" }}>{s.isp}</span>}
                        <button className="secondary-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: "0.7rem" }} onClick={() => openDetail({ siteId: s.siteId, name: s.siteName })}>View</button>
                      </div>
                    ))}
                  </>}
                  {allCritical.length > 0 && <>
                    <div style={{ padding: "6px 16px 2px", fontSize: "0.7rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "hsl(var(--color-orange))", opacity: 0.8 }}>Critical Notifications</div>
                    {allCritical.map((s, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 16px", borderTop: "1px solid hsla(38,90%,50%,0.08)", fontSize: "0.82rem" }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", background: "hsl(var(--color-orange))", flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{s.siteName}</span>
                        <span style={{ color: "var(--text-secondary)" }}>{s.count} notification{s.count !== 1 ? "s" : ""}</span>
                        <button className="secondary-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: "0.7rem" }} onClick={() => openDetail({ siteId: s.siteId, name: s.siteName })}>View</button>
                      </div>
                    ))}
                  </>}
                </div>
              )}
            </div>
          )}

          {sites.length === 0 && loading && (
            <div style={{ textAlign: "center", padding: 60, color: "var(--text-secondary)" }}>
              <RefreshCw style={{ width: 20, height: 20, animation: "spin 1s linear infinite", marginBottom: 12 }} />
              <div style={{ fontSize: "0.9rem" }}>Connecting to UniFi backend…</div>
              <div style={{ fontSize: "0.78rem", marginTop: 6, color: "var(--text-muted)" }}>This may take a few seconds on first load.</div>
            </div>
          )}
          {sites.length === 0 && !loading && !error && (
            <div style={{ textAlign: "center", padding: 60, color: "var(--text-secondary)", border: "1px dashed var(--border-color)", borderRadius: 12 }}>
              No sites found — check that the backend is running and the UniFi API key is configured.
            </div>
          )}
          {sites.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
              {sites.map(site => {
                const hasOffline   = site.offline_devices.length > 0;
                const hasOutdated  = site.outdated_devices.length > 0;
                const hasIssues    = site.has_internet_issues;
                const hasCritical  = site.critical_notifications > 0;
                const highRetry    = (site.tx_retry_pct || 0) >= 5;
                const dotColor = hasOffline || hasIssues ? "hsl(var(--color-red))" : hasOutdated || hasCritical ? "hsl(var(--color-orange))" : "hsl(var(--color-green))";
                const wanEntries   = Object.entries(site.wans || {});
                return (
                  <div key={site.siteId} onClick={() => openDetail(site)}
                    className="motion-card"
                    style={{ background: "var(--bg-card)", border: `1px solid ${hasOffline || hasIssues ? "hsla(0,80%,50%,0.3)" : "var(--border-color)"}`, borderRadius: 12, padding: 20, cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, transition: "border-color 0.15s, box-shadow 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.1))"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>

                    {/* Header row */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>{site.name}</div>
                        {site.isp_name && <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 2 }}>{site.isp_name}</div>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                        {/* WAN port indicators */}
                        {(site.wan_ports || []).map((wp, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <WanPortDot plugged={wp.plugged} />
                            <span style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>{wp.type}</span>
                          </div>
                        ))}
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, boxShadow: `0 0 6px ${dotColor}`, marginLeft: 4 }} />
                      </div>
                    </div>

                    {/* Devices + Clients */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>Devices</div>
                        <div style={{ fontSize: "1.75rem", fontWeight: 700, lineHeight: 1, color: hasOffline ? "hsl(var(--color-red))" : "hsl(var(--color-green))" }}>
                          {site.online_devices}<span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400 }}>/{site.total_devices}</span>
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: 3 }}>
                          {site.total_wifi_devices > 0 && `${site.total_wifi_devices} WiFi`}
                          {site.total_wifi_devices > 0 && site.total_wired_devices > 0 && " · "}
                          {site.total_wired_devices > 0 && `${site.total_wired_devices} wired`}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>Clients</div>
                        <div style={{ fontSize: "1.75rem", fontWeight: 700, lineHeight: 1, color: "hsl(var(--color-blue))" }}>{site.wifi_clients + site.wired_clients}</div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: 3 }}>{site.wifi_clients} WiFi · {site.wired_clients} wired</div>
                      </div>
                    </div>

                    {/* Per-WAN uptime row */}
                    {wanEntries.length > 0 && (
                      <div style={{ display: "flex", gap: 12 }}>
                        {wanEntries.map(([key, wan]) => (
                          <div key={key} style={{ fontSize: "0.75rem" }}>
                            <span style={{ color: "var(--text-muted)" }}>{key}: </span>
                            <span style={{ fontWeight: 600, color: wan.uptime >= 99 ? "hsl(var(--color-green))" : wan.uptime >= 95 ? "hsl(var(--color-orange))" : "hsl(var(--color-red))" }}>
                              {wan.uptime}%
                            </span>
                          </div>
                        ))}
                        {highRetry && (
                          <div style={{ fontSize: "0.75rem" }}>
                            <span style={{ color: "var(--text-muted)" }}>TX Retry: </span>
                            <span style={{ fontWeight: 600, color: "hsl(var(--color-orange))" }}>{site.tx_retry_pct}%</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Badge row */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: "1px solid var(--border-color)" }}>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        {hasOffline    && <span className="status-badge status-rejected" style={{ fontSize: "0.65rem" }}>{site.offline_devices.length} OFFLINE</span>}
                        {hasOutdated   && <span className="status-badge" style={{ background: "hsla(38,90%,50%,0.12)", color: "hsl(var(--color-orange))", fontSize: "0.65rem" }}>{site.outdated_devices.length} FIRMWARE</span>}
                        {hasCritical   && <span className="status-badge" style={{ background: "hsla(0,80%,50%,0.1)", color: "hsl(var(--color-red))", fontSize: "0.65rem" }}>{site.critical_notifications} CRITICAL</span>}
                        {hasIssues     && <span className="status-badge status-rejected" style={{ fontSize: "0.65rem" }}>WAN ISSUE</span>}
                        {site.pending_updates > 0 && <span className="status-badge" style={{ background: "hsla(215,100%,50%,0.1)", color: "hsl(var(--color-blue))", fontSize: "0.65rem" }}>{site.pending_updates} PENDING</span>}
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

      {/* ── Detail ── */}
      {view === "detail" && (
        <>
          {!detail && loading && <div style={{ padding: 60, textAlign: "center", color: "var(--text-secondary)" }}>Loading site data...</div>}
          {detail && (
            <>
              {/* Stat strip */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 1, background: "var(--border-color)", border: "1px solid var(--border-color)", borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
                {[
                  { label: "Total Devices",    value: detail.total_devices,          color: "hsl(var(--color-blue))" },
                  { label: "Online",           value: detail.online_devices,          color: "hsl(var(--color-green))" },
                  { label: "Offline",          value: detailOfflineCount,             color: detailOfflineCount > 0 ? "hsl(var(--color-red))" : "var(--text-secondary)" },
                  { label: "Pending Updates",  value: detail.pending_updates || 0,    color: detail.pending_updates > 0 ? "hsl(var(--color-orange))" : "var(--text-secondary)", link: detail.pending_updates > 0 && detail.hostId ? `https://unifi.ui.com/consoles/${detail.hostId}/network/default/dashboard` : null },
                  { label: "Critical Alerts",  value: detail.critical_notifications || 0, color: detail.critical_notifications > 0 ? "hsl(var(--color-red))" : "var(--text-secondary)" },
                  { label: "WiFi Clients",     value: detail.wifi_clients,            color: "hsl(var(--color-blue))" },
                  { label: "Wired Clients",    value: detail.wired_clients,           color: "hsl(var(--color-blue))" },
                  { label: "TX Retry",         value: `${detail.tx_retry_pct || 0}%`, color: (detail.tx_retry_pct || 0) >= 5 ? "hsl(var(--color-orange))" : "var(--text-secondary)" },
                ].map(s => (
                  s.link
                    ? <a key={s.label} href={s.link} target="_blank" rel="noopener noreferrer"
                        style={{ background: "var(--bg-card)", padding: "16px 14px", textDecoration: "none", display: "block", cursor: "pointer" }}
                        title="Open in UniFi">
                        <div style={{ fontSize: "0.65rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 8 }}>{s.label} ↗</div>
                        <div style={{ fontSize: "1.7rem", fontWeight: 700, lineHeight: 1, color: s.color }}>{s.value}</div>
                      </a>
                    : <div key={s.label} style={{ background: "var(--bg-card)", padding: "16px 14px" }}>
                        <div style={{ fontSize: "0.65rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 8 }}>{s.label}</div>
                        <div style={{ fontSize: "1.7rem", fontWeight: 700, lineHeight: 1, color: s.color }}>{s.value}</div>
                      </div>
                ))}
              </div>

              {/* WAN section */}
              {Object.keys(detail.wans || {}).length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600, marginBottom: 10 }}>WAN Connections</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                    {Object.entries(detail.wans).map(([key, wan]) => {
                      const port = (detail.wan_ports || []).find(p => p.type === key);
                      const isPlugged = port ? port.plugged : wan.uptime > 0;
                      // Only surface issues on ports that are actually connected
                      const hasWanIssues = isPlugged && wan.issues?.length > 0;
                      return (
                        <div key={key} style={{ background: "var(--bg-card)", border: `1px solid ${hasWanIssues ? "hsla(0,80%,50%,0.3)" : "var(--border-color)"}`, borderRadius: 10, padding: "16px 18px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>{key}</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {port && <WanPortDot plugged={port.plugged} />}
                              {port && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{port.plugged ? "Link up" : "No link"}</span>}
                            </div>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: "0.8rem" }}>
                            <div>
                              <div style={{ color: "var(--text-muted)", fontSize: "0.68rem", textTransform: "uppercase", marginBottom: 2 }}>Uptime</div>
                              <div style={{ fontWeight: 700, color: wan.uptime >= 99 ? "hsl(var(--color-green))" : wan.uptime >= 95 ? "hsl(var(--color-orange))" : "hsl(var(--color-red))" }}>{wan.uptime}%</div>
                            </div>
                            {(wan.external_ip || port?.ip) && (
                              <div>
                                <div style={{ color: "var(--text-muted)", fontSize: "0.68rem", textTransform: "uppercase", marginBottom: 2 }}>External IP</div>
                                <div style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--text-secondary)" }}>{wan.external_ip || port?.ip}</div>
                              </div>
                            )}
                            {port?.speed && (
                              <div>
                                <div style={{ color: "var(--text-muted)", fontSize: "0.68rem", textTransform: "uppercase", marginBottom: 2 }}>Speed</div>
                                <div style={{ color: "var(--text-primary)" }}>{port.speed}</div>
                              </div>
                            )}
                            {hasWanIssues && (
                              <div>
                                <div style={{ color: "var(--text-muted)", fontSize: "0.68rem", textTransform: "uppercase", marginBottom: 2 }}>Issues</div>
                                <div style={{ color: "hsl(var(--color-red))", fontWeight: 600 }}>{wan.issues.length} event{wan.issues.length !== 1 ? "s" : ""}</div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Internet issues 5min — only shown when at least one connected WAN is unhealthy */}
              {(detail.internet_issues_5min || []).filter(p => p.wan_downtime || p.packet_loss || p.not_reported).length > 0 &&
               Object.entries(detail.wans || {}).some(([key, wan]) => {
                 const port = (detail.wan_ports || []).find(p => p.type === key);
                 return (port ? port.plugged : wan.uptime > 0) && wan.uptime < 100;
               }) && (
                <div style={{ marginBottom: 20, background: "var(--bg-card)", border: "1px solid hsla(0,80%,50%,0.25)", borderRadius: 10, padding: "14px 18px" }}>
                  <div style={{ fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "hsl(var(--color-red))", fontWeight: 600, marginBottom: 10 }}>
                    Internet Issues — Last 5 Minutes
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {detail.internet_issues_5min.filter(p => p.wan_downtime || p.packet_loss || p.not_reported).map((p, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "0.8rem" }}>
                        <IssueTypeBadge period={p} />
                        {p.count && <span style={{ color: "var(--text-secondary)" }}>{p.count} occurrence{p.count !== 1 ? "s" : ""}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Devices table */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--border-color)" }}>
                  <span style={{ fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600 }}>Devices</span>
                  <span className="status-badge" style={{ background: "hsla(215,100%,50%,0.1)", color: "hsl(var(--color-blue))" }}>{detail.devices?.length || 0}</span>
                </div>
                <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: 8, overflow: "hidden" }}>
                  <table className="req-table stack-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Model</th>
                        <th>Product Line</th>
                        <th>IP Address</th>
                        <th>MAC</th>
                        <th>Firmware</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!detail.devices?.length
                        ? <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-secondary)", padding: 32 }}>No devices found</td></tr>
                        : detail.devices.map((d, i) => (
                          <tr key={i}>
                            <td>
                              <div style={{ fontWeight: 600 }}>{d.name || "—"}</div>
                              {d.isConsole && (
                                <a href={`https://unifi.ui.com/consoles/${detail.hostId}/network/default/dashboard`}
                                   target="_blank" rel="noopener noreferrer"
                                   style={{ fontSize: "0.68rem", color: "hsl(var(--color-blue))", fontWeight: 600, textDecoration: "none" }}>
                                  CONSOLE ↗
                                </a>
                              )}
                            </td>
                            <td data-th="Model"><span className="status-badge" style={{ background: "var(--border-color)", color: "var(--text-secondary)", fontSize: "0.7rem" }}>{d.model || "—"}</span></td>
                            <td data-th="Product line" style={{ fontSize: "0.8rem", color: "var(--text-secondary)", textTransform: "capitalize" }}>{d.productLine || "—"}</td>
                            <td data-th="IP" style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{d.ip || "—"}</td>
                            <td data-th="MAC" style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "var(--text-muted)" }}>{d.mac || "—"}</td>
                            <td data-th="Firmware">
                              {!d.firmwareStatus || d.firmwareStatus === "upToDate"
                                ? <span className="status-badge status-approved">Up to date</span>
                                : d.firmwareStatus === "upgradeable"
                                  ? <a href={`https://unifi.ui.com/consoles/${detail.hostId}/network/default/dashboard`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                                      <span className="status-badge" style={{ background: "hsla(38,90%,50%,0.12)", color: "hsl(var(--color-orange))", cursor: "pointer" }}>Update available ↗</span>
                                    </a>
                                  : <span className="status-badge" style={{ background: "var(--border-color)", color: "var(--text-secondary)" }}>{d.firmwareStatus}</span>
                              }
                            </td>
                            <td data-th="Status"><span className={`status-badge ${d.status === "online" ? "status-approved" : "status-rejected"}`}>{d.status || "—"}</span></td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Offline breakdown cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                {[
                  { label: "Offline Wired Devices",   value: detail.offline_wired_devices || 0,  color: "hsl(var(--color-red))",    total: detail.total_wired_devices || 0 },
                  { label: "Offline WiFi Devices",    value: detail.offline_wifi_devices || 0,   color: "hsl(var(--color-orange))", total: detail.total_wifi_devices || 0  },
                  { label: "WiFi Clients",            value: detail.wifi_clients,                color: "hsl(var(--color-blue))",   total: null },
                  { label: "Wired Clients",           value: detail.wired_clients,               color: "hsl(var(--color-blue))",   total: null },
                ].map(c => (
                  <div key={c.label} className="motion-card" style={{ background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: "0.68rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 8 }}>{c.label}</div>
                    <div style={{ fontSize: "1.8rem", fontWeight: 700, color: c.value > 0 && c.label.startsWith("Offline") ? c.color : c.label.includes("Client") ? c.color : "var(--text-secondary)" }}>{c.value}</div>
                    {c.total !== null && <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>of {c.total} total</div>}
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
