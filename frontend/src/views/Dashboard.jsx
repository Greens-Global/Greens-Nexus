import { useMsal } from '@azure/msal-react';
import { MapPin, RefreshCw } from 'lucide-react';

const FACILITIES = [
  { id: "hv", name: "Harbor View Storage",  city: "Tacoma, WA",   occ: 94, units: 612, rented: 575, mrr: 88200,  climate: true  },
  { id: "ds", name: "Downtown Self Storage", city: "Portland, OR", occ: 88, units: 480, rented: 422, mrr: 71400,  climate: true  },
  { id: "rs", name: "Riverside Storage",     city: "Eugene, OR",   occ: 76, units: 350, rented: 266, mrr: 39800,  climate: false },
  { id: "ll", name: "Lakeline Storage",      city: "Bend, OR",     occ: 91, units: 528, rented: 480, mrr: 66100,  climate: true  },
  { id: "sm", name: "Summit Storage",        city: "Spokane, WA",  occ: 69, units: 290, rented: 200, mrr: 27500,  climate: false },
];

const TASKS = [
  { title: "Approve Lakeline repaving change order", dept: "Construction",    due: "Today",    prio: "high" },
  { title: "Q2 occupancy report — Asset Management",  dept: "Asset Management",due: "Today",    prio: "high" },
  { title: "Reply to Downtown 4-star review",         dept: "Operations",      due: "Tomorrow", prio: "med"  },
  { title: "Renew Evergreen Electrical COI",          dept: "Accounting",      due: "May 30",   prio: "high" },
  { title: "Onboard new Summit site manager",         dept: "HR",              due: "Jun 2",    prio: "med"  },
];

const TREND = [
  { m: "Dec", occ: 81 }, { m: "Jan", occ: 83 }, { m: "Feb", occ: 84 },
  { m: "Mar", occ: 86 }, { m: "Apr", occ: 85 }, { m: "May", occ: 88 },
];

function OccupancyChart() {
  const w = 500, h = 160, padX = 20, padY = 16, min = 75, max = 95;
  const xs = i => padX + i * ((w - padX * 2) / (TREND.length - 1));
  const ys = v => h - padY - ((v - min) / (max - min)) * (h - padY * 2);
  const pts = TREND.map((d, i) => `${xs(i)},${ys(d.occ)}`).join(" ");
  const area = `M ${xs(0)},${h - padY} L ` + TREND.map((d, i) => `${xs(i)},${ys(d.occ)}`).join(" L ") + ` L ${xs(TREND.length - 1)},${h - padY} Z`;
  return (
    <svg className="chart-area" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="og" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#111827" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#111827" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#og)" />
      <polyline points={pts} fill="none" stroke="#111827" strokeWidth="2.5" strokeLinejoin="round" />
      {TREND.map((d, i) => (
        <g key={d.m}>
          <circle cx={xs(i)} cy={ys(d.occ)} r="3" fill="#111827" />
          <text x={xs(i)} y={h - 2} fontSize="10" fill="#7C8579" textAnchor="middle" fontFamily="Hanken Grotesk, sans-serif">{d.m}</text>
        </g>
      ))}
    </svg>
  );
}

export default function Dashboard({ onNavigate }) {
  const { accounts } = useMsal();
  const firstName = (accounts[0]?.name ?? "there").split(" ")[0];
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const totalMrr = FACILITIES.reduce((a, f) => a + f.mrr, 0);
  const avgOcc   = Math.round(FACILITIES.reduce((a, f) => a + f.occ, 0) / FACILITIES.length);

  return (
    <div className="dashboard-view">
      {/* Greeting */}
      <div className="greeting-section">
        <div>
          <p className="greeting-eyebrow">Good {timeOfDay}, {firstName}</p>
          <h1 className="greeting-title">Portfolio at a glance</h1>
        </div>
        <button className="primary-btn">
          <RefreshCw size={15} /> Sync facilities
        </button>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Avg. Occupancy</div>
          <div className="kpi-value">{avgOcc}%</div>
          <div className="kpi-delta up">↑ +3 pts MoM</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Monthly Recurring Revenue</div>
          <div className="kpi-value">${(totalMrr / 1000).toFixed(1)}k</div>
          <div className="kpi-delta up">↑ +5.2%</div>
        </div>
        <div className="kpi-card" style={{ cursor: "pointer" }} onClick={() => onNavigate("tasks")}>
          <div className="kpi-label">Open Tasks</div>
          <div className="kpi-value">5</div>
          <div className="kpi-delta">2 due today</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Facilities</div>
          <div className="kpi-value">{FACILITIES.length}</div>
          <div className="kpi-delta">2 states</div>
        </div>
      </div>

      {/* Chart + Tasks */}
      <div className="dash-grid-2">
        <div className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">Occupancy trend</div>
              <div className="dash-card-sub">Portfolio average, last 6 months</div>
            </div>
          </div>
          <OccupancyChart />
        </div>

        <div className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">Tasks</div>
              <div className="dash-card-sub">Across all departments</div>
            </div>
            <button className="link-btn" onClick={() => onNavigate("tasks")}>
              View all →
            </button>
          </div>
          <div className="task-list">
            {TASKS.map((t, i) => (
              <div key={i} className="task-row">
                <span className={`prio-dot prio-${t.prio}`} />
                <div className="task-content">
                  <div className="task-title">{t.title}</div>
                  <div className="task-dept">{t.dept}</div>
                </div>
                <span className={`task-due${t.due === "Today" ? " today" : ""}`}>
                  {t.due}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Facilities */}
      <div className="dash-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-title">Facilities</div>
            <div className="dash-card-sub">Live occupancy across the Greens Storage portfolio</div>
          </div>
        </div>
        <div className="facilities-grid">
          {FACILITIES.map(f => (
            <div key={f.id} className="facility-card">
              <div className="facility-head">
                <div>
                  <div className="facility-name">{f.name}</div>
                  <div className="facility-city"><MapPin size={10} /> {f.city}</div>
                </div>
                {f.climate && <span className="facility-badge">Climate</span>}
              </div>
              <div className="occ-row">
                <div className="occ-bar"><span style={{ width: `${f.occ}%` }} /></div>
                <span className="occ-pct">{f.occ}%</span>
              </div>
              <div className="facility-foot">
                <span>{f.rented}/{f.units} units</span>
                <span className="mrr-tag">${(f.mrr / 1000).toFixed(1)}k MRR</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
