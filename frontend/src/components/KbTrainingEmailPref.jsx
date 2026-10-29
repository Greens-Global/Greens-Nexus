// Profile > Email Settings > Training (WP 2.4, Oct 29 2026): a person may turn
// off the email for training that is only due soon. Overdue training and
// policies to sign always email, and the bell always rings (decision D5).
// Backend: routers/kb_reminder_settings.py (/mine), kb_daily.wants_due_soon_email.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { SwitchRow } from './settings/SettingsUI';

export default function KbTrainingEmailPref() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getKbMyEmailPref()).then((s) => { if (live) setState(s); }).catch(() => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, []);

  const save = async (on) => {
    setBusy(true);
    setMsg('');
    try {
      setState(await api.updateKbMyEmailPref({ dueSoonEmail: on }));
      setMsg('Saved');
    } catch (e) {
      setMsg(e?.detail || e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading training emails...</div>;
  if (state.error) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <SwitchRow id="kb-due-soon-email" title="Email Me When Training Is Due Soon" checked={state.dueSoonEmail}
        disabled={busy || !state.orgEmailOn} onChange={save}
        desc={state.orgEmailOn
          ? 'Off keeps due-soon reminders in the notification bell only. Overdue training and policies to sign always email you.'
          : 'Training reminder emails are turned off for everyone, so reminders arrive in the notification bell only.'} />
      {msg && <div role="status" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
