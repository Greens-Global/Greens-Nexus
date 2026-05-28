import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Download, ArrowLeft, AlertTriangle, ChevronDown, ChevronUp, Laptop, Globe, Plus, ExternalLink, AlertCircle } from "lucide-react";
// Wifi import kept for NetworkDashboard (currently hidden from UI, code preserved for future use)
// import { Wifi } from "lucide-react";

const BASE = `${import.meta.env.VITE_API_BASE ?? "http://localhost:8000"}/unifi`;

const TABS = [
  { key: 'it-assets',  label: 'Asset Management',  Icon: Laptop },
  { key: 'it-websites',label: 'Website Management', Icon: Globe },
];

export default function IT({ activeSub = "it-assets", onSubChange }) {
  const sub = activeSub === 'network' ? 'it-assets' : (activeSub || 'it-assets');

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
      {sub === 'it-assets'   && <ITAssets />}
      {sub === 'it-websites' && <ITWebsites />}
    </div>
  );
}

// ── IT Asset Management ──────────────────────────────────────────────────────

const INIT_ASSETS = [
  { id: 'A001', name: 'Dell XPS 15 Laptop',         category: 'Laptop',   assignee: 'Visesh Lodha',    dept: 'IT',          location: 'Main Office',       status: 'Active',      purchased: '2024-03-10', warrantyEnd: '2027-03-10' },
  { id: 'A002', name: 'MacBook Pro 14" M3',          category: 'Laptop',   assignee: 'Sarah Johnson',   dept: 'Accounting',  location: 'Main Office',       status: 'Active',      purchased: '2024-06-01', warrantyEnd: '2027-06-01' },
  { id: 'A003', name: 'Dell UltraSharp 27" Monitor', category: 'Monitor',  assignee: 'Michael Chen',    dept: 'Development', location: 'Dev Floor',         status: 'Active',      purchased: '2023-11-15', warrantyEnd: '2026-11-15' },
  { id: 'A004', name: 'HP ProDesk 600 G9 Desktop',   category: 'Desktop',  assignee: 'Reception Desk',  dept: 'Admin',       location: 'Front Lobby',       status: 'Active',      purchased: '2023-08-20', warrantyEnd: '2026-08-20' },
  { id: 'A005', name: 'Cisco Catalyst 2960 Switch',  category: 'Network',  assignee: 'IT Rack',         dept: 'IT',          location: 'Server Room',       status: 'Active',      purchased: '2022-05-01', warrantyEnd: '2025-05-01' },
  { id: 'A006', name: 'Synology DS1823xs+ NAS',      category: 'Server',   assignee: 'IT Infrastructure',dept: 'IT',         location: 'Server Room',       status: 'Active',      purchased: '2023-02-14', warrantyEnd: '2026-02-14' },
  { id: 'A007', name: 'iPhone 15 Pro',               category: 'Phone',    assignee: 'Robert Kim',      dept: 'OPS',         location: 'Field',             status: 'Active',      purchased: '2024-01-08', warrantyEnd: '2025-01-08' },
  { id: 'A008', name: 'iPad Pro 12.9" Gen 6',        category: 'Tablet',   assignee: 'Marcus Vance',    dept: 'OPS',         location: 'Field',             status: 'Active',      purchased: '2023-09-22', warrantyEnd: '2024-09-22' },
  { id: 'A009', name: 'Logitech MX Keys Keyboard',   category: 'Peripheral',assignee: 'Dev Team Pool',  dept: 'Development', location: 'Dev Floor',         status: 'In Storage',  purchased: '2024-02-28', warrantyEnd: '2026-02-28' },
  { id: 'A010', name: 'APC Smart-UPS 1500VA',        category: 'Power',    assignee: 'IT Rack',         dept: 'IT',          location: 'Server Room',       status: 'Active',      purchased: '2022-11-01', warrantyEnd: '2025-11-01' },
];

const ASSET_CATEGORIES = ['All', 'Laptop', 'Desktop', 'Monitor', 'Phone', 'Tablet', 'Server', 'Network', 'Peripheral', 'Power'];
const TODAY_DATE = new Date('2026-05-28');

