// Profile > Task Emails > Digest Emails (11/02/2026, the legal compliance
// pass; backend/email_optout.py, /roles/me/email-optouts). One switch per
// scheduled digest; a switch saves on change. Arriving from an email's "Stop
// These Emails" link (lib/emailStop.js) turns that digest off at once and
// says so, with Start It Again - stopping is never harder than starting.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { SwitchRow } from './settings/SettingsUI';
import { takePendingEmailStop } from '../lib/emailStop';

const DESC = {
  daily_briefing: 'One email a day before your shift with what needs your attention. My Briefing in Nexus stays either way.',
  weekly_digest: 'One email a week with everything waiting on you across Nexus.',
  whats_new_digest: 'A Monday email with the week’s new features you can use.',
  ticket_weekly_report: 'The Monday summary of the service desk, for people who follow it.',
};
const ORDER = ['daily_briefing', 'weekly_digest', 'whats_new_digest', 'ticket_weekly_report'];

export default function DigestEmailPrefs() {
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);   // { text, undo? }
  const took = useRef(false);

  const save = async (kind, on, fromLink = false) => {
    setBusy(kind);
    try {
      const next = await api.setMyEmailOptout(kind, on);
      setPrefs(next);
      const label = next?.[kind]?.label || 'these emails';
      setMsg(on ? { text: `You will get the ${label} again.` }
        : { text: `${fromLink ? 'Done. ' : ''}You will no longer get the ${label}.`, undo: kind });
    } catch (e) {
      setMsg({ text: e?.message || 'Could not save.' });
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    let live = true;
    api.getMyEmailOptouts()
      .then((p) => {
        if (!live) return;
        setPrefs(p);
        if (took.current) return;
        took.current = true;
        const stop = takePendingEmailStop();
        if (stop && p?.[stop]) save(stop, false, true);
      })
      .catch(() => { if (live) setPrefs({ error: true }); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!prefs) return <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Loading digest emails...</div>;
  if (prefs.error) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '4px 0 6px' }}>Digest Emails</div>
      {msg && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--ink)', background: 'var(--wk-hover, var(--mist))', borderRadius: 8, padding: '8px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 160 }}>{msg.text}</span>
          {msg.undo && (
            <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => save(msg.undo, true)}
              style={{ fontSize: 12, padding: '4px 10px' }}>Start It Again</button>
          )}
        </div>
      )}
      {ORDER.filter((k) => prefs[k]).map((k) => (
        <SwitchRow key={k} id={`digest-${k}`} title={prefs[k].label} checked={!!prefs[k].on}
          disabled={busy === k} onChange={(on) => save(k, on)} desc={DESC[k]} />
      ))}
    </div>
  );
}
