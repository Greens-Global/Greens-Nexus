import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useGroupDirty } from '../lib/groupDirty';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { SwitchRow, SettingRow } from './settings/SettingsUI';
import { DateField } from '../tasks/components';
import { formatDate } from '../lib/datetime';

// Settings > Pay > India Contractor Policy (Neil, Oct 27 2026,
// docs/India-Contractor-Pay.md). Per company: the switch (on by default for
// an India company, off for a company in any other country) and Policy
// Starts (11/01/2026 by default - a month that starts before it keeps the old
// rules, so October is never re-priced). At "Every company" the default
// Policy Starts; a company picked in Scope gets its own switch and date.
// The server (india_contractor_pay.py) does every calculation.
export default function IndiaContractorPolicySettings({ toastOk, toastErr, company = '', onOverride }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [start, setStart] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setErr('');
    setData(null);
    api.timeIndiaPolicyGet(company)
      .then((d) => { if (mine === seq.current) { setData(d); setStart(d?.startDate || ''); } })
      .catch((e) => { if (mine === seq.current) setErr(e?.message || 'Could not load the India Contractor Policy.'); });
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (data && company) onOverride?.(!!data.hasOverride); }, [data, company, onOverride]);
  const dirty = !!data && start !== (data.startDate || '');
  useGroupDirty(dirty);

  const save = async (body, msg) => {
    setBusy(true);
    try {
      const d = await api.timeIndiaPolicySet(body, company);
      setData(d);
      setStart(d?.startDate || '');
      toastOk?.(msg);
    } catch (e) { toastErr?.(e?.message || 'Could not save the India Contractor Policy.'); }
    setBusy(false);
  };

  if (err) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'hsl(var(--color-red))', padding: '12px 18px' }}>
        <span style={{ flex: 1 }}>{err}</span>
        <button className="secondary-btn" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!data) return <SkeletonBlocks count={2} height={56} borderRadius={10} />;
  const india = data.companyCountry === 'IN';
  const byDefault = !data.mode;
  return (
    <div data-testid="india-contractor-policy">
      {company ? (
        <SwitchRow id="india-contractor-policy-on" title="India Contractor Policy" checked={!!data.enabled} disabled={busy}
          desc={`Contractors on monthly pay who work in India: credits by hours (full day at 8, half at 4), the month-end reconciliation that recovers missing days from extra hours, and Extra Time at 1.35x for hours they claim with a note. Replaces the automatic weekend pay for them. ${byDefault ? (india || !data.companyCountry ? 'On by default for this company.' : 'Off by default - this company is not in India.') : 'Set for this company.'}`}
          onChange={(on) => save({ mode: on ? 'on' : 'off', startDate: data.startDate }, on ? 'India Contractor Policy turned on.' : 'India Contractor Policy turned off.')} />
      ) : (
        <SettingRow title="India Contractor Policy"
          desc="On by default for every company in India (and for a company with no country, where each contractor's own country decides); off for a company anywhere else. Pick a company in Scope to turn it on or off there." />
      )}
      <SettingRow htmlFor="india-contractor-policy-start" title="Policy Starts"
        desc={`Months that start on or after this day are priced by the policy; earlier months keep the old rules, and a finalized month never changes. Default ${formatDate(data.defaultStart || '2026-11-01')}.`}
        control={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <DateField value={start} onChange={(v) => setStart(v || '')} title="Policy Starts" disabled={busy} />
            {busy && <Spinner size={14} />}
          </span>
        )}>
        {(dirty || (company && data.hasOverride)) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {dirty && <button className="primary-btn" disabled={busy || !start} onClick={() => save({ mode: data.mode, startDate: start }, 'Policy Starts saved.')}>Save</button>}
            {dirty && <button className="secondary-btn" disabled={busy} onClick={() => setStart(data.startDate || '')}>Discard</button>}
            {company && data.hasOverride && !dirty && (
              <button type="button" className="nx-set-inline-link" disabled={busy}
                onClick={() => save({ reset: true }, 'Back to the default for every company.')}>Use the Default for Every Company</button>
            )}
          </div>
        )}
      </SettingRow>
    </div>
  );
}
