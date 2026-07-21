import { useState, useEffect, useMemo } from 'react';
import { Monitor, Globe, Activity, Clock, Zap, Loader2, TrendingUp, ChevronDown, Coffee, Users, Trophy } from 'lucide-react';
import { api } from '../api';

// ── Time Insights — workforce activity analytics ──────────────────────────────
// Powered by the desktop agent's foreground-app + URL + activity samples
// (api.timeInsights). Designed to read at a glance: a productivity ring, an
// hourly activity strip, top apps/sites rated productive/neutral/unproductive, a
// team leaderboard, and a live activity log. All on the Nexus theme, animated
// with CSS keyframes (transform/animation only + forwards fill, so nothing is
// ever left invisible if a tab backgrounds).

if (typeof document !== 'undefined' && !document.getElementById('ti-anim')) {
  const s = document.createElement('style');
  s.id = 'ti-anim';
  s.textContent = `
    @keyframes tiFade { from { opacity: .15; transform: translateY(9px); } to { opacity: 1; transform: none; } }
    @keyframes tiGrow { from { transform: scaleX(.02); } to { transform: scaleX(1); } }
    @keyframes tiRise { from { transform: scaleY(.04); } to { transform: scaleY(1); } }
    @keyframes tiRing { from { stroke-dashoffset: var(--ring-c); } }
    @keyframes tiShim { from { background-position: -400px 0; } to { background-position: 400px 0; } }
    .ti-fade { animation: tiFade .5s cubic-bezier(.22,1,.36,1) forwards; }
    .ti-grow { transform-origin: left;   animation: tiGrow .7s cubic-bezier(.22,1,.36,1) forwards; }
    .ti-rise { transform-origin: bottom; animation: tiRise .6s cubic-bezier(.22,1,.36,1) forwards; }
    .ti-ring { animation: tiRing 1.1s cubic-bezier(.22,1,.36,1) forwards; }
    .ti-row  { transition: background .12s ease; border-radius: 8px; }
    .ti-row:hover { background: var(--mist); }`;
  document.head.appendChild(s);
}

const RATE = {
  productive:   { c: 'hsl(var(--color-green))', label: 'Productive' },
  neutral:      { c: 'hsl(var(--color-blue))',  label: 'Neutral' },
  unproductive: { c: '#dc2626',                 label: 'Unproductive' },
};
const rateOf = (r) => RATE[r] || RATE.neutral;

const fmtDur = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
};
const initials = (s) => (s || '?').replace(/^www\./, '').slice(0, 2).toUpperCase();
const hueOf = (s) => { let h = 0; for (const ch of (s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const localTime = (iso) => { try { return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };

const CARD = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: '18px 20px' };
const H = { fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 7 };

// ── Productivity ring ─────────────────────────────────────────────────────────
function Ring({ pct, size = 118, stroke = 12, color }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--mist)" strokeWidth={stroke} />
        <circle className="ti-ring" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} style={{ '--ring-c': c }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 27, fontWeight: 800, color: 'var(--ink)', lineHeight: 1 }}>{pct}%</span>
        <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 3 }}>Productive</span>
      </div>
    </div>
  );
}

