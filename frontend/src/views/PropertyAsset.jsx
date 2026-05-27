import { useState } from 'react';
import { LayoutGrid, Shield, FileText, ClipboardCheck, Plus, Download, UploadCloud, Users, X } from 'lucide-react';

const INIT_PORTFOLIO = [
  { id: 1, name: 'Harbor View Condos', type: 'Residential Complex', units: 120, address: 'Harbor View District, Lot 14', purchaseCost: 45000000, yearBuilt: 2024, occupancyRate: 94, manager: 'Sarah Johnson' },
  { id: 2, name: 'Downtown Commercial Complex', type: 'Commercial Plaza', units: 45, address: '88 Main Street, Downtown', purchaseCost: 68000000, yearBuilt: 2023, occupancyRate: 98, manager: 'Michael Chen' },
  { id: 3, name: 'Oakridge Subdivision Phase 1', type: 'Subdivision Estate', units: 250, address: 'Green Valley Road, Lot 8B', purchaseCost: 32000000, yearBuilt: 2025, occupancyRate: 85, manager: 'Robert Kim' },
  { id: 4, name: 'North Industrial Warehouse', type: 'Industrial Center', units: 8, address: 'North Industrial Zone', purchaseCost: 15000000, yearBuilt: 2022, occupancyRate: 100, manager: 'Marcus Vance' },
];

const INIT_WARRANTIES = [
  { id: 1, equipName: 'Carrier VRF Commercial HVAC System', location: 'Downtown Complex - Block A', vendor: 'Carrier HVAC Corp', start: '2023-08-15', end: '2028-08-15', contact: 'tech-support@carrier.com', policyNo: 'WAR-CAR-90812' },
  { id: 2, equipName: 'Otis Gen2 Passenger Elevator Co', location: 'Harbor View Condos - Tower 1', vendor: 'Otis Elevator Inc', start: '2024-02-10', end: '2026-06-25', contact: 'service@otis.com', policyNo: 'WAR-OTIS-88219' },
  { id: 3, equipName: 'Cummins Diesel Emergency Generator', location: 'Downtown Complex - Basement B', vendor: 'Cummins Power Systems', start: '2023-09-01', end: '2027-09-01', contact: 'parts@cummins.com', policyNo: 'WAR-CUM-74021' },
  { id: 4, equipName: 'Square D High-Voltage Transformers', location: 'North Industrial Warehouse', vendor: 'Schneider Electric', start: '2022-11-20', end: '2032-11-20', contact: 'electrical@schneider.com', policyNo: 'WAR-SCH-11894' },
];

const INIT_PLANS = [
  { id: 1, projName: 'Downtown Commercial Complex', category: 'Architectural As-Built', filename: 'downtown_as_built_architectural.dwg', size: '42.5 MB', uploadDate: '2024-01-20' },
  { id: 2, projName: 'Downtown Commercial Complex', category: 'Electrical & MEP Plans', filename: 'downtown_as_built_mep.dwg', size: '68.1 MB', uploadDate: '2024-01-25' },
  { id: 3, projName: 'Harbor View Condos', category: 'Structural Foundation Plans', filename: 'harbor_view_structural_final.dwg', size: '28.3 MB', uploadDate: '2024-05-10' },
  { id: 4, projName: 'North Industrial Warehouse', category: 'Civil As-Built Site Layout', filename: 'north_warehouse_civil_asbuilt.pdf', size: '12.4 MB', uploadDate: '2023-03-12' },
];

const INIT_INSPECTIONS = [
  { id: 1, title: 'Annual Fire Sprinkler & Safety Inspection', property: 'Downtown Commercial Complex', agency: 'Metro Fire Department', date: '2025-09-12', nextDue: '2026-09-12', status: 'Compliant' },
  { id: 2, title: 'Elevator Safety & Certifications Audit', property: 'Harbor View Condos', agency: 'State Division of Building Safety', date: '2025-06-05', nextDue: '2026-06-05', status: 'Needs Inspection' },
  { id: 3, title: 'Structural Foundation Integrity Survey', property: 'North Industrial Warehouse', agency: 'Apex Structural Engineering', date: '2025-04-18', nextDue: '2026-04-18', status: 'Compliant' },
  { id: 4, title: 'RPZ Backflow Preventer Annual Audit', property: 'Downtown Commercial Complex', agency: 'Municipal Water Authority', date: '2026-05-20', nextDue: '2027-05-20', status: 'Compliant' },
];

const TODAY = new Date('2026-05-27');

