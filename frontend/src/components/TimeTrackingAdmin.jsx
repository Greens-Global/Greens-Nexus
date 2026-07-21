import { useState, useEffect } from 'react';
import { ShieldCheck, Loader2, Check } from 'lucide-react';
import { api } from '../api';

// ── Monitoring policy (admin) ─────────────────────────────────────────────────
// Central control of what Nexus records while people are clocked in. Capture
// runs in the browser (Chrome screen sharing) — there is no desktop agent — so
// this policy governs the in-app capture: whether it's on, how often it grabs a
// frame, and what activity signals it keeps. Employees see this notice and
// acknowledge it the first time they clock in each day.

const MON_TOGGLES = [
  ['enabled',      'Monitoring enabled',       'Master switch — turns disclosed monitoring on for everyone clocked in.'],
  ['trackScreens', 'Capture screens',          'Periodic screenshots of the shared work screen while the person is clocked in.'],
  ['trackWindows', 'Track apps and windows',   'Records which app or window is active — titles only, not their contents.'],
  ['trackInput',   'Track activity level',     'Overall activity level — never keystrokes.'],
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

export default function TimeTrackingAdmin() {
  const [policy, setPolicy] = useState(null);
  const [policyMsg, setPolicyMsg] = useState(null);   // {ok, text}
  const [savingPolicy, setSavingPolicy] = useState(false);
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
    <div style={{ fontFamily: 'Inter,sans-serif', maxWidth: 640, margin: '0 auto' }}>
      <div style={{ border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <ShieldCheck size={16} style={{ color: 'hsl(var(--color-green))' }} />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Monitoring Policy</span>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
          Sets what Nexus records while people are clocked in. Capture runs in the browser (Chrome screen sharing) —
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
    </div>
  );
}
