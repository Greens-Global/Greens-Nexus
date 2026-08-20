import { useState } from 'react';
// MapPin/Users/Calendar/X went unused when the mock project dashboard was
// replaced by ConstructionDashboard; dropped here rather than left as dead
// imports for the next reader to wonder about.
import { LayoutDashboard, FolderSync, Folder, Truck, Settings, Database, Server, ShieldCheck, FolderOpen, ChevronRight, ArrowLeft, Download, RefreshCw, Upload, ClipboardList } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import ConstructionDashboard from '../construction/ConstructionDashboard';
import SiteActivity from '../construction/SiteActivity';


const INIT_LOGISTICS = [
  { id: 1, item: 'Steel Beams - 50 units', destination: 'Downtown Complex', eta: 'May 22, 2026', status: 'in-transit' },
  { id: 2, item: 'Cement - 200 bags', destination: 'Residential Tower', eta: 'May 20, 2026', status: 'delivered' },
];

const INIT_EQUIPMENT = [
  { id: 1, name: 'Crane A-45', location: 'Downtown Complex', status: 'in-use', progress: 80 },
  { id: 2, name: 'Excavator EX-12', location: 'Equipment Yard', status: 'available', progress: 0 },
];

const CUBBY_FOLDERS = {
  'Blueprints & CAD drawings': [
    { name: 'downtown_foundation_v3.dwg', size: '12.4 MB', type: 'dwg', date: '2026-05-18' },
    { name: 'harbor_view_mep_v1.dwg', size: '18.1 MB', type: 'dwg', date: '2026-05-20' },
    { name: 'warehouse_framing.dwg', size: '8.2 MB', type: 'dwg', date: '2026-05-14' },
  ],
  'Subcontractor Bid logs': [
    { name: 'apex_concrete_bid_sealed.pdf', size: '1.2 MB', type: 'pdf', date: '2026-05-22' },
    { name: 'electric_bids_tabulation.xlsx', size: '480 KB', type: 'xlsx', date: '2026-05-19' },
  ],
  'Site Safety Audits': [
    { name: 'weekly_safety_check_may20.pdf', size: '1.4 MB', type: 'pdf', date: '2026-05-20' },
    { name: 'osha_compliance_report.pdf', size: '2.1 MB', type: 'pdf', date: '2026-05-10' },
  ],
  'Permits & Regulatory approvals': [
    { name: 'downtown_permit_approved.pdf', size: '820 KB', type: 'pdf', date: '2026-05-21' },
    { name: 'zoning_variance_harbor.pdf', size: '1.1 MB', type: 'pdf', date: '2026-05-15' },
  ],
};

// Old sub ids (from before the module's URL segment was renamed from /ops to
// /construction - see PATH_TO_VIEW/VIEW_TO_PATH in App.jsx) still show up in
// bookmarks, saved notification links, and the nexus:navigate event fired
// from ConstructionDashboard - normalize them here rather than in every
// caller so none of those old links break.
const SUB_ALIASES = { 'ops-dashboard': 'construction-dashboard', 'ops-activity': 'construction-activity', 'ops-cubby': 'construction-cubby' };

