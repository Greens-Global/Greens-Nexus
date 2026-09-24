// MapPin/Users/Calendar/X went unused when the mock project dashboard was
// replaced by ConstructionDashboard; dropped here rather than left as dead
// imports for the next reader to wonder about.
import { LayoutDashboard, Truck, Settings, ClipboardList } from 'lucide-react';
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


// Old sub ids (from before the module's URL segment was renamed from /ops to
// /construction - see PATH_TO_VIEW/VIEW_TO_PATH in App.jsx) still show up in
// bookmarks, saved notification links, and the nexus:navigate event fired
// from ConstructionDashboard - normalize them here rather than in every
// caller so none of those old links break. The Cubby Integration tab (a
// mock file browser) was removed Sep 22 - its old ids land on the dashboard.
const SUB_ALIASES = {
  'ops-dashboard': 'construction-dashboard', 'ops-activity': 'construction-activity',
  'ops-cubby': 'construction-dashboard', 'construction-cubby': 'construction-dashboard',
};

export default function Operations({ activeSub, onSubChange }) {
  const sub = SUB_ALIASES[activeSub] || activeSub || 'construction-dashboard';

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Tab navigation - desktop renders it centered in the top header;
          phones keep the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs
        tabs={[
          { key: 'construction-dashboard', label: 'Project Dashboard', Icon: LayoutDashboard },
          { key: 'construction-activity',  label: 'Site Activity',     Icon: ClipboardList },
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

    </div>
  );
}
