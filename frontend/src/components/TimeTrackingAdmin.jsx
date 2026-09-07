import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, Loader2, Check, MonitorSmartphone, Copy, Ban, TriangleAlert, Trash2, Activity, ChevronDown, Video, X, Radio, MousePointer2, Eye, Wrench } from 'lucide-react';
import { api } from '../api';
import { Avatar } from '../tasks/components';
import ScreenshotsAdmin from './ScreenshotsAdmin';
import TimeInsights from './TimeInsights';
import LiveView from './LiveView';
import Locations from '../views/Locations';

// Human "last seen" from a seconds delta.
function relSeen(secs) {
  if (secs == null) return 'never';
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// Shared status light. `pulse` gives it a glowing, breathing ring in its own
// color (via currentColor in the nexusDotPulse keyframe); static otherwise.
function Dot({ color, pulse, dim, title }) {
  return (
    <span title={title} aria-label={title} style={{
      width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
      background: color, color, opacity: dim ? 0.5 : 1,
      animation: pulse ? 'nexusDotPulse 1.5s ease-out infinite' : 'none',
    }} />
  );
}

// Enrolled-PC light: live (online or capturing) => green glow; offline => gray.
function StatusDot({ online, capturing, secs }) {
  const title = capturing ? 'Capturing now'
    : online ? 'Online (not on shift)'
    : `Offline - last seen ${relSeen(secs)}`;
  return <Dot color={online ? 'hsl(var(--color-green))' : 'var(--muted)'} pulse={online} dim={!online} title={title} />;
}

// Shared-PC pairing health chip (Visesh, Aug 26). Surfaces whether the desktop
// agent is capturing the person actually clocked in on this machine (a working
// localhost pairing) or has silently fallen back to the enroll owner because the
// browser couldn't reach the local agent to bind - the case where a different
// person on a shared PC gets mis-attributed to the owner. Only the states worth
// an admin's eye render a chip; bound/idle/offline are already told by the dot.
function PairingChip({ d }) {
  const ps = d.pairingStatus;
  const chip = (bg, fg, text, title) => (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 5,
      fontSize: 10.5, fontWeight: 800, letterSpacing: '.02em', padding: '2px 9px', borderRadius: 20,
      background: bg, color: fg }}>{text}</span>
  );
  if (ps === 'owner_fallback')
    return chip('hsla(var(--color-orange),0.13)', 'hsl(var(--color-orange))',
      'Capturing owner - pairing not binding',
      "The browser on this PC can't reach the local agent to bind whoever is clocked in, so the agent is capturing the assigned owner. Anyone else who uses this PC would be mis-attributed to the owner. Allow the browser to reach 127.0.0.1:47615 (localhost / private-network access) on this machine.");
  if (ps === 'stale_binding')
    return chip('hsla(var(--color-orange),0.13)', 'hsl(var(--color-orange))',
      `Bound to ${d.activeName || 'someone'} - not clocked in`,
      'This PC is still bound to a session that never clocked out. It frees on the next clock-out or the nightly auto clock-out.');
  if (ps === 'bound')
    return chip('hsla(var(--color-green),0.13)', 'hsl(var(--color-green))',
      `Paired: ${d.activeName || d.activeEmail}`,
      'The person clocked in on this PC is correctly bound - the agent is capturing them, not the enroll owner.');
  return null;
}

// ── Monitoring policy (admin) ─────────────────────────────────────────────────
// Central control of what Nexus records while people are clocked in. Capture
// runs in the browser (Chrome screen sharing) - there is no desktop agent - so
// this policy governs the in-app capture: whether it's on, how often it grabs a
// frame, and what activity signals it keeps. Employees see this notice and
// acknowledge it the first time they clock in each day.