export default function Operations({ activeSub, onSubChange }) {
  const sub = SUB_ALIASES[activeSub] || activeSub || 'construction-dashboard';
  const [cubbyDir, setCubbyDir] = useState('root');


  const fileIconColor = (type) => {
    if (type === 'dwg') return 'hsl(var(--color-blue))';
    if (type === 'pdf') return 'hsl(var(--color-red))';
    if (type === 'xlsx') return 'hsl(var(--color-green))';
    return 'var(--text-secondary)';
  };

  const isRoot = cubbyDir === 'root';
  const currentFiles = isRoot ? [] : (CUBBY_FOLDERS[cubbyDir] || []);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Tab navigation - desktop renders it centered in the top header;
          phones keep the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs
        tabs={[
          { key: 'construction-dashboard', label: 'Project Dashboard', Icon: LayoutDashboard },
          { key: 'construction-activity',  label: 'Site Activity',     Icon: ClipboardList },
          { key: 'construction-cubby',     label: 'Cubby Integration', Icon: FolderSync },
        ]}
        active={sub} onChange={onSubChange} />

      {/* Project Dashboard - live, backed by /construction/*. Was a hardcoded
          INIT_PROJECTS array and a "156 / 12 / 0 / 94%" KPI row; that block now
          lives in construction/ConstructionDashboard.jsx, which also owns the
          New Project modal. */}
      {sub === 'construction-dashboard' && <ConstructionDashboard />}

      {/* Site Activity - the daily logs and the weekly report they add up to.
          Its own tab because those two are what people open every day, and they
          used to sit two levels down inside a project. */}
      {sub === 'construction-activity' && <SiteActivity />}

      {/* Logistics and Equipment are still the original mock arrays. Kept
          rendering rather than dropped when projects went live - removing
          working screens was not part of making projects real. */}
      {sub === 'construction-dashboard' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
              <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Logistics & Supply Chain</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>Material deliveries and shipments</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {INIT_LOGISTICS.map(ship => (
                  <div key={ship.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <Truck size={18} style={{ color: 'var(--text-secondary)' }} />
                      <div>
                        <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{ship.item}</strong>
                        <div style={{ fontSize: '0.775rem', color: 'var(--text-secondary)', marginTop: 2 }}>{ship.destination} · ETA: {ship.eta}</div>
                      </div>
                    </div>
                    <span style={{ backgroundColor: ship.status === 'delivered' ? '#111827' : 'var(--border-color)', color: ship.status === 'delivered' ? '#fff' : 'var(--text-secondary)', fontSize: '0.7rem', padding: '4px 10px', borderRadius: 20, fontWeight: 600 }}>{ship.status}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
              <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Equipment Status</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>Heavy machinery and equipment tracking</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {INIT_EQUIPMENT.map(eq => (
                  <div key={eq.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <Settings size={18} style={{ color: 'var(--text-secondary)' }} />
                        <div>
                          <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{eq.name}</strong>
                          <div style={{ fontSize: '0.775rem', color: 'var(--text-secondary)', marginTop: 2 }}>{eq.location}</div>
                        </div>
                      </div>
                      <span style={{ backgroundColor: eq.status === 'available' ? '#111827' : 'var(--border-color)', color: eq.status === 'available' ? '#fff' : 'var(--text-secondary)', fontSize: '0.7rem', padding: '4px 10px', borderRadius: 20, fontWeight: 600 }}>{eq.status}</span>
                    </div>
                    {eq.progress > 0 && (
                      <div style={{ width: '100%', height: 4, backgroundColor: 'var(--border-color)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${eq.progress}%`, height: '100%', backgroundColor: '#000000', borderRadius: 2 }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
      )}

      {/* Cubby Integration */}
      {sub === 'construction-cubby' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>Cubby Secure Cloud Vault</h2>
              <p>Nexus internal operations blueprint repository & subcontractor plans room</p>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} /> Sync Vault
              </button>
              {!isRoot && (
                <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Upload size={14} /> Upload Plan
                </button>
              )}
            </div>
          </div>

          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            <div className="kpi-card card-blue" style={{ cursor: 'default' }}>
              <div className="kpi-card-header">
                <span className="kpi-title">Storage Capacity</span>
                <div className="kpi-icon-container"><Database size={18} /></div>
              </div>
              <div className="kpi-stat" style={{ fontSize: '1.6rem' }}>42.5 GB / 100 GB</div>
              <div style={{ width: '100%', height: 4, backgroundColor: 'var(--border-color)', borderRadius: 2, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ width: '42.5%', height: '100%', backgroundColor: 'var(--ink)' }} />
              </div>
            </div>
            <div className="kpi-card card-green" style={{ cursor: 'default' }}>
              <div className="kpi-card-header">
                <span className="kpi-title">Active Node Connections</span>
                <div className="kpi-icon-container"><Server size={18} /></div>
              </div>
              <div className="kpi-stat" style={{ fontSize: '1.6rem' }}>3 Local Syncs</div>
              <div className="kpi-helper" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>HQ Server, Trailers, Procore Sync</div>
            </div>
            <div className="kpi-card card-purple" style={{ cursor: 'default' }}>
              <div className="kpi-card-header">
                <span className="kpi-title">Encryption Status</span>
                <div className="kpi-icon-container"><ShieldCheck size={18} /></div>
              </div>
              <div className="kpi-stat" style={{ fontSize: '1.6rem' }}>AES-256 Enabled</div>
              <div className="kpi-helper">End-to-End vault encryption active</div>
            </div>
          </div>

          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: '0.9rem' }}>
                <FolderOpen size={18} style={{ color: 'var(--text-secondary)' }} />
                <span>Cubby Root</span>
                {!isRoot && <><span>·</span><span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{cubbyDir}</span></>}
              </div>
              {!isRoot
                ? <button className="secondary-btn" onClick={() => setCubbyDir('root')} style={{ padding: '4px 10px', fontSize: '0.775rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ArrowLeft size={12} /> Up One Level
                  </button>
                : <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Select a folder to browse files</span>
              }
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {isRoot
                ? Object.keys(CUBBY_FOLDERS).map(folderName => (
                    <div key={folderName} onClick={() => setCubbyDir(folderName)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Folder size={22} style={{ color: 'hsl(var(--color-gold))' }} />
                        <div>
                          <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{folderName}</strong>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginTop: 1 }}>Cloud Vault Folder</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{CUBBY_FOLDERS[folderName].length} items</span>
                        <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
                      </div>
                    </div>
                  ))
                : currentFiles.map(file => (
                    <div key={file.name}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border-color)', cursor: 'default' }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--bg-secondary)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = ''}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Download size={20} style={{ color: fileIconColor(file.type) }} />
                        <div>
                          <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{file.name}</strong>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginTop: 1 }}>Synced: {file.date} · {file.size}</span>
                        </div>
                      </div>
                      <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Download size={12} /> Download
                      </button>
                    </div>
                  ))
              }
            </div>
          </div>
        </>
      )}
    </div>
  );
}
