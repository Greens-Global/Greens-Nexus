// Settings > Global Settings > Security > Sign-In & Sessions (Sep 2026).
//
// Backed by backend/security_config.py + routers/security_settings.py. Each
// value is: saved here > the server's env var > the built-in default, inside
// hard bounds the server enforces (the ranges shown here are informational;
// the server is the boundary). Administrators can read; only a Super Administrator
// (owner) can save. A switch the server config forces on is locked.
//
// The "Re-Authentication for Sensitive Actions" group (step-up sign-in
// before vault/pay/HR screens, and its MFA/unlock-duration/freshness knobs)
// was removed from here on request (Pranshu, Sep 28 - "not really helpful"
// as an admin-facing control). Those settings still exist and still work
// exactly as before (security_config.py, stepupEnforce/stepupRequireMfa/
// stepupTtlSec/stepupMaxAgeSec) - they are just no longer editable from this
// screen, the same as before this page existed. Only Sessions and Guest
// Sign-In are shown.
import { useState, useEffect, useCallback, useMemo } from 'react';
import SaveRow from '../components/SaveRow';
import { SettingRow } from '../components/settings/SettingsUI';
import { dialog } from '../ui/dialog';
import { useGroupDirty } from '../lib/groupDirty';
import { RotateCcw, Lock } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';