const MON_TOGGLES = [
  ['enabled',      'Monitoring enabled',       'Master switch - turns disclosed monitoring on for everyone clocked in.'],
  ['trackScreens', 'Capture screens',          'Periodic screenshots of the shared work screen while the person is clocked in.'],
  ['trackWindows', 'Track apps and windows',   'Records which app or window is active - titles only, not their contents.'],
  ['trackInput',   'Track activity level',     'Overall activity level - never keystrokes.'],
  ['randomize',    'Randomize capture timing', 'Jitter each interval by ±25% so the exact capture moment can’t be predicted.'],
];

// Compact on/off switch matching the inline-style idiom used across the portal.
function PolicySwitch({ on, onToggle }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle}
      style={{ flexShrink: 0, width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 2,
        background: on ? 'hsl(var(--color-green))' : 'var(--line)', transition: 'background .15s ease' }}>
      <span style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: '#fff',
        transform: on ? 'translateX(18px)' : 'translateX(0)', transition: 'transform .15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
    </button>
  );
}

// ── Company computers (desktop monitoring agent) ──────────────────────────────
// The one reusable install command + the list of enrolled PCs. The agent is
// disclosed (visible tray, named process); the command is identical on every PC
// and each machine self-enrolls its own identity at install time.
function AgentInstall() {
  const [info, setInfo] = useState(null);      // { configured, command, note } | null loading | false error
  const [devices, setDevices] = useState(null);
  const [people, setPeople] = useState([]);
  const [copied, setCopied] = useState(false);
  const [copiedU, setCopiedU] = useState(false);
  const [savedId, setSavedId] = useState('');   // device id that just saved its owner
  const [showHow, setShowHow] = useState(false); // collapse the install/uninstall commands

  const loadDevices = useCallback(() => {
    api.timeAgentDevices()
      .then(r => setDevices((r.devices || []).filter(d => !(d.label || '').toLowerCase().includes('phone'))))
      .catch(() => setDevices([]));
  }, []);
  useEffect(() => {
    // A view-only Employee Tracking grant can watch/see computers but not install
    // or manage them (that needs a full grant / IT Admin) - the endpoint 403s.
    api.timeAgentInstallCommand().then(setInfo).catch(e => setInfo(e && e.status === 403 ? 'forbidden' : false));
    loadDevices();
    // Refresh the roster so the status dots track live (heartbeat is every 60s).
    const iv = setInterval(loadDevices, 20000);
    // Curated Nexus People list for the "assign owner" picker (never M365/GAL).
    api.getPeopleDirectory()
      .then(rows => setPeople((rows || []).map(u => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter(p => p.email)))
      .catch(() => setPeople([]));
    return () => clearInterval(iv);
  }, [loadDevices]);

  async function remove(id, label) {
    if (!window.confirm(`Remove ${label || 'this computer'} from the list?\n\nThis deletes its Nexus record. If the agent is still installed, uninstall it on the PC separately.`)) return;
    try { await api.timeAgentDeleteDevice(id); loadDevices(); } catch { /* stays listed; retry */ }
  }

  async function assign(id, email) {
    // Optimistic: reflect the pick immediately, reconcile from the server.
    setDevices(ds => ds && ds.map(d => d.id === id ? { ...d, email, name: (people.find(p => p.email === email) || {}).name || '' } : d));
    try {
      await api.timeAgentAssignDevice(id, email);
      setSavedId(id);
      setTimeout(() => setSavedId(cur => (cur === id ? '' : cur)), 2200);
    } finally { loadDevices(); }
  }

  function copyTo(text, setter) {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setter(true);
      setTimeout(() => setter(false), 1800);
    }).catch(() => {});
  }

  async function revoke(id) {
    try { await api.timeAgentRevoke(id); loadDevices(); } catch { /* stays listed; retry */ }
  }

  const card = { border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)', marginTop: 16 };
  // View-only Employee Tracking grant: can see the enrolled list, but not install
  // or manage computers (those endpoints require a full grant / IT Admin).
  const viewOnly = info === 'forbidden';

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <MonitorSmartphone size={16} style={{ color: 'hsl(var(--color-blue))' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Company Computers</span>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
        Installs the Nexus monitoring agent on a company PC. It's the <b>same command on every machine</b> -
        each PC enrolls its own identity automatically. The agent is disclosed: a visible tray icon that turns
        green while capturing, a named process in Task Manager, and it records only while someone is clocked in.
      </p>

      {viewOnly ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          <ShieldCheck size={14} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0, marginTop: 1 }} />
          <span>You have <b>view-only</b> access to Employee Tracking. Installing, assigning, and removing computers needs a full grant (or IT Admin). You can still watch screens and view the enrolled list below.</span>
        </div>
      ) : (<>
      {/* Install/uninstall commands live under a toggle - the day-to-day need is
          the enrolled list below, not the copy-paste commands. */}
      <button onClick={() => setShowHow(v => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid var(--line)',
          borderRadius: 8, cursor: 'pointer', padding: '6px 11px', fontSize: 12, fontWeight: 700, color: 'var(--ink)', fontFamily: 'Inter, sans-serif' }}>
        <ChevronDown size={13} style={{ transform: showHow ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
        {showHow ? 'Hide install steps' : 'How to install / remove a computer'}
      </button>

      {showHow && (<div style={{ marginTop: 12 }}>
      {info === null ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading install command…
        </div>
      ) : info === false ? (
        <div style={{ fontSize: 12.5, color: '#b91c1c' }}>Could not load the install command.</div>
      ) : (<>
        {!info.configured && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', border: '1px solid hsla(var(--color-orange),0.35)', borderRadius: 10, padding: '9px 12px', marginBottom: 10 }}>
            <TriangleAlert size={14} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--ink)', lineHeight: 1.5 }}>
              Not fully configured yet - the server is missing the hosted installer URL, bundle URL, or enrollment
              key, so the placeholders below won't run. Set <code>NEXUS_AGENT_INSTALL_URL</code>,{' '}
              <code>NEXUS_AGENT_BUNDLE_URL</code>, and <code>NEXUS_AGENT_ENROLL_KEY</code> on the backend.
            </span>
          </div>
        )}

        <div style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--mist)' }}>
          <pre style={{ margin: 0, padding: '12px 44px 12px 12px', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--ink)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{info.command}</pre>
          <button onClick={() => copyTo(info.command, setCopied)} title="Copy command"
            style={{ position: 'absolute', top: 8, right: 8, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', padding: '5px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: copied ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>
        <p style={{ margin: '9px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          Run it in an <b>elevated</b> (Administrator) prompt to install the employee-proof service that covers
          every profile on the PC. A normal prompt does a removable per-user install. It runs the same way pasted
          into Command Prompt or PowerShell.
        </p>

        {/* Uninstall one-liner (served straight from the API - no bundle needed). */}
        {info.uninstallCommand && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
              Uninstall command
            </div>
            <div style={{ position: 'relative', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--mist)' }}>
              <pre style={{ margin: 0, padding: '12px 44px 12px 12px', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--ink)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{info.uninstallCommand}</pre>
              <button onClick={() => copyTo(info.uninstallCommand, setCopiedU)} title="Copy uninstall command"
                style={{ position: 'absolute', top: 8, right: 8, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', padding: '5px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: copiedU ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
                {copiedU ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
            {info.uninstallNote && (
              <p style={{ margin: '9px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>{info.uninstallNote}</p>
            )}
          </div>
        )}
      </>)}
      </div>)}
      </>)}

      {/* Enrolled computers */}
      <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
          Enrolled computers
        </div>
        {devices === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
        ) : devices.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No computers enrolled yet.</div>
        ) : devices.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 170 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <StatusDot online={d.online} capturing={d.capturing} secs={d.secondsSinceSeen} />
                <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.deviceName || d.label || 'Unnamed PC'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                <span style={{ color: d.online ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: 700 }}>
                  {d.capturing ? 'Capturing' : d.online ? 'Online' : `Offline · ${relSeen(d.secondsSinceSeen)}`}
                </span>
                {' · '}{[d.platform, d.deviceUser, d.agentVersion ? `Agent v${d.agentVersion}` : null].filter(Boolean).join(' · ') || 'company PC'}
                {d.activeName && !d.capturing && <> · <span style={{ fontWeight: 700 }}>{d.activeName}</span></>}
              </div>
              {/* Shared-PC pairing health (Visesh, Aug 26): is the agent capturing
                  the person actually clocked in here, or silently the enroll owner
                  because the browser couldn't reach the local agent to bind? */}
              <PairingChip d={d} />
            </div>
            {/* Assign this PC to a Nexus person (its owner). Owner picker + Revoke +
                Remove need a full grant; a view-only grant sees the owner read-only. */}
            {viewOnly ? (
              <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>
                {d.email ? <>Owner: <b style={{ color: 'var(--ink)' }}>{d.name || d.email}</b></> : 'Shared'}
              </span>
            ) : (<>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Owner</span>
              <select className="form-input" value={d.email || ''} onChange={e => assign(d.id, e.target.value)}
                style={{ fontSize: 12, height: 30, minWidth: 150, maxWidth: 190 }}>
                <option value="">Unassigned (shared)</option>
                {people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
              </select>
              {savedId === d.id && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-green))' }}>
                  <Check size={12} /> Saved
                </span>
              )}
            </div>
            <button onClick={() => revoke(d.id)} title="Revoke this computer's token (disable it, keep the PC)"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: '#b91c1c', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, flexShrink: 0 }}>
              <Ban size={12} /> Revoke
            </button>
            <button onClick={() => remove(d.id, d.deviceName)} title="Remove this entry (after uninstalling / decommissioning)"
              style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'var(--muted)', padding: '4px 7px', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
              <Trash2 size={13} />
            </button>
            </>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Live coverage (who's clocked in + how they're captured) ───────────────────
// pulse = the dot glows in motion. Everything live glows; a red "not captured"
// gap ALSO glows because it means someone is clocked in and NOT being captured -
// the alert worth the eye. Only exempt / screens-off sit as a steady, quiet dot.
const COV_META = {
  agent:       { label: 'Desktop agent', fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)',  pulse: true },
  browser:     { label: 'Chrome share',  fg: 'hsl(var(--color-blue))',   bg: 'hsla(var(--color-blue),0.12)',   pulse: true },
  on_break:    { label: 'On break',      fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)', pulse: true },
  gap:         { label: 'Not captured',  fg: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)',    pulse: true },
  exempt:      { label: 'Exempt',        fg: 'var(--muted)',             bg: 'var(--mist)',                    pulse: false },
  screens_off: { label: 'Screens off',   fg: 'var(--muted)',             bg: 'var(--mist)',                    pulse: false },
};


// Live presence badges for one person: an animated eye with the watcher count
// (click to see who, with their Nexus avatar) and an animated wrench when someone
// is giving remote support. Both quietly absent when nobody is watching/helping.
function PresenceBadges({ pres }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);   // fixed-position anchor for the portal menu
  const btnRef = useRef(null);
  const watchers = (pres && pres.watchers) || [];
  const controller = pres && pres.controller;
  // Anchor the menu to the button in VIEWPORT coords and render it in a portal, so
  // it can never be clipped by the coverage card's overflow:hidden (rounded corners).
  const openMenu = () => {
    const r = btnRef.current && btnRef.current.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };
  if (!watchers.length && !controller) return null;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {controller && (
        <span title={`${controller.name} is giving remote support`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800,
            color: 'hsl(var(--color-orange))', background: 'hsla(var(--color-orange),0.12)', padding: '3px 9px', borderRadius: 999 }}>
          <Wrench size={12} style={{ transformOrigin: 'center', animation: 'nexusWrenchWork 1.1s ease-in-out infinite' }} />
          <Avatar email={controller.email} name={controller.name} size={16} card={false} />
        </span>
      )}
      {watchers.length > 0 && (
        <>
          <button ref={btnRef} onClick={() => (open ? setOpen(false) : openMenu())} title={`${watchers.length} watching - click to see who`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, cursor: 'pointer',
              color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.12)', border: 'none', padding: '3px 9px', borderRadius: 999 }}>
            <Eye size={13} style={{ animation: 'nexusEyeWatch 1.4s ease-in-out infinite' }} />
            {watchers.length}
          </button>
          {open && pos && createPortal(
            <>
              <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 3000 }} />
              <div style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 3001, minWidth: 200, maxWidth: 280,
                background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12,
                boxShadow: '0 16px 44px rgba(0,0,0,0.30)', padding: 6, transformOrigin: 'top right',
                animation: 'nexusPresPop 0.15s cubic-bezier(0.16,1,0.3,1)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 7px' }}>
                  <Eye size={12} style={{ color: 'hsl(var(--color-blue))' }} />
                  <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Watching now</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.12)', borderRadius: 999, padding: '1px 7px' }}>{watchers.length}</span>
                </div>
                {watchers.map(w => (
                  <div key={w.email}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--mist, rgba(148,163,184,0.12))')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 8, transition: 'background 0.12s' }}>
                    <Avatar email={w.email} name={w.name} size={24} card={false} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                  </div>
                ))}
              </div>
            </>, document.body)}
        </>
      )}
    </div>
  );
}

