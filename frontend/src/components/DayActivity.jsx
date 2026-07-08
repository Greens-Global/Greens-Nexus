import { useState, useEffect } from 'react';
import { Monitor, ChevronDown, Loader2 } from 'lucide-react';
import { api } from '../api';

// Working vs idle breakdown + the desktop agent's app/window log for one day.
// Self view (no email prop) uses /timeclock/my-activity; manager/HR views pass
// an email and go through the team-scoped /timeclock/activity-day.
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const fmtSec = (s) => s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
const localTime = (iso) => { try { return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };

export default function DayActivity({ date, email }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    setData(null); setErr('');
    const p = email ? api.timeActivityDay(email, date) : api.timeMyActivity(date);
    p.then(setData).catch(e => setErr(e?.message || 'Could not load activity'));
  }, [date, email]);

  if (err) return <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '6px 0' }}>{err}</div>;
  if (!data) return <div style={{ padding: '8px 0' }}><Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div>;

  if (!data.hasAgentData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--muted)', padding: '6px 0' }}>
        <Monitor size={12} /> No desktop-agent activity for this day — {email ? "the agent isn't running on their machine" : "the agent isn't running on your machine"}.
      </div>
    );
  }

  const total = Math.max(1, data.workedMin);
  const activeW = Math.min(100, (data.activeMin / total) * 100);
  const idleW = Math.min(100 - activeW, (data.idleMin / total) * 100);
  const maxApp = Math.max(1, ...data.apps.map(a => a.seconds));

  return (
    <div style={{ width: '100%' }}>
      {/* Working vs idle bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          <Monitor size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Screen activity
        </span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}>Working {fmtMin(data.activeMin)}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#b45309' }}>Idle {fmtMin(data.idleMin)}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{data.activePct}% active of {fmtMin(data.workedMin)} punched in</span>
      </div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--mist)', marginBottom: 10 }}>
        <div style={{ width: `${activeW}%`, background: 'hsl(var(--color-green))' }} />
        <div style={{ width: `${idleW}%`, background: '#f59e0b' }} />
      </div>

      {/* Top apps */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '4px 18px', marginBottom: 8 }}>
        {data.apps.slice(0, 8).map(a => (
          <div key={a.app} title={(a.titles || []).map(t => `${t.title} · ${fmtSec(t.seconds)}`).join('\n')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.app}</span>
              <span style={{ color: 'var(--muted)', flexShrink: 0, marginLeft: 8 }}>{fmtSec(a.seconds)}</span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--mist)', overflow: 'hidden' }}>
              <div style={{ width: `${(a.seconds / maxApp) * 100}%`, height: '100%', background: 'hsla(var(--color-blue),0.55)', borderRadius: 3 }} />
            </div>
          </div>
        ))}
      </div>

      {/* Full window-title log */}
      <button onClick={() => setLogOpen(o => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', fontFamily: 'Inter,sans-serif', padding: 0 }}>
        <ChevronDown size={12} style={{ transform: logOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        {logOpen ? 'Hide' : 'Show'} activity log ({data.log.length})
      </button>
      {logOpen && (
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, marginTop: 6 }}>
          {data.log.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 10px', borderBottom: '1px solid var(--line)', fontSize: 11.5 }}>
              <span style={{ color: 'var(--muted)', width: 44, flexShrink: 0 }}>{localTime(l.at)}</span>
              <span style={{ fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>{l.app}</span>
              <span style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.title}>{l.title}</span>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{fmtSec(l.seconds)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