export default function PropertyAsset({ activeSub, onSubChange }) {
  const sub = activeSub || 'asset-portfolio';
  const [portfolio, setPortfolio] = useState(INIT_PORTFOLIO);
  const [inspections, setInspections] = useState(INIT_INSPECTIONS);
  const [showPropModal, setShowPropModal] = useState(false);
  const [propForm, setPropForm] = useState({ name: '', type: '', units: '', address: '', purchaseCost: '', yearBuilt: '', occupancyRate: '', manager: '' });

  const submitProp = (e) => {
    e.preventDefault();
    setPortfolio(prev => [...prev, { id: Date.now(), ...propForm, units: parseInt(propForm.units), purchaseCost: parseInt(propForm.purchaseCost), yearBuilt: parseInt(propForm.yearBuilt), occupancyRate: parseInt(propForm.occupancyRate) }]);
    setShowPropModal(false);
    setPropForm({ name: '', type: '', units: '', address: '', purchaseCost: '', yearBuilt: '', occupancyRate: '', manager: '' });
  };

  const recordCompliance = (id) => setInspections(prev => prev.map(i => {
    if (i.id !== id) return i;
    const now = new Date();
    const next = new Date(now);
    next.setFullYear(next.getFullYear() + 1);
    return { ...i, status: 'Compliant', date: now.toISOString().split('T')[0], nextDue: next.toISOString().split('T')[0] };
  }));

  const warrantyStatus = (endDate) => {
    const diff = Math.ceil((new Date(endDate) - TODAY) / (1000 * 3600 * 24));
    return { expiring: diff <= 45, days: diff };
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 }}>
        {[
          { key: 'asset-portfolio', label: 'Property Portfolio', Icon: LayoutGrid },
          { key: 'asset-warranties', label: 'Equipment Warranties', Icon: Shield },
          { key: 'asset-plans', label: 'As-Built Plans', Icon: FileText },
          { key: 'asset-inspections', label: 'Annual Inspections', Icon: ClipboardCheck },
        ].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => onSubChange(key)}
            style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative', transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={18} /> {label}
            {sub === key && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>

        {/* Property Portfolio */}
        {sub === 'asset-portfolio' && (
          <>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Real Estate Property Portfolio</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Review values, geographic addresses, capacities, and active managers</p>
              </div>
              <button className="primary-btn" onClick={() => setShowPropModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> Add Property Asset
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
              {portfolio.map(p => (
                <div key={p.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 20, transition: 'all 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-hover)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div>
                      <strong style={{ fontSize: '1.05rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block' }}>{p.name}</strong>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{p.type}</span>
                    </div>
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'hsl(var(--color-green))' }}>{p.occupancyRate}% Occupied</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.825rem', marginBottom: 16, borderBottom: '1px dashed var(--border-color)', paddingBottom: 12 }}>
                    {[['Address', p.address], ['Units/Suites', `${p.units} units`], ['Acquisition Cost', `$${(p.purchaseCost / 1000000).toFixed(1)}M`], ['Year Completed', p.yearBuilt], ['Asset Manager', p.manager]].map(([label, val]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{label}:</span>
                        <strong style={{ color: 'var(--text-primary)' }}>{val}</strong>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="secondary-btn" style={{ flex: 1, padding: '6px 12px', fontSize: '0.8rem' }}>View Details</button>
                    <button className="secondary-btn" style={{ padding: '6px 8px' }}><Users size={14} /></button>
                  </div>
                </div>
              ))}
            </div>

            {showPropModal && (
              <div className="modal-overlay" style={{ display: 'flex' }}>
                <div className="modal-content">
                  <div className="modal-header">
                    <h3>Register Property Asset</h3>
                    <button className="close-btn" onClick={() => setShowPropModal(false)}><X size={18} /></button>
                  </div>
                  <form onSubmit={submitProp}>
                    <div className="form-grid">
                      <div className="form-group form-group-full">
                        <label>Property Name</label>
                        <input type="text" className="form-input" required placeholder="e.g. Greens Plaza East" value={propForm.name} onChange={e => setPropForm(p => ({ ...p, name: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Property Category</label>
                        <input type="text" className="form-input" required placeholder="e.g. Mixed-Use Commercial" value={propForm.type} onChange={e => setPropForm(p => ({ ...p, type: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Total Units/Suites</label>
                        <input type="number" className="form-input" required min="1" placeholder="e.g. 64" value={propForm.units} onChange={e => setPropForm(p => ({ ...p, units: e.target.value }))} />
                      </div>
                      <div className="form-group form-group-full">
                        <label>Geographic Address</label>
                        <input type="text" className="form-input" required placeholder="e.g. 101 North Boulevard, Sector 4" value={propForm.address} onChange={e => setPropForm(p => ({ ...p, address: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Acquisition Cost ($)</label>
                        <input type="number" className="form-input" required min="1" placeholder="e.g. 24000000" value={propForm.purchaseCost} onChange={e => setPropForm(p => ({ ...p, purchaseCost: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Year Completed</label>
                        <input type="number" className="form-input" required min="1900" max="2030" placeholder="e.g. 2025" value={propForm.yearBuilt} onChange={e => setPropForm(p => ({ ...p, yearBuilt: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Initial Occupancy (%)</label>
                        <input type="number" className="form-input" required min="0" max="100" placeholder="e.g. 90" value={propForm.occupancyRate} onChange={e => setPropForm(p => ({ ...p, occupancyRate: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Assigned Asset Manager</label>
                        <input type="text" className="form-input" required placeholder="e.g. Sarah Johnson" value={propForm.manager} onChange={e => setPropForm(p => ({ ...p, manager: e.target.value }))} />
                      </div>
                    </div>
                    <div className="modal-footer">
                      <button type="button" className="secondary-btn" onClick={() => setShowPropModal(false)}>Cancel</button>
                      <button type="submit" className="primary-btn">Save Asset</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </>
        )}

        {/* Equipment Warranties */}
        {sub === 'asset-warranties' && (
          <>
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Building Systems & Equipment Warranties</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Track structural machinery policies, supplier contacts, and contract terms</p>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr>
                    <th>Equipment Name</th><th>Location Site</th><th>Vendor</th><th>Policy Number</th><th>Warranty Period</th><th>Mfr Support</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {INIT_WARRANTIES.map(w => {
                    const { expiring, days } = warrantyStatus(w.end);
                    return (
                      <tr key={w.id}>
                        <td style={{ fontWeight: 600 }}>{w.equipName}</td>
                        <td>{w.location}</td>
                        <td>{w.vendor}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{w.policyNo}</td>
                        <td style={{ fontSize: '0.85rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span>Start: {w.start}</span>
                            <span style={{ fontWeight: 600, color: expiring ? 'hsl(var(--color-red))' : 'var(--text-secondary)' }}>End: {w.end}</span>
                          </div>
                        </td>
                        <td><a href={`mailto:${w.contact}`} style={{ color: 'hsl(var(--color-blue))', fontWeight: 500, fontSize: '0.85rem', textDecoration: 'none' }}>{w.contact}</a></td>
                        <td>
                          <span style={{ backgroundColor: expiring ? 'hsla(var(--color-red), 0.1)' : 'hsla(var(--color-green), 0.1)', color: expiring ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700 }}>
                            {expiring ? `Expiring Soon (${days}d)` : 'Active Policy'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* As-Built Plans */}
        {sub === 'asset-plans' && (
          <>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>As-Built Blueprints & Specifications</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Access verified final blueprints and engineering specifications for post-construction maintenance</p>
              </div>
              <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <UploadCloud size={14} /> Upload CAD Drawing
              </button>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr><th>Property Project</th><th>Category & Drawing Type</th><th>Filename</th><th>File Size</th><th>Date Synced</th><th style={{ textAlign: 'right' }}>Action</th></tr>
                </thead>
                <tbody>
                  {INIT_PLANS.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.projName}</td>
                      <td style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{p.category}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{p.filename}</td>
                      <td style={{ fontSize: '0.85rem' }}>{p.size}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{p.uploadDate}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.775rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Download size={12} /> Download DWG
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Annual Inspections */}
        {sub === 'asset-inspections' && (
          <>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Annual Safety Inspections Compliance</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Track fire alarms, elevator systems, RPZ backflow preventers, and structural safety certifications</p>
              </div>
              <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ClipboardCheck size={14} /> Schedule Audit
              </button>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr><th>Audit Title</th><th>Property Site</th><th>Certifying Agency</th><th>Last Inspected</th><th>Next Due</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
                </thead>
                <tbody>
                  {inspections.map(ins => {
                    const ok = ins.status === 'Compliant';
                    return (
                      <tr key={ins.id}>
                        <td style={{ fontWeight: 600 }}>{ins.title}</td>
                        <td>{ins.property}</td>
                        <td style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{ins.agency}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{ins.date}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 600, color: ok ? 'var(--text-secondary)' : 'hsl(var(--color-red))' }}>{ins.nextDue}</td>
                        <td>
                          <span style={{ backgroundColor: ok ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-red), 0.1)', color: ok ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{ins.status}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {ok
                            ? <button className="secondary-btn" style={{ padding: '4px 8px', fontSize: '0.75rem' }}>View Certificate</button>
                            : <button className="primary-btn" onClick={() => recordCompliance(ins.id)} style={{ padding: '4px 8px', fontSize: '0.75rem' }}>Record Compliance</button>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
