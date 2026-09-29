import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { pollWhileVisible } from '../lib/pollWhileVisible';

// Disclosed-monitoring tamper / coverage alerts: people who are clocked in
// while their agent has gone quiet (killed, uninstalled, offline), so evasion
// is a visible, attributable event rather than a silent success.
//
// They used to sit at the top of People -> Time as a red block listing every
// person, which took half the screen away from the timecards (Charmi, Sep 25).
// They belong with the rest of monitoring: the full list lives here, on
// Workforce Analytics -> Coverage, folded to one line until it is opened. The
// Time screen keeps a single line that says how many there are and leads here.

export function useMonitoringAlerts() {
  const [alerts, setAlerts] = useState([]);
  useEffect(() => {
    let live = true;
    const load = () => api.timeMonitoringAlerts()
      .then((r) => { if (live) setAlerts(Array.isArray(r?.alerts) ? r.alerts : []); })
      .catch(() => {});
    load();
    const stop = pollWhileVisible(load, 60000);
    return () => { live = false; stop(); };
  }, []);
  return alerts;
}

const RED = 'hsl(var(--color-red))';
const AMBER = '#b45309';

// The full list, for Workforce Analytics. Nothing is drawn when all is well.
export function MonitoringAlertsPanel() {
  const alerts = useMonitoringAlerts();
  const [open, setOpen] = useState(false);
  if (!alerts.length) return null;
  const high = alerts.filter((a) => a.severity === 'high').length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div style={{ marginBottom: 14, border: '1px solid hsla(var(--color-red),0.4)', background: 'hsla(var(--color-red),0.06)', borderRadius: 12 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'var(--ink)' }}>
        <Chevron size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <AlertTriangle size={15} style={{ color: RED, flexShrink: 0 }} />
        <span style={{ fontWeight: 800, fontSize: 13.5 }}>Monitoring Alerts</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {alerts.length} clocked in with a quiet agent{high ? ` - ${high} not reporting at all` : ''}
        </span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 14px 12px 38px' }}>
          {alerts.map((a) => (
            <div key={a.email} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: a.severity === 'high' ? RED : AMBER }} />
              <strong>{a.name}</strong>
              <span style={{ fontWeight: 700, color: a.severity === 'high' ? RED : AMBER }}>{a.reason}</span>
              {a.detail && <span style={{ color: 'var(--muted)' }}>{a.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One line for the Time screen: how many, and the way to the list.
export function MonitoringAlertsLine({ canOpen = true }) {
  const alerts = useMonitoringAlerts();
  if (!alerts.length) return null;
  const go = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'employee-tracking', sub: 'coverage' } }));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5, color: 'var(--muted)' }}>
      <AlertTriangle size={14} style={{ color: RED, flexShrink: 0 }} />
      <span><strong style={{ color: 'var(--ink)' }}>{alerts.length} monitoring {alerts.length === 1 ? 'alert' : 'alerts'}</strong> - clocked in with a quiet agent</span>
      {canOpen && (
        <button type="button" onClick={go} style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--wk-brand)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          View in Workforce Analytics
        </button>
      )}
    </div>
  );
}
