import BiInsights from '../dashboard/BiInsights';

// BI module (Sep 14, Neil): real per-module management metrics - overdue/
// upcoming/completed tasks, clocked-in vs not, desktop agents in use, ticket
// SLA/assignment/status breakdowns, KB review pipeline, company operations -
// not a customizable widget board. See dashboard/BiInsights.jsx and the
// backend's GET /dashboards/insights for what's actually computed and why.
export default function BusinessIntelligence() {
  return (
    <div className="dashboard-view">
      <BiInsights />
    </div>
  );
}
