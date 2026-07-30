import { useState } from "react";
import { Server, Star, Calendar } from "lucide-react";
import ModuleTabs from "../components/ModuleTabs";

const TABS = [
  { key: "fms",        label: "FMS Integration",         Icon: Server   },
  { key: "reputation", label: "Reputation Management",   Icon: Star     },
  { key: "site-staff", label: "Site Staff & Scheduling", Icon: Calendar },
];

const FACILITIES = [
  { name: "Harbor View Storage",  units: 612, rented: 575, occ: 94, mrr: 88200, lastSync: "6 min ago" },
  { name: "Downtown Self Storage",units: 480, rented: 422, occ: 88, mrr: 71400, lastSync: "6 min ago" },
  { name: "Riverside Storage",    units: 350, rented: 266, occ: 76, mrr: 39800, lastSync: "6 min ago" },
  { name: "Lakeline Storage",     units: 528, rented: 480, occ: 91, mrr: 66100, lastSync: "6 min ago" },
  { name: "Summit Storage",       units: 290, rented: 200, occ: 69, mrr: 27500, lastSync: "6 min ago" },
];

const REVIEWS = [
  { author: "Marcus T.",  facility: "Harbor View Storage",  rating: 5, src: "Google", text: "Acme Storage did an outstanding job - spotless units and the climate control is the real deal.", replied: true  },
  { author: "Dana R.",    facility: "Downtown Self Storage", rating: 4, src: "Google", text: "Easy move-in, friendly staff. Gate hours could be a little longer.", replied: false },
  { author: "Priya S.",   facility: "Lakeline Storage",     rating: 5, src: "Meta",   text: "The craftsmanship of these facilities is a step above. Their project management is stellar.", replied: false },
  { author: "Will C.",    facility: "Summit Storage",       rating: 3, src: "Google", text: "Decent price but the access road needs repaving.", replied: false },
];

const STAFF = [
  { name: "R. Okafor",  role: "Site Manager",   facility: "Harbor View Storage",  hrs: 40 },
  { name: "M. Lind",    role: "Asst. Manager",  facility: "Downtown Self Storage", hrs: 32 },
  { name: "S. Patel",   role: "Site Associate", facility: "Lakeline Storage",      hrs: 24 },
  { name: "T. Nguyen",  role: "Site Manager",   facility: "Summit Storage",        hrs: 40 },
];

const pill = (cls, text) => <span className={`status-badge ${cls}`}>{text}</span>;

// Portfolio-wide average review score, shown on the Reputation summary card.
const AVG_RATING = 4.3;

// Five stars with a fractional-filled last star (e.g. 4.3 -> four full stars
// and a ~30%-filled fifth). An amber layer is clipped to value/5 over a grey
// base row, so a partial rating never rounds up to a full star.
function StarRow({ value, size = 15 }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span style={{ position: "relative", display: "inline-block", fontSize: size, letterSpacing: 1, lineHeight: 1 }} aria-hidden="true">
      <span style={{ color: "var(--line)" }}>★★★★★</span>
      <span style={{ position: "absolute", inset: 0, overflow: "hidden", width: pct + "%", color: "var(--amber)", whiteSpace: "nowrap" }}>★★★★★</span>
    </span>
  );
}

