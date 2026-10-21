// Operations > Overview: what Nexus knows about a store another operator runs
// (CubeSmart, Oct 20 2026). Its KPIs above already come from the operator's
// reports; this card says how old they are ("Data as of MM/DD/YYYY", flagged
// when stale), shows the Daily Flash revenue / occupancy / net rentals tables
// and the SRE months, and is where ops uploads the next report.
import { useState } from 'react';
import { Upload } from 'lucide-react';
import { money, count, monthLabel } from './model';
import { dataAsOf, isStale, managedLabel } from './thirdParty';
import ThirdPartyUpload from './ThirdPartyUpload';

const dash = (v, fmt) => (v === null || v === undefined ? '-' : fmt(v));
const pctText = (v) => `${Number(v).toFixed(1)}%`;

function AsOf({ f }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>{dataAsOf(f)}</span>
      {isStale(f) && <span className="status-badge pill-warn" title="No Daily Flash in the last two days. Upload the latest report.">Stale</span>}
    </span>
  );
}

function Flash({ flash }) {
  if (!flash) return <div className="ops-empty">No Daily Flash uploaded yet.</div>;
  const mv = flash.moves || {};
  return (
    <div className="ops-grid-2">
      <div className="req-table-wrapper">
        <table className="req-table stack-table">
          <thead><tr><th>Revenue</th><th className="num">MTD</th><th className="num">Budget</th><th className="num">Variance</th><th className="num">Prior Year</th></tr></thead>
          <tbody>
            {flash.revenue.filter((r) => r.mtd !== null || r.budget !== null).map((r) => (
              <tr key={r.key}>
                <td data-th="Revenue">{r.label}</td>
                <td data-th="MTD" className="num">{dash(r.mtd, money)}</td>
                <td data-th="Budget" className="num">{dash(r.budget, money)}</td>
                <td data-th="Variance" className="num">{r.mtd !== null && r.budget !== null ? money(r.mtd - r.budget) : '-'}</td>
                <td data-th="Prior Year" className="num">{dash(r.py, money)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="req-table-wrapper">
          <table className="req-table stack-table">
            <thead><tr><th>Occupancy by Status</th><th className="num">Cubes</th><th className="num">Sq Ft</th></tr></thead>
            <tbody>
              {flash.occupancy.filter((r) => r.cubes !== null || r.sqft !== null).map((r) => (
                <tr key={r.key}>
                  <td data-th="Status">{r.label}</td>
                  <td data-th="Cubes" className="num">{dash(r.cubes, count)}</td>
                  <td data-th="Sq Ft" className="num">{dash(r.sqft, count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="req-table-wrapper" style={{ marginTop: 12 }}>
          <table className="req-table stack-table">
            <thead><tr><th>Net Rentals</th><th className="num">Daily</th><th className="num">MTD</th><th className="num">MTD Budget</th><th className="num">MTD Prior Year</th></tr></thead>
            <tbody>
              {[['Move-Ins', 'move_ins'], ['Move-Outs', 'move_outs']].map(([label, k]) => (
                <tr key={k}>
                  <td data-th="Net Rentals">{label}</td>
                  <td data-th="Daily" className="num">{dash(mv[`${k}_day`], count)}</td>
                  <td data-th="MTD" className="num">{dash(mv[`${k}_mtd`], count)}</td>
                  <td data-th="MTD Budget" className="num">{dash(mv[`${k}_mtd_budget`], count)}</td>
                  <td data-th="MTD Prior Year" className="num">{dash(mv[`${k}_mtd_py`], count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Sre({ months }) {
  if (!months?.length) return <div className="ops-empty">No SRE Summary uploaded yet.</div>;
  return (
    <div className="req-table-wrapper">
      <table className="req-table stack-table">
        <thead>
          <tr>
            <th>Month</th><th className="num">Cubes Available</th><th className="num">Rented</th><th className="num">Vacated</th>
            <th className="num">Net Rentals</th><th className="num">Occupied EOM</th><th className="num">% Rented (Cube)</th>
            <th className="num">% Rented (Sq Ft)</th><th className="num">Rental Revenue</th><th className="num">Promotions</th>
            <th className="num">Promo Move-Ins</th><th className="num">Total AR</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <td data-th="Month">{monthLabel(m.month)}</td>
              <td data-th="Cubes Available" className="num">{dash(m.totalCubesAvail, count)}</td>
              <td data-th="Rented" className="num">{dash(m.rented, count)}</td>
              <td data-th="Vacated" className="num">{dash(m.vacated, count)}</td>
              <td data-th="Net Rentals" className="num">{dash(m.netRentals, (v) => `${v > 0 ? '+' : ''}${v}`)}</td>
              <td data-th="Occupied EOM" className="num">{dash(m.occupiedEom, count)}</td>
              <td data-th="% Rented (Cube)" className="num">{dash(m.pctRentedCube, pctText)}</td>
              <td data-th="% Rented (Sq Ft)" className="num">{dash(m.pctRentedSqft, pctText)}</td>
              <td data-th="Rental Revenue" className="num">{dash(m.rentalRevenue, money)}</td>
              <td data-th="Promotions" className="num">{dash(m.promoDiscounts, money)}</td>
              <td data-th="Promo Move-Ins" className="num">{dash(m.promoMoveIns, count)}</td>
              <td data-th="Total AR" className="num">{dash(m.arTotal, money)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// `facilities`: the third-party stores in the current scope. One store gets
// the full card; several (All Facilities) get one line each.
export default function ThirdPartyPanel({ facilities = [], canUpload = false, onSaved }) {
  const [open, setOpen] = useState(false);
  if (!facilities.length) return null;
  const one = facilities.length === 1 ? facilities[0] : null;
  const props = facilities.map((f) => ({ id: f.thirdParty.propertyId, shortName: f.shortName, managedLabel: managedLabel(f) }));
  const uploadBtn = canUpload && (
    <button type="button" className="secondary-btn" onClick={() => setOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Upload size={14} aria-hidden="true" /> Upload Report
    </button>
  );
  return (
    <div className="dash-card" data-testid="tp-panel">
      <div className="dash-card-head">
        <div>
          <div className="dash-card-title">{one ? `${one.shortName} - ${managedLabel(one)}` : 'TPM Stores'}</div>
          <div className="dash-card-sub">
            {one
              ? <AsOf f={one} />
              : 'Figures from each operator\'s own reports, uploaded to Nexus. Tenants, payments, leads and tasks stay in the operator\'s system.'}
          </div>
        </div>
        {uploadBtn}
      </div>
      {one ? (
        <>
          <p className="ops-note" style={{ margin: '0 0 12px' }}>
            Occupancy, move-ins and revenue come from {one.thirdParty.sourceLabel}'s Daily Flash and SRE Summary. Tenants,
            payments, leads and tasks stay in {one.thirdParty.sourceLabel}'s system, so those lists are empty for this store.
          </p>
          <Flash flash={one.thirdParty.flash} />
          <div className="dash-card-title" style={{ margin: '18px 0 8px' }}>SRE Summary</div>
          <Sre months={one.thirdParty.sre} />
        </>
      ) : (
        <div className="ops-attn">
          {facilities.map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', flexWrap: 'wrap', fontSize: 13 }}>
              <span className="ops-attn-fac">{f.shortName}</span>
              <span className="status-badge pill-muted">{managedLabel(f)}</span>
              <AsOf f={f} />
            </div>
          ))}
        </div>
      )}
      {open && (
        <ThirdPartyUpload properties={props} defaultPropertyId={one ? one.thirdParty.propertyId : ''}
          onClose={() => setOpen(false)} onSaved={onSaved} />
      )}
    </div>
  );
}
