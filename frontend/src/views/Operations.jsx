import { useState } from 'react';
import { LayoutDashboard, FolderSync, Folder, MapPin, Users, Calendar, Truck, Settings, Database, Server, ShieldCheck, FolderOpen, ChevronRight, ArrowLeft, Download, RefreshCw, Upload, X } from 'lucide-react';

const INIT_PROJECTS = [
  { id: 1, name: 'Downtown Commercial Complex', status: 'on-track', location: 'Main Street, Downtown', members: 24, dueDate: 'Aug 15, 2026', progress: 75 },
  { id: 2, name: 'Residential Tower - Phase 2', status: 'delayed', location: 'Harbor View District', members: 18, dueDate: 'Sep 30, 2026', progress: 45 },
  { id: 3, name: 'Industrial Warehouse', status: 'on-track', location: 'North Industrial Zone', members: 12, dueDate: 'Jun 10, 2026', progress: 92 },
];

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

export default function Operations({ activeSub, onSubChange }) {
  const sub = activeSub || 'ops-dashboard';
  const [projects, setProjects] = useState(INIT_PROJECTS);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', location: '', members: '', dueDate: '', progress: '0', status: 'on-track' });
  const [cubbyDir, setCubbyDir] = useState('root');

  const submitProject = (e) => {
    e.preventDefault();
    const d = new Date(form.dueDate);
    const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    setProjects(prev => [...prev, { id: Date.now(), name: form.name, location: form.location, members: parseInt(form.members), dueDate: formatted, progress: parseInt(form.progress), status: form.status }]);
    setShowModal(false);
    setForm({ name: '', location: '', members: '', dueDate: '', progress: '0', status: 'on-track' });
  };

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
      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 }}>
        {[{ key: 'ops-dashboard', label: 'Project Dashboard', Icon: LayoutDashboard }, { key: 'ops-cubby', label: 'Cubby Integration', Icon: FolderSync }].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => onSubChange(key)}
            style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative', transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={18} /> {label}
            {sub === key && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      {/* Project Dashboard */}
      {sub === 'ops-dashboard' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>Construction Overview</h2>
              <p>Project management, logistics, and heavy machinery oversight</p>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="secondary-btn">Schedule Review</button>
              <button className="primary-btn" onClick={() => setShowModal(true)}>New Project</button>
            </div>
          </div>

          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
            {[
              { label: 'Total Workforce', value: '156', helper: '+8 this month', helperColor: 'hsl(var(--color-green))' },
              { label: 'Active Sites', value: '12', helper: '+2 this month', helperColor: 'hsl(var(--color-green))' },
              { label: 'Safety Incidents', value: '0', helper: '0 this month', helperColor: 'var(--text-secondary)' },
              { label: 'Productivity', value: '94%', helper: '+3% this month', helperColor: 'hsl(var(--color-green))' },
            ].map(({ label, value, helper, helperColor }) => (
              <div key={label} className="kpi-card card-blue" style={{ cursor: 'default' }}>
                <div className="kpi-card-header"><span className="kpi-title">{label}</span></div>
                <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
                <div className="kpi-helper" style={{ color: helperColor, fontWeight: 600 }}>{helper}</div>
              </div>
            ))}
          </div>

          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Active Projects</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Current construction and development projects</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {projects.map(proj => (
                <div key={proj.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Folder size={18} style={{ color: 'var(--text-secondary)' }} />
                        <strong style={{ fontSize: '1.05rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{proj.name}</strong>
                        <span style={{ backgroundColor: proj.status === 'delayed' ? 'hsl(var(--color-red))' : '#111827', color: '#fff', fontSize: '0.7rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{proj.status}</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: '0.8rem', color: 'var(--text-secondary)', alignItems: 'center' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><MapPin size={12} /> {proj.location}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Users size={12} /> {proj.members} members</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Calendar size={12} /> Due: {proj.dueDate}</span>
                      </div>
                    </div>
                    <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{proj.progress}%</span>
                  </div>
                  <div style={{ width: '100%', height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${proj.progress}%`, height: '100%', backgroundColor: '#000000', borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

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

          {showModal && (
            <div className="modal-overlay" style={{ display: 'flex' }}>
              <div className="modal-content">
                <div className="modal-header">
                  <h3>Create New Project</h3>
                  <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
                </div>
                <form onSubmit={submitProject}>
                  <div className="form-grid">
                    <div className="form-group form-group-full">
                      <label>Project Name</label>
                      <input type="text" className="form-input" required placeholder="e.g. Oakridge Estate Phase 2" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Location</label>
                      <input type="text" className="form-input" required placeholder="e.g. Main Street, Downtown" value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Subcontractors Count</label>
                      <input type="number" className="form-input" required min="1" placeholder="e.g. 15" value={form.members} onChange={e => setForm(p => ({ ...p, members: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Target Due Date</label>
                      <input type="date" className="form-input" required value={form.dueDate} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Initial Progress (%)</label>
                      <input type="number" className="form-input" required min="0" max="100" placeholder="0" value={form.progress} onChange={e => setForm(p => ({ ...p, progress: e.target.value }))} />
                    </div>
                    <div className="form-group form-group-full">
                      <label>Project Status</label>
                      <select className="form-select" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                        <option value="on-track">on-track</option>
                        <option value="delayed">delayed</option>
                      </select>
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="secondary-btn" onClick={() => setShowModal(false)}>Cancel</button>
                    <button type="submit" className="primary-btn">Create Project</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {/* Cubby Integration */}
      {sub === 'ops-cubby' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>Cubby Secure Cloud Vault</h2>
              <p>Greens Nexus internal operations blueprint repository & subcontractor plans room</p>
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
                <span className="kpi-title">Storage capacity</span>
                <div className="kpi-icon-container"><Database size={18} /></div>
              </div>
              <div className="kpi-stat" style={{ fontSize: '1.6rem' }}>42.5 GB / 100 GB</div>
              <div style={{ width: '100%', height: 4, backgroundColor: 'var(--border-color)', borderRadius: 2, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ width: '42.5%', height: '100%', backgroundColor: 'hsl(var(--color-blue))' }} />
              </div>
            </div>
            <div className="kpi-card card-green" style={{ cursor: 'default' }}>
              <div className="kpi-card-header">
                <span className="kpi-title">Active node connections</span>
                <div className="kpi-icon-container"><Server size={18} /></div>
              </div>
              <div className="kpi-stat" style={{ fontSize: '1.6rem' }}>3 Local Syncs</div>
              <div className="kpi-helper" style={{ color: 'hsl(var(--color-green))', fontWeight: 600 }}>HQ Server, Trailers, Procore Sync</div>
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
                {!isRoot && <><span>·</span><span style={{ color: 'hsl(var(--color-blue))', fontWeight: 700 }}>{cubbyDir}</span></>}
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