function FMS() {
  const totalUnits  = FACILITIES.reduce((a, f) => a + f.units, 0);
  const totalRented = FACILITIES.reduce((a, f) => a + f.rented, 0);
  const avgOcc      = Math.round(FACILITIES.reduce((a, f) => a + f.occ, 0) / FACILITIES.length);
  const totalMrr    = FACILITIES.reduce((a, f) => a + f.mrr, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>FMS Integration</h2>
          <p>Facility management system connector</p>
        </div>
      </div>

      <div className="banner-warn">
        <Server size={16} />
        <div>Currently connected to <strong>Hummingbird</strong>. Migration to <strong>Cubby</strong> is planned - this view switches over automatically once cutover completes.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {[
          { title: "Connection", rows: [["System","Hummingbird"],["Last sync","6 min ago"],["Interval","Every 15 min"],["Status","● Healthy"]] },
          { title: "Portfolio Totals", rows: [["Units", totalUnits.toLocaleString()],["Rented",totalRented.toLocaleString()],["Occupancy",avgOcc+"%"],["MRR","$"+(totalMrr/1000).toFixed(1)+"k"]] },
          { title: "Sync Log", log: ["✓ Occupancy pulled - 5 facilities","✓ Tenant ledger reconciled","✓ 12 move-ins, 4 move-outs","✓ Rate changes applied"] },
        ].map(c => (
          <div key={c.title} className="dash-card">
            <div className="dash-card-title" style={{ marginBottom: 12 }}>{c.title}</div>
            {c.rows && c.rows.map(([l, v]) => (
              <div key={l} className="stat-row">
                <span className="stat-label">{l}</span>
                <span className={`stat-value${v.startsWith("●") ? " stat-ok" : ""}`}>{v}</span>
              </div>
            ))}
            {c.log && <div className="log-list">{c.log.map((l, i) => <div key={i}>{l}</div>)}</div>}
          </div>
        ))}
      </div>

      <div className="dash-card">
        <div className="dash-card-title" style={{ marginBottom: 12 }}>Per-Facility Feed</div>
        <div style={{ overflowX: "auto" }}>
          <table className="req-table stack-table">
            <thead><tr><th>Facility</th><th>Units</th><th>Rented</th><th>Occupancy</th><th>MRR</th><th>Last sync</th></tr></thead>
            <tbody>
              {FACILITIES.map(f => (
                <tr key={f.name}>
                  <td style={{ fontWeight: 600 }}>{f.name}</td>
                  <td data-th="Units" className="mono">{f.units}</td>
                  <td data-th="Rented" className="mono">{f.rented}</td>
                  <td data-th="Occupancy">{pill(f.occ >= 90 ? "status-approved" : f.occ >= 78 ? "status-pending" : "status-rejected", f.occ + "%")}</td>
                  <td data-th="MRR" className="mono">${(f.mrr / 1000).toFixed(1)}k</td>
                  <td data-th="Last sync" style={{ color: "var(--muted)" }}>{f.lastSync}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Reputation() {
  const [reviews, setReviews] = useState(REVIEWS);
  const [replyText, setReplyText] = useState({});

  function submitReply(i) {
    if (!replyText[i]) return;
    setReviews(r => r.map((rev, idx) => idx === i ? { ...rev, replied: true } : rev));
  }

  const pending = reviews.filter(r => !r.replied).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Reputation Management</h2>
          <p>Reviews across storage facilities</p>
        </div>
      </div>
      <div className="kpi-grid">
        {[
          { label: "Average Rating", rating: AVG_RATING },
          { label: "Response Rate",  value: "68%" },
          { label: "Awaiting Reply", value: pending },
          { label: "This Month",     value: "18" },
        ].map(k => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            {k.rating != null ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="kpi-value">{k.rating.toFixed(1)}</span>
                <StarRow value={k.rating} />
              </div>
            ) : (
              <div className="kpi-value">{k.value}</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {reviews.map((r, i) => (
          <div key={i} className="dash-card">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div className="user-avatar" style={{ width: 32, height: 32, borderRadius: 8, fontSize: 12 }}>{r.author[0]}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{r.author}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.facility} · via {r.src}</div>
              </div>
              <div style={{ marginLeft: "auto", color: "var(--amber)", fontSize: 14, letterSpacing: 1 }}>
                {"★".repeat(r.rating)}<span style={{ color: "var(--line)" }}>{"★".repeat(5 - r.rating)}</span>
              </div>
            </div>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink)" }}>{r.text}</p>
            <div style={{ marginTop: 12 }}>
              {r.replied
                ? <span style={{ color: "var(--ok-fg)", fontSize: 12, fontWeight: 600 }}>✓ Replied</span>
                : <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <input className="form-input" style={{ flex: 1 }} placeholder="Write a reply…" value={replyText[i] || ""} onChange={e => setReplyText(p => ({ ...p, [i]: e.target.value }))} />
                    <button className="primary-btn" onClick={() => submitReply(i)}>Reply</button>
                  </div>
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SiteStaff() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Site Staff & Scheduling</h2>
          <p>Roster and shift coverage by facility</p>
        </div>
        <button className="primary-btn">+ Add Shift</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div className="dash-card">
          <div className="dash-card-title" style={{ marginBottom: 12 }}>Roster</div>
          <table className="req-table stack-table">
            <thead><tr><th>Name</th><th>Role</th><th>Facility</th><th>Hrs/wk</th></tr></thead>
            <tbody>
              {STAFF.map(s => (
                <tr key={s.name}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td data-th="Role">{s.role}</td>
                  <td data-th="Facility" style={{ color: "var(--muted)" }}>{s.facility}</td>
                  <td data-th="Hrs/wk" className="mono">{s.hrs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dash-card">
          <div className="dash-card-title" style={{ marginBottom: 12 }}>Open Shifts</div>
          <div className="task-list">
            <div className="task-row">
              <span className="prio-dot prio-high" />
              <div className="task-content">
                <div className="task-title">Summit Storage - Sat AM</div>
                <div className="task-dept">No coverage</div>
              </div>
              <span className="task-due today">Open</span>
            </div>
            <div className="task-row">
              <span className="prio-dot prio-med" />
              <div className="task-content">
                <div className="task-title">Riverside - Sun</div>
                <div className="task-dept">Awaiting confirm</div>
              </div>
              <span className="task-due">Pending</span>
            </div>
          </div>
        </div>
      </div>
      <div className="dash-card">
        <div className="dash-card-title" style={{ marginBottom: 14 }}>Week of May 25 - Harbor View Storage</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 8 }}>
          {days.map((d, i) => (
            <div key={d}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", marginBottom: 7, textAlign: "center" }}>{d}</div>
              {i < 6 && <div style={{ background: "var(--mist)", borderRadius: 8, padding: "7px 4px", fontSize: 11, fontWeight: 600, textAlign: "center", marginBottom: 6, lineHeight: 1.4 }}>R. Okafor<br /><span style={{ fontFamily: "JetBrains Mono", color: "var(--muted)", fontWeight: 400 }}>8–4</span></div>}
              {i < 5 && <div style={{ background: "var(--ok-bg)", color: "var(--ok-fg)", borderRadius: 8, padding: "7px 4px", fontSize: 11, fontWeight: 600, textAlign: "center", lineHeight: 1.4 }}>M. Lind<br /><span style={{ fontFamily: "JetBrains Mono", fontWeight: 400 }}>10–6</span></div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function FacilityOperations({ activeSub = "fms", onSubChange }) {
  const sub = activeSub || "fms";
  return (
    <div style={{ animation: "fadeIn var(--transition-normal) ease-in-out" }}>
      {/* Desktop: tabs render centered in the top header; phones keep the
          in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />
      {sub === "fms"        && <FMS />}
      {sub === "reputation" && <Reputation />}
      {sub === "site-staff" && <SiteStaff />}
    </div>
  );
}
