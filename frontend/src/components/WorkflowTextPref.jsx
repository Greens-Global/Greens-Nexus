// Profile > Phone Notifications > Texts From Workflows (11/05/2026): whether a
// workflow's Send A Text Message may text you (on by default). Backend:
// routers/roles.py /roles/me/text-prefs, workflows/packs/core.py "sms".
// A switch saves on change.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { SwitchRow } from './settings/SettingsUI';

export default function WorkflowTextPref() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getMyTextPrefs())
      .then((s) => { if (live) setState(s); })
      .catch(() => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, []);

  const save = async (on) => {
    setBusy(true);
    setMsg('');
    try {
      setState(await api.setMyTextPrefs(on));
      setMsg('Saved');
    } catch (e) {
      setMsg(e?.detail || e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (!state || state.error) return null;
  return (
    <>
      <SwitchRow id="profile-workflow-texts" title="Texts From Workflows" checked={!!state.workflowTexts}
        disabled={busy} onChange={save}
        desc={state.phone
          ? 'Automated workflows may text the phone on your People record. Off: they skip you; the bell and email still reach you.'
          : 'There is no phone on your People record, so workflows cannot text you. Ask HR to add one.'} />
      {msg && <div role="status" className="nx-set-pad" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{msg}</div>}
    </>
  );
}
