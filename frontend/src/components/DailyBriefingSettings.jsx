// Daily Briefing - admin settings (Sep 2026). Global-Admin gated: this flag
// controls whether every employee in the company starts receiving a daily
// email, so it mirrors the backend's require_administrator bar (level 4),
// not the lower manager bar Ticket/Task notify settings use - see
// backend/routers/daily_briefing.py.
//
// No delivery log here (unlike Ticket/Task notify) - the briefing's own
// dedupe record (NexusDailyBriefingLog) has no admin-facing read endpoint
// yet; this panel only covers the one thing that was previously "callable
// directly" (Pranshu, Sep 20 - so mode/test recipients no longer need a
// direct API call every time).
import { useEffect, useState } from 'react';
import { Mail, Save, AlertTriangle, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

const MODES = [
  { key: 'off', label: 'Off', hint: 'Loop still scans and logs (for timing/dedupe visibility) but never sends mail.' },
  { key: 'test', label: 'Test', hint: 'Computes every employee’s real content, but every send is redirected to the test recipients below.' },
  { key: 'live', label: 'Live', hint: 'Sends each employee their own briefing, to their own inbox.' },
];

export default function DailyBriefingSettings() {
  const { can } = useRole();
  const [cfg, setCfg] = useState(null);
  const [recipientsInput, setRecipientsInput] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.getDailyBriefingConfig()
    .then((c) => { setCfg(c); setRecipientsInput((c.test_recipients || []).join(', ')); })
    .catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);

  if (!can('administrator')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Global-Admin access is required to view Daily Briefing settings.
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;

  const goingLive = cfg.mode === 'live';
  // Switching TO live is the one change here that reaches every employee in
  // the company the moment it saves - everything else (off/test, editing the
  // test list) is reversible with no visible side effect to anyone but the
  // admin. The extra tick is a speed bump for that one transition, not a
  // permission check (the backend already gates the whole endpoint).
  const switchingToLive = goingLive && !confirmLive;

  const save = async () => {
    if (switchingToLive) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      const patch = {
        mode: cfg.mode,
        test_recipients: recipientsInput.split(',').map((s) => s.trim()).filter(Boolean),
      };
      const next = await api.updateDailyBriefingConfig(patch);
      setCfg(next);
      setRecipientsInput((next.test_recipients || []).join(', '));
      setConfirmLive(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Mail size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Daily Briefing</div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabel}>Mode</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {MODES.map((m) => (
            <label key={m.key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              border: `1px solid ${cfg.mode === m.key ? NX.blue : NX.border}`, borderRadius: 8,
              background: cfg.mode === m.key ? 'var(--wk-brand-tint)' : 'transparent', cursor: 'pointer',
            }}>
              <input type="radio" name="briefing-mode" checked={cfg.mode === m.key}
                onChange={() => { setCfg((c) => ({ ...c, mode: m.key })); setConfirmLive(false); }}
                style={{ marginTop: 3 }} />
              <span>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{m.label}</div>
                <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>{m.hint}</div>
              </span>
            </label>
          ))}
        </div>
      </div>

      {cfg.mode === 'test' && (
        <div style={{ marginBottom: 16 }}>
          <label style={fieldLabel}>Test recipients</label>
          <input value={recipientsInput} onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="you@company.com, another@company.com" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Comma-separated. Every employee's briefing computes on their own real data, but the send is
            redirected here instead of their own inbox, with a "[TEST -&gt; original]" subject prefix.
          </div>
        </div>
      )}

      {goingLive && (
        <div style={{
          display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 8, marginBottom: 16,
          background: 'hsla(var(--color-red), 0.08)', border: '1px solid hsla(var(--color-red), 0.35)',
        }}>
          <ShieldAlert size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'hsl(var(--color-red))' }}>
              This sends a real email to every employee in the company
            </div>
            <div style={{ fontSize: 12, color: NX.dim, marginTop: 3 }}>
              Each person gets their own briefing at their own shift trigger - no dry run once this saves.
              Confirm test mode has already been checked for a few real people before turning this on.
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
              I understand this goes out to every employee company-wide.
            </label>
          </div>
        </div>
      )}

      {err && <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: NX.red, margin: '0 0 12px' }}>
        <AlertTriangle size={13} /> {err}
      </div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={{ ...btn('primary'), opacity: (saving || switchingToLive) ? 0.6 : 1 }}
          onClick={save} disabled={saving || switchingToLive}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
      </div>
    </div>
  );
}