const GROUPS = [
  {
    title: 'Sessions',
    desc: 'How long people stay signed in and how long temporary access lasts.',
    fields: [
      { key: 'webSessionIdleDays', label: 'Web Session Idle Limit',
        desc: 'A browser that has not used Nexus for this long is signed out. Lowering it signs out anyone already idle longer, on their next visit.' },
      { key: 'actAsMinutes', label: 'Act As Session Length',
        desc: 'How long an Act As session lasts before it ends on its own. Applies to sessions started after the change.' },
      { key: 'vaultOtpUnlockSec', label: 'Credentials Unlock (Code)',
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

const SOURCE_LABEL = { saved: 'Saved', env: 'Set by Server Config', default: 'Default' };

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

// A value in its stored unit, said the way people say it when that reads
// better: 900 seconds is "15 minutes", 240 minutes "4 hours".
function spoken(value, unit) {
  if (!Number.isInteger(value)) return null;
  if (unit === 'seconds' && value >= 60) return friendly(value, unit);
  if (unit === 'minutes' && value >= 60) {
    if (value % 60 === 0) return friendly(value, unit);
    const h = Math.floor(value / 60), m = value % 60;
    return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
  }
  return null;
}

// `groups`: the sections shown - GROUPS on the page (a test passes its own).
export default function SecuritySettings({ toastOk, toastErr, groups = GROUPS }) {
  const [data, setData] = useState(null);   // { settings, canEdit }
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({});   // key -> number|'' (typed) or null (reset); switches are never a draft
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(null);   // { key, on } while a switch saves

  const load = useCallback(() => {
    setError('');
    api.getSecuritySettings()
      .then(d => { setData(d); setDraft({}); })
      .catch(e => setError(e?.message || 'Could not load security settings.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  // A switch saves on click (Neil, 11/02/2026 - one switch behavior
  // everywhere), alone: a typed number beside it stays a draft for the Save
  // row. It shows its new place at once and goes back if the save fails.
  // Turning one off weakens sign-in for everyone, so that asks first (and
  // the server wants confirmWeaken for it); the Undo toast writes the old
  // value back.
  const writeSwitch = async (key, label, on) => {
    setSwitching({ key, on });
    try {
      const d = await api.updateSecuritySettings({ [key]: on }, !on);
      setData(d);
      return true;
    } catch (e) {
      toastErr?.(e?.message || `Could not save ${label}.`);
      return false;
    } finally {
      setSwitching(null);
    }
  };
  const toggle = async (key, label, on) => {
    const was = !!data?.settings?.[key]?.value;
    if (!on) {
      const ok = await dialog.confirm(`Turning off ${label} weakens sign-in security for everyone, from their next sign-in.`,
        { title: `Turn Off ${label}?`, confirmText: 'Turn Off', cancelText: 'Keep It On', danger: true });
      if (!ok) return;
    }
    if (await writeSwitch(key, label, on)) {
      dialog.undo(`${label} turned ${on ? 'on' : 'off'}.`, async () => {
        if (await writeSwitch(key, label, was)) toastOk?.(`${label} is back ${was ? 'on' : 'off'}.`);
      });
    }
  };

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

  // Resolves true once saved (the prompt's Save and Leave).
  async function save() {
    if (!dirty || !valid || busy) return !dirty;
    // No boolean toggle is shown on this page any more (the safety-toggle
    // group was removed), so nothing here can weaken sign-in - the "are you
    // sure" confirm that used to guard turning one off is gone with it.
    // A SHORTER idle limit signs people out (bff_session._idle_expired checks
    // every request against it), so lowering it asks first; raising it does not.
    if ('webSessionIdleDays' in changes) {
      const s = settings.webSessionIdleDays;
      const next = changes.webSessionIdleDays === null ? (s.hasEnv ? s.envValue : s.default) : changes.webSessionIdleDays;
      if (Number.isInteger(next) && next < s.value) {
        const ok = await dialog.confirm(
          `Lowering the Web Session Idle Limit from ${s.value} to ${next} ${next === 1 ? 'day' : 'days'} signs out everyone who has not used Nexus in the last ${next === 1 ? 'day' : `${next} days`}, the next time they open it.`,
          { title: 'Shorten the Idle Limit?', confirmText: 'Lower the Limit', cancelText: 'Keep Editing' });
        if (!ok) return false;
      }
    }
    setBusy(true);
    try {
      const d = await api.updateSecuritySettings(changes, false);
      setData(d); setDraft({});
      toastOk?.('Security settings saved.');
      return true;
    } catch (e) {
      toastErr?.(e?.message || 'Could not save security settings.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  useGroupDirty(dirty, save);

  if (error) {
    return (
      <div style={{ padding: '14px 16px', border: '1px dashed var(--line)', borderRadius: 10, fontSize: 13, color: 'var(--muted)' }}>
        <div style={{ marginBottom: 10 }}>{error}</div>
        <button className="secondary-btn" onClick={load}>Try Again</button>
      </div>
    );
  }
  if (!data) return <SkeletonBlocks count={4} height={56} borderRadius={10} />;

  // Rows on the group's one card (the group is flush): each section's name
  // as a small heading, its settings as Settings rows, one Save row at the foot.
  return (
    <div>
      {!canEdit && (
        <div role="note" className="nx-set-note" style={{ borderTop: 'none', borderBottom: '1px solid var(--line)' }}>
          <Lock size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
          <span>You can view these settings. Only a Super Administrator can change them.</span>
        </div>
      )}

      {groups.map((g, gi) => (
        <section key={g.title} aria-label={g.title}>
          <div className="nx-set-pad" style={{ borderTop: gi || !canEdit ? '1px solid var(--line)' : 'none', background: 'var(--paper)' }}>
            <h5 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{g.title}</h5>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>{g.desc}</p>
          </div>
          {g.fields.filter(f => settings[f.key]).map(f => {
            const s = settings[f.key];
            const v = valueOf(f.key);
            const inputId = `sec-${f.key}`;
            const pendingReset = draft[f.key] === null;
            const disabled = !canEdit || busy || s.locked || !!switching;
            const edited = f.key in changes && !pendingReset;
            const shownSource = pendingReset ? (s.hasEnv ? 'env' : 'default') : (edited ? 'saved' : s.source);
            const said = s.type === 'int' ? spoken(typeof v === 'number' ? v : NaN, s.unit) : null;
            return (
              <div key={f.key} style={{ borderTop: '1px solid var(--line)' }}>
                <SettingRow htmlFor={inputId} title={f.label} desc={f.desc}
                  control={s.type === 'bool' ? (
                    // The switch sits right in the control slot, so the phone
                    // rule that keeps a switch at the row's right finds it.
                    <>
                      {switching?.key === f.key && <Spinner size={12} />}
                      <input id={inputId} type="checkbox" role="switch" className="nx-switch"
                        checked={switching?.key === f.key ? switching.on : !!s.value} disabled={disabled}
                        aria-label={f.label} aria-describedby={`${inputId}-desc`}
                        onChange={e => toggle(f.key, f.label, e.target.checked)} />
                    </>
                  ) : (
                    <>
                      <input id={inputId} className="form-input" type="number" inputMode="numeric"
                        min={s.min} max={s.max} step={1} value={v} disabled={disabled}
                        aria-invalid={!!errors[f.key]} aria-label={f.label} aria-describedby={`${inputId}-desc`}
                        onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value === '' ? '' : Number(e.target.value) }))}
                        style={{ width: 96 }} />
                      <span style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.unit}{said ? ` (${said})` : ''}</span>
                    </>
                  )}>
                  <span className={`nx-set-badge${shownSource === 'saved' ? ' is-own' : ''}`}>{SOURCE_LABEL[shownSource]}{(f.key in changes) ? ' (Unsaved)' : ''}</span>
                  {s.locked && <span className="nx-set-badge">Required by Server Config</span>}
                  {s.type === 'int' && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Allowed: {rangeText(s)}</span>}
                  {s.outOfRange && <span style={{ fontSize: 12, color: 'var(--nx-own)' }}>The server config value is outside the allowed range.</span>}
                  {canEdit && !s.locked && s.type !== 'bool' && !pendingReset && (s.source === 'saved' || f.key in draft) && (
                    <button type="button" className="secondary-btn" disabled={busy} aria-label={`Reset ${f.label} to Default`}
                      onClick={() => setDraft(d => {
                        const n = { ...d };
                        if (s.source === 'saved') n[f.key] = null; else delete n[f.key];
                        return n;
                      })}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                      <RotateCcw size={12} aria-hidden="true" /> Reset to Default
                    </button>
                  )}
                  {errors[f.key] && <div role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'hsl(var(--color-red))' }}>{errors[f.key]}</div>}
                </SettingRow>
              </div>
            );
          })}
        </section>
      ))}

      {canEdit && (
        <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={() => setDraft({})} saveDisabled={!valid}
          style={{ margin: 0, padding: '12px 18px' }}
          note="A change reaches every server within a minute. A lower idle limit ends sessions already idle longer than it, on their next visit." />
      )}
    </div>
  );
}
