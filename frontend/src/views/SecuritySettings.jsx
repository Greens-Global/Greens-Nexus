// Settings > Global Settings > Security > Sign-In & Sessions (Sep 2026).
//
// Backed by backend/security_config.py + routers/security_settings.py. Each
// value is: saved here > the server's env var > the built-in default, inside
// hard bounds the server enforces (the ranges shown here are informational;
// the server is the boundary). Administrators can read; only a Global Admin
// (owner) can save. Turning step-up enforcement or MFA-required off asks for
// an explicit confirm, and a switch the server config forces on is locked.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { RotateCcw, Lock } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { SkeletonBlocks } from '../components/AsyncState';

const GROUPS = [
  {
    title: 'Re-Authentication for Sensitive Actions',
    desc: 'Before showing vault secrets, other people\'s pay and confidential HR records, Nexus can ask the person to sign in to Microsoft again.',
    fields: [
      { key: 'stepupEnforce', label: 'Require Re-Authentication',
        desc: 'When on, sensitive screens ask for a fresh Microsoft sign-in first. Turning it off removes that check for everyone.' },
      { key: 'stepupRequireMfa', label: 'Require Multi-Factor Verification',
        desc: 'When on, the fresh sign-in must include a second factor (Authenticator, text message). Turn it on only once MFA is enabled for every account, or people will be blocked.' },
      { key: 'stepupTtlSec', label: 'Unlock Duration',
        desc: 'How long one re-authentication unlocks sensitive screens. Longer means fewer prompts but a longer window if a signed-in computer is left unattended.' },
      { key: 'stepupMaxAgeSec', label: 'Sign-In Freshness',
        desc: 'How recent the Microsoft sign-in must be to count. Shorter is stricter; too short can reject people on slow connections.' },
    ],
  },
  {
    title: 'Sessions',
    desc: 'How long people stay signed in and how long temporary access lasts.',
    fields: [
      { key: 'webSessionIdleDays', label: 'Web Session Idle Limit',
        desc: 'A browser that has not used Nexus for this long is signed out. Lowering it signs out anyone already idle longer, on their next visit.' },
      { key: 'actAsMinutes', label: 'Act As Session Length',
        desc: 'How long an Act As session lasts before it ends on its own. Applies to sessions started after the change.' },
      { key: 'vaultOtpUnlockSec', label: 'Credential Vault Unlock (Code)',
        desc: 'How long a verified text or email code unlocks revealing and sharing company vault credentials.' },
      { key: 'vaultPersonalUnlockSec', label: 'Personal Vault Unlock',
        desc: 'The longest a Personal Vault stays unlocked after the password is entered. The screen still locks itself sooner when idle.' },
    ],
  },
  {
    title: 'Guest Sign-In',
    desc: 'Partners and guests sign in with a one-time code instead of a Microsoft account.',
    fields: [
      { key: 'guestCodeTtlMin', label: 'Sign-In Code Lifetime',
        desc: 'How long an emailed or texted code works. Shorter is safer; longer helps when email is slow.' },
      { key: 'guestMaxAttempts', label: 'Wrong Code Attempts',
        desc: 'Wrong codes allowed before the code is cancelled and the account is locked out for a while.' },
      { key: 'guestLockoutMin', label: 'Lockout Duration',
        desc: 'How long a guest must wait after too many wrong codes.' },
      { key: 'guestRequestsPerHour', label: 'Code Requests per Hour',
        desc: 'Codes one email address, or one network address, can request in an hour. Limits guessing and message flooding.' },
      { key: 'guestInviteTtlDays', label: 'Invitation Link Lifetime',
        desc: 'How long the link in an invitation email works before it has to be resent.' },
    ],
  },
];

const SOURCE_LABEL = { saved: 'Saved', env: 'Set by server config', default: 'Default' };
const LABELS = Object.fromEntries(GROUPS.flatMap(g => g.fields.map(f => [f.key, f.label])));