function StatBlock({ icon: Icon, label, value, accent, bar }) {
  return (
    <div style={{ flex: '1 1 130px', minWidth: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon size={13} style={{ color: accent }} />
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 21, fontWeight: 800, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
      {bar != null && (
        <div style={{ height: 5, borderRadius: 3, background: 'var(--mist)', overflow: 'hidden', marginTop: 8 }}>
          <div className="ti-grow" style={{ width: `${bar}%`, height: '100%', background: accent, borderRadius: 3 }} />
        </div>
      )}
    </div>
  );
}

// ── Hourly activity strip (active vs idle across the day) ─────────────────────
function HourStrip({ hourly }) {
  const withData = hourly.filter(h => h.totalSec > 0);
  if (!withData.length) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>No activity recorded yet.</div>;
  const lo = Math.max(0, Math.min(...withData.map(h => h.hour)) - 1);
  const hi = Math.min(23, Math.max(...withData.map(h => h.hour)) + 1);
  const span = hourly.slice(lo, hi + 1);
  const max = Math.max(1, ...span.map(h => h.totalSec));
  const label = (h) => { const ap = h < 12 ? 'a' : 'p'; const hr = h % 12 || 12; return `${hr}${ap}`; };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 96 }}>
        {span.map(h => {
          const th = Math.max(h.totalSec ? 3 : 1, (h.totalSec / max) * 92);
          const aPct = h.totalSec ? (h.activeSec / h.totalSec) * 100 : 0;
          return (
            <div key={h.hour} title={`${label(h.hour)} — active ${fmtDur(h.activeSec)} of ${fmtDur(h.totalSec)}`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: 0, height: '100%' }}>
              <div className="ti-rise" style={{ height: th, borderRadius: '4px 4px 2px 2px', overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse', background: 'var(--mist)' }}>
                <div style={{ height: `${aPct}%`, background: 'var(--pine)' }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
        {span.map((h, i) => (
          <span key={h.hour} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: 'var(--muted)', minWidth: 0 }}>
            {(span.length <= 12 || i % 2 === 0) ? label(h.hour) : ''}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 11 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--pine)' }} /><span style={{ color: 'var(--muted)', fontWeight: 600 }}>Active</span></span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--mist)' }} /><span style={{ color: 'var(--muted)', fontWeight: 600 }}>Idle / tracked</span></span>
      </div>
    </div>
  );
}

// ── App / website row ─────────────────────────────────────────────────────────
function ItemRow({ name, seconds, pct, max, rating, isSite }) {
  const R = rateOf(rating);
  const w = max ? Math.max(2, (seconds / max) * 100) : 0;
  const disp = isSite ? name.replace(/^www\./, '') : name;
  return (
    <div className="ti-row" style={{ padding: '7px 8px', margin: '0 -8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
        <span style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9.5, fontWeight: 800, color: '#fff', background: `hsl(${hueOf(disp)} 55% 52%)` }}>{initials(disp)}</span>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{disp}</span>
        {rating && (
          <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.03em', color: R.c,
            background: `${R.c}18`, padding: '2px 6px', borderRadius: 5, flexShrink: 0 }}>{R.label[0]}</span>
        )}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', minWidth: 52, textAlign: 'right' }}>{fmtDur(seconds)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 32 }}>
        <div style={{ flex: 1, height: 7, borderRadius: 5, background: 'var(--mist)', overflow: 'hidden' }}>
          <div className="ti-grow" style={{ width: `${w}%`, height: '100%', background: R.c, borderRadius: 5, opacity: 0.9 }} />
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
      </div>
    </div>
  );
}

export default function TimeInsights({ start, end, people = [] }) {
  const [email, setEmail] = useState('');
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
  const maxMember = useMemo(() => Math.max(1, ...(data?.byMember || []).map(m => m.totalSec)), [data]);
  const cats = data?.byCategory || { productive: 0, neutral: 0, unproductive: 0 };
  const catTotal = Math.max(1, cats.productive + cats.neutral + cats.unproductive);
  const isTeam = !email;

  const selector = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative' }}>
        <select value={email} onChange={e => setEmail(e.target.value)} className="form-input"
          style={{ appearance: 'none', paddingRight: 32, fontSize: 13, fontWeight: 700, minWidth: 200 }}>
          <option value="">👥 Whole team</option>
          {people.map(p => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
        </select>
        <ChevronDown size={14} style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Captured by the Nexus desktop agent while clocked in.</span>
    </div>
  );

  if (err) return <div>{selector}<div style={{ ...CARD, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{err}</div></div>;
  if (data === null) return <div>{selector}<div style={{ padding: 70, textAlign: 'center' }}><Loader2 size={22} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div></div>;
  if (data.totalSec === 0) return (
    <div>{selector}
      <div style={{ ...CARD, textAlign: 'center', padding: '52px 24px' }}>
        <Monitor size={32} style={{ color: 'var(--muted)', opacity: 0.4, marginBottom: 12 }} />
        <div style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>No activity yet</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 400, margin: '0 auto', lineHeight: 1.55 }}>
          App, website and activity insights appear here once the Nexus desktop agent is deployed to {isTeam ? "the team's computers" : "this person's computer"} and they're clocked in.
        </p>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {selector}

      {/* Hero — productivity ring + summary stats */}
      <div className="ti-fade" style={{ ...CARD, display: 'flex', gap: 26, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <Ring pct={data.prodPct} color="hsl(var(--color-green))" />
        <div style={{ flex: 1, display: 'flex', gap: 22, flexWrap: 'wrap', minWidth: 260 }}>
          <StatBlock icon={Clock} label="Tracked" value={fmtDur(data.totalSec)} accent="hsl(var(--color-blue))" />
          <StatBlock icon={Zap} label="Active" value={fmtDur(data.activeSec)} accent="var(--pine)" bar={data.activePct} />
          <StatBlock icon={Coffee} label="Idle" value={fmtDur(data.idleSec)} accent="#b45309" bar={data.totalSec ? Math.round(data.idleSec * 100 / data.totalSec) : 0} />
          <StatBlock icon={Activity} label="Active rate" value={`${data.activePct}%`} accent="hsl(var(--color-purple))" />
        </div>
      </div>

      {/* Hourly activity strip */}
      <div className="ti-fade" style={{ ...CARD, marginBottom: 14, animationDelay: '.04s' }}>
        <div style={H}><Activity size={13} /> Activity through the day</div>
        <HourStrip hourly={data.hourly || []} />
      </div>

      {/* Productivity composition */}
      <div className="ti-fade" style={{ ...CARD, marginBottom: 14, animationDelay: '.08s' }}>
        <div style={H}><TrendingUp size={13} /> How the time breaks down</div>
        <div style={{ display: 'flex', height: 22, borderRadius: 8, overflow: 'hidden', background: 'var(--mist)' }}>
          {['productive', 'neutral', 'unproductive'].map(k => {
            const w = (cats[k] / catTotal) * 100;
            return w > 0 ? <div key={k} className="ti-grow" title={`${rateOf(k).label}: ${fmtDur(cats[k])}`}
              style={{ width: `${w}%`, background: rateOf(k).c, opacity: 0.92 }} /> : null;
          })}
        </div>
        <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
          {['productive', 'neutral', 'unproductive'].map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: rateOf(k).c }} />
              <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{rateOf(k).label}</span>
              <span style={{ fontWeight: 800 }}>{fmtDur(cats[k])}</span>
              <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {Math.round(cats[k] * 100 / catTotal)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Top apps + top websites */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 14, marginBottom: 14 }}>
        <div className="ti-fade" style={{ ...CARD, animationDelay: '.1s' }}>
          <div style={H}><Monitor size={13} /> Top apps</div>
          {data.topApps.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No app data.</div>
            : data.topApps.map(a => <ItemRow key={a.name} name={a.name} seconds={a.seconds} pct={a.pct} max={maxApp} rating={a.rating} />)}
        </div>
        <div className="ti-fade" style={{ ...CARD, animationDelay: '.14s' }}>
          <div style={H}><Globe size={13} /> Top websites</div>
          {data.topSites.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No website data.</div>
            : data.topSites.map(a => <ItemRow key={a.name} name={a.name} seconds={a.seconds} pct={a.pct} max={maxSite} rating={a.rating} isSite />)}
        </div>
      </div>

      {/* Team leaderboard (team view only) */}
      {isTeam && (data.byMember || []).length > 0 && (
        <div className="ti-fade" style={{ ...CARD, marginBottom: 14 }}>
          <div style={H}><Trophy size={13} /> Team leaderboard</div>
          {data.byMember.map((m, i) => (
            <div key={m.email} className="ti-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px', margin: '0 -8px' }}>
              <span style={{ width: 20, textAlign: 'center', fontSize: 12, fontWeight: 800, color: i < 3 ? 'hsl(var(--color-gold))' : 'var(--muted)' }}>{i + 1}</span>
              <span style={{ width: 26, height: 26, flexShrink: 0, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#fff', background: `hsl(${hueOf(m.name)} 55% 50%)` }}>{initials(m.name)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                  <span style={{ fontWeight: 800, color: 'var(--pine)', flexShrink: 0 }}>{fmtDur(m.totalSec)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 4, background: 'var(--mist)', overflow: 'hidden' }}>
                    <div className="ti-grow" style={{ width: `${(m.totalSec / maxMember) * 100}%`, height: '100%', background: 'var(--pine)', borderRadius: 4 }} />
                  </div>
                  <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, flexShrink: 0 }}>{m.activePct}% active · {m.prodPct}% prod.</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Activity log */}
      <div className="ti-fade" style={CARD}>
        <div style={H}><Users size={13} /> Activity log</div>
        <div style={{ maxHeight: 340, overflowY: 'auto', margin: '0 -6px' }}>
          {data.log.map((l, i) => {
            const R = rateOf(l.category);
            return (
              <div key={i} className="ti-row" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 6px', fontSize: 12 }}>
                <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: R.c, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)', width: 44, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{localTime(l.at)}</span>
                {isTeam && <span style={{ fontWeight: 700, color: 'var(--ink)', width: 110, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>}
                <span style={{ fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>{l.app}</span>
                <span style={{ color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.title}>{l.domain || l.title}</span>
                <span style={{ color: R.c, fontWeight: 700, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtDur(l.seconds)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
