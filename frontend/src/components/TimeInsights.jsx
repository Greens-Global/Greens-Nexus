import { useState, useEffect, useMemo } from 'react';
import { Monitor, Globe, Activity, Clock, Zap, Loader2, TrendingUp, ChevronDown } from 'lucide-react';
import { api } from '../api';

// Entrance motion via CSS keyframes (plays on mount — no JS state flip, so it can
// never leave the dashboard invisible). Injected once.
if (typeof document !== 'undefined' && !document.getElementById('ti-anim')) {
  const s = document.createElement('style');
  s.id = 'ti-anim';
  // Transform-only + forwards fill: content is ALWAYS visible (never held at an
  // invisible "from" state if the tab backgrounds/pauses the animation); it just
  // slides / grows in when the animation runs in a foreground tab.
  s.textContent = `
    @keyframes tiFade { from { transform: translateY(9px); } to { transform: none; } }
    @keyframes tiGrow { from { transform: scaleX(0.02); } to { transform: scaleX(1); } }
    .ti-fade { animation: tiFade .5s cubic-bezier(.22,1,.36,1) forwards; }
    .ti-grow { transform-origin: left; animation: tiGrow .7s cubic-bezier(.22,1,.36,1) forwards; }`;
  document.head.appendChild(s);
}

// ── Insights dashboard — Top Apps / Top Websites / productivity / activity log ─
// Powered by the Nexus desktop agent's foreground-app + URL + activity samples
// (api.timeInsights). Cleaner and more animated than the reference tools: bars
// grow in on load, cards fade up, everything is on the Nexus theme.

const RATE = {
  productive:   { c: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)',  label: 'Productive' },
  neutral:      { c: 'var(--muted)',             bg: 'var(--mist)',                    label: 'Neutral' },
  unproductive: { c: '#b91c1c',                  bg: 'rgba(185,28,28,0.10)',           label: 'Unproductive' },
};
const rateOf = (r) => RATE[r] || RATE.neutral;

const fmtDur = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
};
const localTime = (iso) => { try { return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };

// A single animated bar row (grows to its share on mount, via CSS keyframe).
function BarRow({ name, seconds, max, rating, sub }) {
  const pct = max ? Math.max(2, (seconds / max) * 100) : 0;
  const R = rateOf(rating);
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}{sub && <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {sub}</span>}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtDur(seconds)}</span>
      </div>
      <div style={{ height: 9, borderRadius: 6, background: 'var(--mist)', overflow: 'hidden' }}>
        <div className="ti-grow" style={{ width: `${pct}%`, height: '100%', borderRadius: 6, background: R.c, opacity: 0.9 }} />
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, accent, delay }) {
  return (
    <div className="ti-fade" style={{ flex: '1 1 160px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px',
      animationDelay: `${delay}s` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
          background: `${accent}1a`, color: accent }}><Icon size={14} /></span>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
    </div>
  );
}