function LiveCoverage({ onOpenPerson }) {
  const [watch, setWatch] = useState(null);   // {email,name} being live-viewed, or null
  const [data, setData] = useState(null);   // {people,...} | null loading | false error
  const [presence, setPresence] = useState({});   // email -> {watchers, controller}
  const load = useCallback(() => {
    api.timeMonitoringCoverage().then(setData).catch(() => setData(false));
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 20000);   // keep the roster live
    return () => clearInterval(iv);
  }, [load]);
  // Presence (who's watching / giving support) refreshes faster than the roster
  // so the eye/wrench badges feel live.
  useEffect(() => {
    let alive = true;
    const tick = () => api.timeLivePresence()
      .then(r => { if (alive) setPresence((r && r.bySubject) || {}); })
      .catch(() => {});
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const people = (data && data.people) || [];
  const gaps = people.filter(p => p.status === 'gap').length;

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Activity size={16} style={{ color: 'hsl(var(--color-green))' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Live Coverage</span>
        <div style={{ flex: 1 }} />
        {gaps > 0 && (
          <span style={{ fontSize: 11, fontWeight: 800, color: 'hsl(var(--color-red))', background: 'hsla(var(--color-red),0.1)', padding: '2px 9px', borderRadius: 999 }}>
            {gaps} not captured
          </span>
        )}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        Everyone clocked in right now and how their screen is being captured - desktop agent, in-browser Chrome share,
        or a gap that needs attention. Refreshes automatically.
      </p>
      {data === null ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
        </div>
      ) : data === false ? (
        <div style={{ fontSize: 12.5, color: '#b91c1c' }}>Could not load coverage.</div>
      ) : people.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No one is clocked in right now.</div>
      ) : people.map(p => {
        const m = COV_META[p.status] || COV_META.gap;
        const frame = (p.secsSinceFrame != null)
          ? (p.status === 'gap' ? `last frame ${relSeen(p.secsSinceFrame)}` : `frame ${relSeen(p.secsSinceFrame)}`)
          : (p.status === 'gap' ? 'no frames yet' : '');
        return (
          <div key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <Dot color={m.fg} pulse={m.pulse} dim={!m.pulse} title={m.label} />
            <Avatar email={p.email} name={p.name} size={26} card={false} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <button
                onClick={() => onOpenPerson?.(p.email)}
                title="View today's screenshots"
                style={{ display: 'block', maxWidth: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'Inter, sans-serif', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', textDecoration: 'underline', textDecorationColor: 'var(--line)', textUnderlineOffset: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </button>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {[p.deviceName, p.agentVersion ? `Agent v${p.agentVersion}` : null, frame].filter(Boolean).join(' · ') || (p.onBreak ? 'on break' : '')}
              </div>
            </div>
            <PresenceBadges pres={presence[p.email]} />
            {p.canWatchLive && (
              <button
                onClick={() => setWatch({ email: p.email, name: p.name })}
                title="Watch this screen live"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 700,
                  color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.1)', border: '1px solid hsla(var(--color-blue),0.25)',
                  padding: '3px 10px', borderRadius: 999, cursor: 'pointer' }}>
                <Video size={12} /> Watch live
              </button>
            )}
            <span style={{ fontSize: 11, fontWeight: 800, color: m.fg, background: m.bg, padding: '3px 10px', borderRadius: 999, flexShrink: 0 }}>
              {m.label}
            </span>
          </div>
        );
      })}
      {watch && <LiveView email={watch.email} name={watch.name} onClose={() => setWatch(null)} />}
    </div>
  );
}

