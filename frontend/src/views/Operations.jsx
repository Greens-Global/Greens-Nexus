// MapPin/Users/Calendar/X went unused when the mock project dashboard was
// replaced by ConstructionDashboard; dropped here rather than left as dead
// imports for the next reader to wonder about.
import { LayoutDashboard, ClipboardList } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import ConstructionDashboard from '../construction/ConstructionDashboard';
import SiteActivity from '../construction/SiteActivity';
// Old sub ids still land (see the aliases there), and a project is a URL
// (11/03/2026): project:<id> on the dashboard tab, activity:<id> on Site Activity.
import { parseConstructionSub, projectSub, activitySub } from '../construction/lib/navigation';

export default function Operations({ activeSub, onSubChange }) {
  const { tab, projectId } = parseConstructionSub(activeSub);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Tab navigation - desktop renders it centered in the top header;
          phones keep the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs
        tabs={[
          { key: 'construction-dashboard', label: 'Project Dashboard', Icon: LayoutDashboard },
          { key: 'construction-activity',  label: 'Site Activity',     Icon: ClipboardList },
        ]}
        active={tab} onChange={onSubChange} />

      {/* Project Dashboard - live, backed by /construction/*. Was a hardcoded
          INIT_PROJECTS array and a "156 / 12 / 0 / 94%" KPI row; that block now
          lives in construction/ConstructionDashboard.jsx, which also owns the
          New Project modal. */}
      {tab === 'construction-dashboard' && (
        <ConstructionDashboard projectId={projectId} onOpenProject={(id) => onSubChange?.(projectSub(id))} />
      )}

      {/* Site Activity - the daily logs and the weekly report they add up to.
          Its own tab because those two are what people open every day, and they
          used to sit two levels down inside a project. */}
      {tab === 'construction-activity' && (
        <SiteActivity projectId={projectId} onProjectChange={(id) => onSubChange?.(activitySub(id))} />
      )}

      {/* The mock Logistics and Equipment cards were removed 10/31/2026 (Neil):
          sample steel beams and a crane, dated May 2026. */}
    </div>
  );
}