export default function TimeInsights({ start, end, people = [] }) {
  const [email, setEmail] = useState('');           // '' = whole team
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setData(null); setErr('');
    let live = true;
    api.timeInsights(email, start, end)
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setErr(e?.message || 'Could not load insights'); });
    return () => { live = false; };
  }, [email, start, end]);

  const maxApp = useMemo(() => Math.max(1, ...(data?.topApps || []).map(a => a.seconds)), [data]);
  const maxSite = useMemo(() => Math.max(1, ...(data?.topSites || []).map(a => a.seconds)), [data]);
  const cats = data?.byCategory || { productive: 0, neutral: 0, unproductive: 0 };
  const catTotal = Math.max(1, cats.productive + cats.neutral + cats.unproductive);
  const prodPct = data?.totalSec ? Math.round(cats.productive * 100 / catTotal) : 0;

  const CARD = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '18px 20px' };
  const H = { fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 7 };

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {/* Member selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <select value={email} onChange={e => setEmail(e.target.value)} className="form-input"
            style={{ appearance: 'none', paddingRight: 30, fontSize: 13, fontWeight: 600, minWidth: 190 }}>
            <option value="">Whole team</option>
            {people.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
          </select>
          <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Activity captured by the Nexus desktop agent while clocked in.</span>
      </div>

      {err ? (
        <div style={{ ...CARD, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{err}</div>
      ) : data === null ? (
        <div style={{ padding: 60, textAlign: 'center' }}><Loader2 size={22} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div>
      ) : data.totalSec === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: '48px 24px' }}>
          <Monitor size={30} style={{ color: 'var(--muted)', opacity: 0.4, marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>No activity yet</div>
          <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 380, margin: '0 auto', lineHeight: 1.55 }}>
            App, website and activity data appears here once the Nexus desktop agent is deployed to this person's computer and they're clocked in.
          </p>
        </div>
      ) : (<>
        {/* KPI cards */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <KpiCard icon={Clock} label="Tracked" value={fmtDur(data.totalSec)} accent="hsl(var(--color-blue))" delay={0} />
          <KpiCard icon={Zap} label="Active" value={fmtDur(data.activeSec)} accent="var(--pine)" delay={0.05} />
          <KpiCard icon={Activity} label="Active rate" value={`${data.activePct}%`} accent="#b45309" delay={0.1} />
          <KpiCard icon={TrendingUp} label="Productive" value={`${prodPct}%`} accent="hsl(var(--color-green))" delay={0.15} />
        </div>

        {/* Productivity composition bar */}
        <div style={{ ...CARD, marginBottom: 14 }}>
          <div style={H}><TrendingUp size={13} /> How the time breaks down</div>
          <div style={{ display: 'flex', height: 22, borderRadius: 8, overflow: 'hidden', background: 'var(--mist)' }}>
            {['productive', 'neutral', 'unproductive'].map(k => {
              const w = (cats[k] / catTotal) * 100;
              return w > 0 ? <div key={k} className="ti-grow" title={`${rateOf(k).label}: ${fmtDur(cats[k])}`}
                style={{ width: `${w}%`, background: rateOf(k).c, opacity: k === 'neutral' ? 0.5 : 0.92 }} /> : null;
            })}
          </div>
          <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
            {['productive', 'neutral', 'unproductive'].map(k => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: rateOf(k).c, opacity: k === 'neutral' ? 0.5 : 1 }} />
                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{rateOf(k).label}</span>
                <span style={{ fontWeight: 800 }}>{fmtDur(cats[k])}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Top Apps + Top Websites */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginBottom: 14 }}>
          <div style={CARD}>
            <div style={H}><Monitor size={13} /> Top apps</div>
            {data.topApps.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No app data.</div>
              : data.topApps.map(a => <BarRow key={a.name} name={a.name} seconds={a.seconds} max={maxApp} rating={a.rating} />)}
          </div>
          <div style={CARD}>
            <div style={H}><Globe size={13} /> Top websites</div>
            {data.topSites.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No website data.</div>
              : data.topSites.map(a => <BarRow key={a.name} name={a.name} seconds={a.seconds} max={maxSite} rating={a.rating} />)}
          </div>
        </div>

        {/* Activity log */}
        <div style={CARD}>
          <div style={H}><Activity size={13} /> Activity log</div>
          <div style={{ maxHeight: 320, overflowY: 'auto', margin: '0 -6px' }}>
            {data.log.map((l, i) => {
              const R = rateOf(l.category);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 6px', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                  <span style={{ color: 'var(--muted)', width: 46, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{localTime(l.at)}</span>
                  {!email && <span style={{ fontWeight: 700, color: 'var(--ink)', width: 120, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>}
                  <span style={{ fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>{l.app}</span>
                  <span style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.title}>
                    {l.domain || l.title}
                  </span>
                  <span style={{ color: R.c, fontWeight: 700, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtDur(l.seconds)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </>)}
    </div>
  );
}