const MON_SUBTABS = [
  { id: 'coverage',    label: 'Coverage' },
  { id: 'activity',    label: 'Activity' },
  { id: 'locations',   label: 'Locations' },
  { id: 'policy',      label: 'Policy' },
  { id: 'computers',   label: 'Computers' },
  { id: 'screenshots', label: 'Screenshots' },
];

// Activity/Insights (apps, sites, active vs idle, productivity) for a chosen day.
function ActivityInsights() {
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [people, setPeople] = useState([]);
  useEffect(() => {
    api.getPeopleDirectory()
      .then(rows => setPeople((rows || []).map(u => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter(p => p.email)))
      .catch(() => setPeople([]));
  }, []);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Activity size={16} style={{ color: 'hsl(var(--color-purple))' }} />
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Activity &amp; Insights</span>
        <div style={{ flex: 1 }} />
        <input className="form-input" type="date" value={day} onChange={e => setDay(e.target.value)} style={{ fontSize: 12, width: 150 }} />
      </div>
      <TimeInsights start={day} end={day} people={people} />
    </div>
  );
}

export default function TimeTrackingAdmin({ initialSub = 'coverage', module = false }) {
  const [policy, setPolicy] = useState(null);
  const [policyMsg, setPolicyMsg] = useState(null);   // {ok, text}
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [sub, setSub] = useState(initialSub);
  const [shotReq, setShotReq] = useState({ email: '', date: '' });   // Coverage -> Screenshots deep-link
  useEffect(() => {
    if (initialSub) setSub(initialSub);
    // Opening Screenshots straight from the header/menu shows the people list -
    // clear any leftover Coverage deep-link so it doesn't reopen the last person.
    if (initialSub === 'screenshots') setShotReq({ email: '', date: '' });
  }, [initialSub]);
  useEffect(() => { api.timeMonitoringPolicy().then(setPolicy).catch(() => setPolicy(null)); }, []);

  async function savePolicy() {
    if (!policy || savingPolicy) return;
    setSavingPolicy(true); setPolicyMsg(null);
    try {
      const saved = await api.timeSetMonitoringPolicy({
        enabled:         !!policy.enabled,
        interval_minutes: Math.min(60, Math.max(1, Number(policy.intervalMinutes) || 5)),
        randomize:       !!policy.randomize,
        track_screens:   !!policy.trackScreens,
        track_windows:   !!policy.trackWindows,
        track_input:     !!policy.trackInput,
      });
      setPolicy(saved);
      setPolicyMsg({ ok: true, text: 'Monitoring policy saved.' });
    } catch (e) {
      setPolicyMsg({ ok: false, text: e?.message || 'Could not save the policy.' });
    }
    setSavingPolicy(false);
  }

  return (
    <div style={module
      ? { fontFamily: 'Inter,sans-serif', animation: 'fadeIn var(--transition-normal) ease-in-out' }
      : { fontFamily: 'Inter,sans-serif', maxWidth: 640, margin: '0 auto' }}>
      {module && (
        <div className="view-header" style={{ marginBottom: 0 }}>
          <div className="view-title-group">
            <h2>Workforce Analytics</h2>
            <p>Disclosed monitoring - coverage, activity, locations, screenshots, and company computers</p>
          </div>
        </div>
      )}
      <style>{`@keyframes nexusDotPulse {
        0% { box-shadow: 0 0 0 0 currentColor; }
        70% { box-shadow: 0 0 0 5px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      @keyframes nexusEyeWatch { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(1.14); } }
      @keyframes nexusWrenchWork { 0%,100% { transform: rotate(-14deg); } 50% { transform: rotate(14deg); } }
      @keyframes nexusPresPop { from { opacity: 0; transform: translateY(-6px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }`}</style>

      {/* Sub-tabs so the monitoring screen isn't one long scroll. */}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 4, marginTop: module ? 18 : 0, marginBottom: 16, borderBottom: '1px solid var(--line)' }}>
        {MON_SUBTABS.map(t => (
          <button key={t.id} onClick={() => { if (t.id === 'screenshots') setShotReq({ email: '', date: '' }); setSub(t.id); }}
            style={{ padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer',
              fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: sub === t.id ? 700 : 500,
              color: sub === t.id ? 'hsl(var(--color-green))' : 'var(--muted)',
              borderBottom: sub === t.id ? '2px solid hsl(var(--color-green))' : '2px solid transparent',
              marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {sub === 'coverage' && <LiveCoverage onOpenPerson={(email) => { setShotReq({ email, date: new Date().toISOString().slice(0, 10) }); setSub('screenshots'); }} />}

      {sub === 'activity' && <ActivityInsights />}

      {sub === 'locations' && <Locations embedded />}

      {sub === 'screenshots' && (
        <ScreenshotsAdmin embedded initialEmail={shotReq.email} initialDate={shotReq.date} onBack={() => { setShotReq({ email: '', date: '' }); setSub('coverage'); }} />
      )}

      {sub === 'policy' && (
      <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <ShieldCheck size={16} style={{ color: 'hsl(var(--color-green))' }} />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Monitoring Policy</span>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
          Sets what Nexus records while people are clocked in. Capture runs in the browser (Chrome screen sharing) -
          there’s no separate app to install. Employees see this notice and acknowledge it the first time they clock in
          each day. Changes take effect the next time someone starts a session.
        </p>
        {policy === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading policy…
          </div>
        ) : (<>
          <div style={{ display: 'grid', gap: 10 }}>
            {MON_TOGGLES.map(([key, label, help]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <PolicySwitch on={!!policy[key]} onToggle={() => setPolicy(p => ({ ...p, [key]: !p[key] }))} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>{help}</div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 2 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Capture interval</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>How often a frame is captured, in minutes (1–60).</div>
              </div>
              <input className="form-input" type="number" min={1} max={60}
                value={policy.intervalMinutes ?? 5}
                onChange={e => setPolicy(p => ({ ...p, intervalMinutes: e.target.value }))}
                style={{ width: 88, fontSize: 13, textAlign: 'center', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>min</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button className="primary-btn" onClick={savePolicy} disabled={savingPolicy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {savingPolicy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} Save policy
            </button>
            {policyMsg && (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: policyMsg.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{policyMsg.text}</span>
            )}
          </div>
        </>)}
      </div>
      )}

      {sub === 'computers' && <AgentInstall />}
    </div>
  );
}
