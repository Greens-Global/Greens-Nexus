import { Gauge } from 'lucide-react';
import CustomDashboard from '../dashboard/CustomDashboard';

// BI module (Sep 14, Neil): "Relevant KPI from all modules sit here... And
// sortable filterable, looks at all data and builds insights." Reuses the
// exact widget-grid engine the personal Dashboard runs on (own board target
// 'bi-dashboard', own saved views, same KPI feed and widget catalog) instead
// of a parallel build - see CustomDashboard.jsx and dashboard/useDashboards.js.
// "Independent dashboards built for each module... components of that can be
// added to the BI dashboard or regular dashboard" is a later phase: each
// module gets its own board the same way, and every widget stays droppable
// on any of them since they all read from one WIDGETS catalog.
export default function BusinessIntelligence() {
  return (
    <div className="dashboard-view">
      <CustomDashboard
        target="bi-dashboard"
        title="Business Intelligence"
        subtitle="KPIs across every module"
        icon={Gauge}
        showDeskHome={false}
      />
    </div>
  );
}
