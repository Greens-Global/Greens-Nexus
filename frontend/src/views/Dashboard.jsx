import { CheckSquare, Clock, Users, Calendar, ShoppingCart, FileText, TrendingUp, Star } from 'lucide-react';

export default function Dashboard({ onNavigate }) {
  const kpis = [
    { title: 'My Tasks', value: 5, helper: '3 due today', color: 'card-blue', icon: CheckSquare, nav: 'tasks' },
    { title: 'Pending Approvals', value: 5, helper: 'Requires action', color: 'card-orange', icon: Clock, nav: 'purchase' },
    { title: 'Team Workload', value: '87%', helper: 'Capacity', color: 'card-green', icon: Users, nav: null },
    { title: 'Upcoming Shifts', value: 12, helper: 'This week', color: 'card-purple', icon: Calendar, nav: null },
    { title: 'Open Purchase Requests', value: 6, helper: 'Awaiting review', color: 'card-red', icon: ShoppingCart, nav: 'purchase' },
    { title: 'Recent SOP Updates', value: 4, helper: 'New this week', color: 'card-purple', icon: FileText, nav: 'sop' },
    { title: 'Google Ads Performance', value: '$4.2K', helper: 'This month', color: 'card-green', icon: TrendingUp, nav: 'marketing' },
    { title: 'Google Reviews Pending', value: 3, helper: 'Need reply', color: 'card-gold', icon: Star, nav: 'marketing' },
  ];

  return (
    <div className="dashboard-view">
      <section className="greeting-section">
        <h1 className="greeting-title">Good Morning, Pranshu</h1>
        <p className="greeting-sub">Here's what's happening with your work today</p>
      </section>

      <div className="cards-grid">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.title}
              className={`kpi-card ${kpi.color}`}
              style={{ cursor: kpi.nav ? 'pointer' : 'default' }}
              onClick={() => kpi.nav && onNavigate && onNavigate(kpi.nav)}
            >
              <div className="kpi-card-header">
                <span className="kpi-title">{kpi.title}</span>
                <div className="kpi-icon-container">
                  <Icon size={20} />
                </div>
              </div>
              <div className="kpi-stat">{kpi.value}</div>
              <div className="kpi-helper">{kpi.helper}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