function ITAssets() {
  const [assets, setAssets] = useState(INIT_ASSETS);
  const [filter, setFilter] = useState('All');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'Laptop', assignee: '', dept: 'IT', location: '', status: 'Active', purchased: '', warrantyEnd: '' });

  const visible = filter === 'All' ? assets : assets.filter(a => a.category === filter);

  const warrantyAlert = (end) => {
    const days = Math.ceil((new Date(end) - TODAY_DATE) / (1000 * 3600 * 24));
    return { expired: days < 0, expiring: days >= 0 && days <= 90, days };
  };

  const submit = (e) => {
    e.preventDefault();
    const id = `A${String(assets.length + 1).padStart(3, '0')}`;
    setAssets(prev => [{ id, ...form }, ...prev]);
    setShowModal(false);
    setForm({ name: '', category: 'Laptop', assignee: '', dept: 'IT', location: '', status: 'Active', purchased: '', warrantyEnd: '' });
  };

  return (
    <div>
      <div className="view-header">
        <div className="view-title-group">
          <h2>IT Asset Management</h2>
          <p>Track hardware, devices, and equipment across all departments</p>
        </div>
        <button className="primary-btn" onClick={() => setShowModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Asset
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Assets',   value: assets.length,                                         color: 'hsl(var(--color-blue))' },
          { label: 'Active',         value: assets.filter(a => a.status === 'Active').length,       color: 'hsl(var(--color-green))' },
          { label: 'In Storage',     value: assets.filter(a => a.status === 'In Storage').length,   color: 'var(--text-secondary)' },
          { label: 'Warranty Expiring', value: assets.filter(a => { const w = warrantyAlert(a.warrantyEnd); return w.expiring || w.expired; }).length, color: 'hsl(var(--color-orange))' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 18px' }}>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {ASSET_CATEGORIES.map(c => (
          <button key={c} onClick={() => setFilter(c)}
            style={{ padding: '4px 12px', borderRadius: 20, border: '1px solid var(--border-color)', background: filter === c ? 'var(--text-primary)' : 'var(--bg-card)', color: filter === c ? 'var(--bg-primary)' : 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer' }}>
            {c}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
        <table className="req-table">
          <thead>
            <tr><th>Asset ID</th><th>Name / Category</th><th>Assigned To</th><th>Location</th><th>Warranty</th><th>Status</th></tr>
          </thead>
          <tbody>
            {visible.map(a => {
              const w = warrantyAlert(a.warrantyEnd);
              return (
                <tr key={a.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{a.id}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{a.name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{a.category} · {a.dept}</div>
                  </td>
                  <td>{a.assignee}</td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>{a.location}</td>
                  <td>
                    <span style={{ fontSize: '0.82rem', color: w.expired ? 'hsl(var(--color-red))' : w.expiring ? 'hsl(var(--color-orange))' : 'var(--text-secondary)', fontWeight: w.expired || w.expiring ? 600 : 400 }}>
                      {w.expired ? `Expired ${Math.abs(w.days)}d ago` : w.expiring ? `${w.days}d left` : a.warrantyEnd}
                    </span>
                  </td>
                  <td><span className={`status-badge ${a.status === 'Active' ? 'status-approved' : 'status-pending'}`}>{a.status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add Asset Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 28, width: 480, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ marginBottom: 20, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Add New Asset</h3>
            <form onSubmit={submit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {[
                  { label: 'Asset Name', key: 'name', type: 'text', full: true },
                  { label: 'Category', key: 'category', type: 'select', options: ASSET_CATEGORIES.slice(1) },
                  { label: 'Assigned To', key: 'assignee', type: 'text' },
                  { label: 'Department', key: 'dept', type: 'text' },
                  { label: 'Location', key: 'location', type: 'text' },
                  { label: 'Status', key: 'status', type: 'select', options: ['Active', 'In Storage', 'Decommissioned'] },
                  { label: 'Purchase Date', key: 'purchased', type: 'date' },
                  { label: 'Warranty End', key: 'warrantyEnd', type: 'date' },
                ].map(f => (
                  <div key={f.key} className="form-group" style={f.full ? { gridColumn: '1/-1' } : {}}>
                    <label>{f.label}</label>
                    {f.type === 'select'
                      ? <select className="form-select" value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}>
                          {f.options.map(o => <option key={o}>{o}</option>)}
                        </select>
                      : <input className="form-input" type={f.type} required value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} />
                    }
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" className="secondary-btn" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Add Asset</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Website Management ───────────────────────────────────────────────────────

const INIT_SITES = [
  { id: 1, name: 'Greens Global',        url: 'https://greensglobal.com',       platform: 'WordPress',  hosting: 'WP Engine',    domainExpiry: '2027-01-14', sslExpiry: '2026-08-01', status: 'Live',       analytics: '4,280 visits/mo' },
  { id: 2, name: 'Greens Nexus App',     url: 'https://vlow2k.github.io/Greens-Nexus', platform: 'React/Vite', hosting: 'GitHub Pages', domainExpiry: '—',         sslExpiry: 'Auto',       status: 'Live',       analytics: 'Internal' },
  { id: 3, name: 'Greens Global Ads LP', url: 'https://greensglobal.com/promo', platform: 'WordPress',  hosting: 'WP Engine',    domainExpiry: '2027-01-14', sslExpiry: '2026-08-01', status: 'Live',       analytics: '1,050 visits/mo' },
  { id: 4, name: 'Investor Portal',      url: 'https://investors.greensglobal.com', platform: 'Custom',  hosting: 'AWS',          domainExpiry: '2027-01-14', sslExpiry: '2026-11-20', status: 'In Development', analytics: '—' },
  { id: 5, name: 'OPS Field App',        url: 'https://ops.greensglobal.com',   platform: 'React',      hosting: 'Render',       domainExpiry: '2027-01-14', sslExpiry: 'Auto',       status: 'Staging',    analytics: 'Internal' },
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
          <div key={s.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 18px' }}>
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
            <div key={site.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
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

      {/* Add Site Modal */}
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

// eslint-disable-next-line no-unused-vars
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
