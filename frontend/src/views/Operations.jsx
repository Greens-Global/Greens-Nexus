// MapPin/Users/Calendar/X went unused when the mock project dashboard was
// replaced by ConstructionDashboard; dropped here rather than left as dead
// imports for the next reader to wonder about.
import { LayoutDashboard, ClipboardList } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import ConstructionDashboard from '../construction/ConstructionDashboard';
import SiteActivity from '../construction/SiteActivity';

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

      {/* The mock Logistics and Equipment cards were removed 10/31/2026 (Neil):
          sample steel beams and a crane, dated May 2026. */}
    </div>
  );
}