function friendly(value, unit) {
  if (unit === 'seconds') {
    if (value % 60 === 0) { const m = value / 60; return `${m} minute${m === 1 ? '' : 's'}`; }
    return `${value} seconds`;
  }
  if (unit === 'minutes' && value >= 60 && value % 60 === 0) { const h = value / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return null;
}

function rangeText(s) {
  const lo = friendly(s.min, s.unit), hi = friendly(s.max, s.unit);
  const base = `${s.min} to ${s.max} ${s.unit}`;
  return lo && hi && s.unit !== 'minutes' ? `${base} (${lo} to ${hi})` : base;
}

function Badge({ children, tone = 'muted' }) {
  const color = tone === 'brand' ? 'var(--wk-brand)' : 'var(--muted)';
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color, border: '1px solid var(--line)', borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export default function SecuritySettings({ toastOk, toastErr }) {
  const [data, setData] = useState(null);   // { settings, canEdit }
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({});   // key -> number|bool|'' (typed) or null (reset)
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api.getSecuritySettings()
      .then(d => { setData(d); setDraft({}); })
      .catch(e => setError(e?.message || 'Could not load security settings.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const settings = useMemo(() => data?.settings || {}, [data]);
  const canEdit = !!data?.canEdit;

  // What the server would store after Save, per changed key.
  const changes = useMemo(() => {
    const out = {};
    for (const [key, v] of Object.entries(draft)) {
      const s = settings[key];
      if (!s) continue;
      if (v === null) { if (s.source === 'saved') out[key] = null; continue; }
      if (s.type === 'int') {
        const n = v === '' ? NaN : Number(v);
        if (n !== s.value) out[key] = n;
      } else if (v !== s.value) out[key] = v;
    }
    return out;
  }, [draft, settings]);

  const errors = useMemo(() => {
    const out = {};
    for (const [key, v] of Object.entries(changes)) {
      const s = settings[key];
      if (v === null || s.type !== 'int') continue;
      if (!Number.isInteger(v)) out[key] = 'Enter a whole number.';
      else if (v < s.min || v > s.max) out[key] = `Must be ${s.min} to ${s.max} ${s.unit}.`;
    }
    return out;
  }, [changes, settings]);

  const dirty = Object.keys(changes).length > 0;
  const valid = Object.keys(errors).length === 0;

  const valueOf = (key) => {
    const s = settings[key];
    if (key in draft) {
      if (draft[key] === null) return s.hasEnv ? s.envValue : s.default;   // what Reset falls back to
      return draft[key];
    }
    return s.value;
  };

  async function save() {
    // A switch that is on today and would be off after Save weakens sign-in.
    const weakened = Object.keys(changes).filter(k => settings[k].type === 'bool' && settings[k].value === true
      && (changes[k] === false || (changes[k] === null && !(settings[k].hasEnv ? settings[k].envValue : settings[k].default))));
    if (weakened.length) {
      const ok = await dialog.confirm(
        `Turning off ${weakened.map(k => `"${LABELS[k]}"`).join(' and ')} weakens sign-in security for everyone. Sensitive screens will open without the extra check. Continue?`,
        { title: 'Weaken Sign-In Security?', confirmText: 'Turn Off', danger: true });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const d = await api.updateSecuritySettings(changes, weakened.length > 0);
      setData(d); setDraft({});
      toastOk?.('Security settings saved.');
    } catch (e) {
      toastErr?.(e?.message || 'Could not save security settings.');
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div style={{ padding: '14px 16px', border: '1px dashed var(--line)', borderRadius: 10, fontSize: 13, color: 'var(--muted)' }}>
        <div style={{ marginBottom: 10 }}>{error}</div>
        <button className="secondary-btn" onClick={load}>Try Again</button>
      </div>
    );
  }
  if (!data) return <SkeletonBlocks count={4} height={56} borderRadius={10} />;

  return (
    <div>
      {!canEdit && (
        <div role="note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--paper)', fontSize: 12.5, color: 'var(--muted)', marginBottom: 16 }}>
          <Lock size={14} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>You can view these settings. Only a Global Admin can change them.</span>
        </div>
      )}

      {GROUPS.map(g => (
        <section key={g.title} style={{ marginBottom: 22 }}>
          <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{g.title}</h4>
          <p style={{ margin: '3px 0 10px', fontSize: 12, color: 'var(--muted)' }}>{g.desc}</p>
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            {g.fields.filter(f => settings[f.key]).map((f, i) => {
              const s = settings[f.key];
              const v = valueOf(f.key);
              const inputId = `sec-${f.key}`;
              const pendingReset = draft[f.key] === null;
              const disabled = !canEdit || busy || s.locked;
              const edited = f.key in changes && !pendingReset;
              const shownSource = pendingReset ? (s.hasEnv ? 'env' : 'default') : (edited ? 'saved' : s.source);
              return (
                <div key={f.key} style={{ padding: '12px 14px', borderTop: i ? '1px solid var(--line)' : 'none', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <label htmlFor={inputId} style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{f.label}</label>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{f.desc}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                      <Badge tone={shownSource === 'saved' ? 'brand' : 'muted'}>{SOURCE_LABEL[shownSource]}{(f.key in changes) ? ' (unsaved)' : ''}</Badge>
                      {s.locked && <Badge>Required by server config</Badge>}
                      {s.type === 'int' && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Allowed: {rangeText(s)}</span>}
                      {s.outOfRange && <span style={{ fontSize: 11.5, color: 'hsl(var(--color-amber, 38 92% 50%))' }}>The server config value is outside the allowed range.</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {s.type === 'bool' ? (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer' }}>
                        <input id={inputId} type="checkbox" checked={!!v} disabled={disabled}
                          onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.checked }))} />
                        {v ? 'On' : 'Off'}
                      </label>
                    ) : (
                      <>
                        <input id={inputId} className="form-input" type="number" inputMode="numeric"
                          min={s.min} max={s.max} step={1} value={v} disabled={disabled}
                          aria-invalid={!!errors[f.key]}
                          onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))}
                          style={{ width: 96 }} />
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{s.unit}</span>
                      </>
                    )}
                    {canEdit && !s.locked && !pendingReset && (s.source === 'saved' || f.key in draft) && (
                      <button className="secondary-btn" disabled={busy} title="Reset to Default" aria-label={`Reset ${f.label} to Default`}
                        onClick={() => setDraft(d => {
                          const n = { ...d };
                          if (s.source === 'saved') n[f.key] = null; else delete n[f.key];
                          return n;
                        })}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                        <RotateCcw size={12} /> Reset to Default
                      </button>
                    )}
                  </div>
                  {errors[f.key] && <div role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'hsl(var(--color-red))' }}>{errors[f.key]}</div>}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="secondary-btn" disabled={!dirty || busy} onClick={() => setDraft({})}>Discard Changes</button>
          <button className="primary-btn" disabled={!dirty || !valid || busy} onClick={save}>
            {busy ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  );
}
