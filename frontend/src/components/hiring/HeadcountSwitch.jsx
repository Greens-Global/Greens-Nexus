// Settings > Hiring & Onboarding > Headcount Requests (Neil, Oct 30 2026:
// "disabled by default ... a setting that can be turned on at a company
// level. Not needed for most small and midsize companies"). One switch per
// company; it saves on click. Off: no Headcount tab, no requests raised,
// listed or waiting on anyone, and HR starts job openings by hand. Nothing
// is deleted - turning it back on brings every request back as it was.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { SwitchRow } from '../settings/SettingsUI';

export default function HeadcountSwitch({ company = '', toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setErr(''); setData(null);
    api.headcountSettings(company)
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) setErr(e?.message || 'Could not load the Headcount Requests setting.'); });
  }, [company]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const flip = async (on) => {
    setBusy(true);
    try {
      setData(await api.headcountSaveSettings(company, on));
      toastOk?.(on ? 'Headcount Requests turned on for this company.' : 'Headcount Requests turned off for this company.');
    } catch (e) { toastErr?.(e?.message || 'Could not change Headcount Requests.'); }
    setBusy(false);
  };

  if (err) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'hsl(var(--color-red))', padding: '12px 18px' }}>
        <span style={{ flex: 1 }}>{err}</span>
        <button type="button" className="secondary-btn" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!data) return <SkeletonBlocks count={1} height={56} borderRadius={10} />;
  return (
    <SwitchRow id="headcount-requests-on" title="Headcount Requests" checked={!!data.on} disabled={busy || !data.canEdit}
      onChange={flip}
      desc={data.on
        ? 'Managers ask to hire in Team > Headcount; the department line and HR approve, and an approved request becomes a Draft job opening.'
        : 'Off: there is no Headcount tab and HR starts job openings directly in People > Hiring > Openings. Requests raised before are kept and come back when it is turned on.'} />
  );
}
