import { useState } from 'react';
import { FileCheck, Map, Info, Building, MapPin, RefreshCw, ExternalLink, File, X, Plus } from 'lucide-react';

const INIT_PERMITS = [
  { id: 1, project: 'Luxury Apartment Complex', permitNo: 'BLD-2026-00412', type: 'Zoning & Height Variance', agency: 'Oceanview Zoning Board', status: 'Approved', date: '2026-02-18' },
  { id: 2, project: 'Mixed-Use Development', permitNo: 'BLD-2026-08912', type: 'Foundation & Earth Retention', agency: 'City Building Department', status: 'Under Review', date: '2026-04-05' },
  { id: 3, project: 'Suburban Housing Project', permitNo: 'ENV-2026-31021', type: 'Stormwater Runoff Discharge', agency: 'Environmental Protection Agency', status: 'Approved', date: '2026-03-22' },
  { id: 4, project: 'Mixed-Use Development', permitNo: 'BLD-2026-09245', type: 'MEP Structural Engineering', agency: 'City Fire & Safety Division', status: 'Pending Action', date: '2026-05-10' },
];

const INIT_PLANS = {
  'Luxury Apartment Complex': [
    { name: 'Luxury Apartments - Architectural Layouts.pdf', category: 'Architectural Specs', revision: 'Rev 4', size: '12.4 MB' },
    { name: 'Luxury Apartments - MEP Drawing Grid.dwg', category: 'MEP Systems', revision: 'Rev 2', size: '24.1 MB' },
    { name: 'Luxury Apartments - Soils & Civil Engineering.pdf', category: 'Civil & Foundation', revision: 'Rev 1', size: '8.5 MB' },
  ],
  'Mixed-Use Development': [
    { name: 'Mixed-Use Retail - Structural Shell.dwg', category: 'Structural Shell', revision: 'Rev 3', size: '32.4 MB' },
    { name: 'Mixed-Use Retail - Electrical Wiring Grid.pdf', category: 'MEP Systems', revision: 'Rev 2', size: '14.8 MB' },
  ],
  'Suburban Housing Project': [
    { name: 'Suburban Phase 1 - Civil Grading Map.dwg', category: 'Civil Layout', revision: 'Rev 5', size: '16.2 MB' },
    { name: 'Suburban Housing - Model A Framing Specs.pdf', category: 'Architectural Specs', revision: 'Rev 3', size: '4.8 MB' },
  ],
};

const INIT_PROPERTIES = [
  { id: 1, name: 'Oceanview Parcel A-14', size: '4.2 Acres', zoning: 'R-4 High-Density Residential', parcelNo: 'APN-890-412-09', surveyor: 'Apex Surveying Ltd', cost: 12500000, titleStatus: 'Cleared & Insured' },
  { id: 2, name: 'Main Street Plaza Lot', size: '1.8 Acres', zoning: 'C-3 Central Business District', parcelNo: 'APN-312-089-22', surveyor: 'Precision Land Surveying', cost: 18000000, titleStatus: 'Cleared & Insured' },
  { id: 3, name: 'Green Valley Phase 2 Plot', size: '28.5 Acres', zoning: 'SUB-1 Suburban Residential', parcelNo: 'APN-540-310-44', surveyor: 'Valley Soil & Survey LLC', cost: 8400000, titleStatus: 'Pending Title Escrow' },
];

const permitStatusStyle = (s) => {
  if (s === 'Approved') return { bg: 'hsla(var(--color-green), 0.1)', color: 'hsl(var(--color-green))' };
  if (s === 'Under Review') return { bg: 'hsla(var(--color-blue), 0.1)', color: 'hsl(var(--color-blue))' };
  return { bg: 'hsla(var(--color-orange), 0.1)', color: 'hsl(var(--color-orange))' };
};

