// Maintenance Log filters (Pranshu, 10/06): by vendor, by work (system or what
// was done), by system, and by service date range. Applied to hand-logged and
// ticket records alike; the summary above the log follows the filter, with the
// spend kept per currency.

import { EMPTY_LOG_FILTER } from '../../lib/maintenanceLog.js';
import { DateField } from '../../../tasks/components.jsx';

const LABEL = { fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' };

export function MaintenanceLogFilters({ rows, value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const setDay = (k) => (v) => onChange({ ...value, [k]: v || '' });
  const vendors = [...new Set(rows.map((r) => r.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const systems = [...new Set(rows.map((r) => r.system).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const active = Object.values(value).some(Boolean);
  const box = { fontSize: 13, padding: '6px 9px', height: 32 };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginBottom: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 180px' }}>
        <span style={LABEL}>Work</span>
        <input className="form-input" placeholder="Search work performed…" value={value.work} onChange={set('work')} style={box} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '0 1 170px' }}>
        <span style={LABEL}>Vendor</span>
        <select className="form-input" value={value.vendor} onChange={set('vendor')} style={box}>
          <option value="">All Vendors</option>
          {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '0 1 160px' }}>
        <span style={LABEL}>System / Area</span>
        <select className="form-input" value={value.system} onChange={set('system')} style={box}>
          <option value="">All Systems</option>
          {systems.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <div role="group" aria-label="From date" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={LABEL}>From</span>
        <div className="form-input" style={{ ...box, display: 'flex', alignItems: 'center', width: 140 }}>
          <DateField value={value.from} onChange={setDay('from')} max={value.to || ''} title="From date" style={{ flex: 1 }} />
        </div>
      </div>
      <div role="group" aria-label="To date" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={LABEL}>To</span>
        <div className="form-input" style={{ ...box, display: 'flex', alignItems: 'center', width: 140 }}>
          <DateField value={value.to} onChange={setDay('to')} min={value.from || ''} title="To date" style={{ flex: 1 }} />
        </div>
      </div>
      {active && <button className="secondary-btn" onClick={() => onChange(EMPTY_LOG_FILTER)} style={{ height: 32 }}>Clear Filters</button>}
    </div>
  );
}