export default function Development({ activeSub, onSubChange }) {
  const sub = activeSub || 'dev-permits';
  const [permits, setPermits] = useState(INIT_PERMITS);
  const [properties, setProperties] = useState(INIT_PROPERTIES);
  const [showParcelModal, setShowParcelModal] = useState(false);
  const [parcelForm, setParcelForm] = useState({ name: '', size: '', zoning: '', parcelNo: '', cost: '', surveyor: '', titleStatus: 'Cleared & Insured' });

  const checkPermit = (id) => setPermits(prev => prev.map(p => p.id === id ? { ...p, status: 'Approved' } : p));

  const submitParcel = (e) => {
    e.preventDefault();
    setProperties(prev => [...prev, { id: Date.now(), ...parcelForm, cost: parseInt(parcelForm.cost) }]);
    setShowParcelModal(false);
    setParcelForm({ name: '', size: '', zoning: '', parcelNo: '', cost: '', surveyor: '', titleStatus: 'Cleared & Insured' });
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 }}>
        {[
          { key: 'dev-permits', label: 'Permit Status', Icon: FileCheck },
          { key: 'dev-plans', label: 'Project Plans', Icon: Map },
          { key: 'dev-details', label: 'Property Details', Icon: Info },
        ].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => onSubChange(key)}
            style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative', transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={18} /> {label}
            {sub === key && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
        {/* Permit Status */}
        {sub === 'dev-permits' && (
          <>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Zoning & Construction Permit Tracker</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Monitor city approvals, building permits, and height variance clearances</p>
              </div>
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={14} /> Sync City Database
              </button>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr>
                    <th>Project Site</th>
                    <th>Permit Type</th>
                    <th>Municipal Agency</th>
                    <th>Permit Number</th>
                    <th>Submitted Date</th>
                    <th>Approval Status</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {permits.map(p => {
                    const s = permitStatusStyle(p.status);
                    return (
                      <tr key={p.id}>
                        <td style={{ fontWeight: 600 }}>{p.project}</td>
                        <td style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{p.type}</td>
                        <td>{p.agency}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{p.permitNo}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{p.date}</td>
                        <td>
                          <span style={{ backgroundColor: s.bg, color: s.color, fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{p.status}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="secondary-btn" onClick={() => checkPermit(p.id)} style={{ padding: '4px 10px', fontSize: '0.75rem' }}>Check Live Status</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Project Plans */}
        {sub === 'dev-plans' && (
          <>
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Design Plans & Engineering Drawings</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Access blueprints, structural CAD files, and electrical drawing links by project site</p>
            </div>
            {Object.keys(INIT_PLANS).map(projName => (
              <div key={projName} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 20, backgroundColor: 'var(--bg-primary)', marginBottom: 16 }}>
                <h4 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
                  <Building size={18} style={{ color: 'var(--text-secondary)' }} />
                  {projName}
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                  {INIT_PLANS[projName].map(d => (
                    <div key={d.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', fontSize: '0.85rem', cursor: 'pointer' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <File size={18} style={{ color: 'hsl(var(--color-blue))' }} />
                        <div>
                          <strong style={{ color: 'var(--text-primary)', display: 'block', fontSize: '0.825rem', wordBreak: 'break-all' }}>{d.name}</strong>
                          <span style={{ fontSize: '0.725rem', color: 'var(--text-secondary)' }}>{d.category} · {d.revision}</span>
                        </div>
                      </div>
                      <ExternalLink size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Property Details */}
        {sub === 'dev-details' && (
          <>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Development Property Parcels</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Review details of acquired land, zoning classifications, and surveyor audits</p>
              </div>
              <button className="primary-btn" onClick={() => setShowParcelModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> Add Land Parcel
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
              {properties.map(p => (
                <div key={p.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div>
                      <strong style={{ fontSize: '1.05rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block' }}>{p.name}</strong>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{p.zoning}</span>
                    </div>
                    <MapPin size={18} style={{ color: 'var(--text-muted)' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.825rem', marginBottom: 16, borderBottom: '1px dashed var(--border-color)', paddingBottom: 12 }}>
                    {[
                      ['Parcel Number', p.parcelNo, true],
                      ['Total Acreage', p.size, false],
                      ['Acquisition Value', `$${(p.cost / 1000000).toFixed(1)}M`, false],
                      ['Title Status', p.titleStatus, false, 'hsl(var(--color-green))'],
                      ['Lead Surveyor', p.surveyor, false],
                    ].map(([label, val, mono, clr]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{label}:</span>
                        <strong style={{ color: clr || 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit' }}>{val}</strong>
                      </div>
                    ))}
                  </div>
                  <button className="secondary-btn" style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem' }}>View Survey Report</button>
                </div>
              ))}
            </div>

            {showParcelModal && (
              <div className="modal-overlay" style={{ display: 'flex' }}>
                <div className="modal-content">
                  <div className="modal-header">
                    <h3>Register Land Parcel</h3>
                    <button className="close-btn" onClick={() => setShowParcelModal(false)}><X size={18} /></button>
                  </div>
                  <form onSubmit={submitParcel}>
                    <div className="form-grid">
                      <div className="form-group form-group-full">
                        <label>Parcel Name</label>
                        <input type="text" className="form-input" required placeholder="e.g. Westlake Sector 4 Plot" value={parcelForm.name} onChange={e => setParcelForm(p => ({ ...p, name: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Total Acreage</label>
                        <input type="text" className="form-input" required placeholder="e.g. 5.6 Acres" value={parcelForm.size} onChange={e => setParcelForm(p => ({ ...p, size: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Zoning Class</label>
                        <input type="text" className="form-input" required placeholder="e.g. R-4 Multi-Family" value={parcelForm.zoning} onChange={e => setParcelForm(p => ({ ...p, zoning: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>APN Parcel Number</label>
                        <input type="text" className="form-input" required placeholder="e.g. APN-920-112-40" value={parcelForm.parcelNo} onChange={e => setParcelForm(p => ({ ...p, parcelNo: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Acquisition Cost ($)</label>
                        <input type="number" className="form-input" required min="1" placeholder="e.g. 5000000" value={parcelForm.cost} onChange={e => setParcelForm(p => ({ ...p, cost: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Lead Surveyor</label>
                        <input type="text" className="form-input" required placeholder="e.g. Precise Lands Surveying" value={parcelForm.surveyor} onChange={e => setParcelForm(p => ({ ...p, surveyor: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>Title Status</label>
                        <select className="form-select" value={parcelForm.titleStatus} onChange={e => setParcelForm(p => ({ ...p, titleStatus: e.target.value }))}>
                          <option>Cleared & Insured</option>
                          <option>Pending Title Escrow</option>
                        </select>
                      </div>
                    </div>
                    <div className="modal-footer">
                      <button type="button" className="secondary-btn" onClick={() => setShowParcelModal(false)}>Cancel</button>
                      <button type="submit" className="primary-btn">Save Parcel</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
