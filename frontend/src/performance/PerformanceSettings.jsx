// Settings > Performance (Neil, Oct 27 2026): the reminders - an
// organization default a company may override (backend/scoped_settings.py,
// key "performance"). Drawn with the Settings rows (SettingsUI.jsx).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { SettingCard, SettingRow, SwitchRow, NumberBox } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';

export function PerformanceReminderSettings({ company = '', onOverride, toastOk, toastErr }) {
  const [meta, setMeta] = useState(null);
  const [vals, setVals] = useState({});
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.perfSettings(company).then(m => { setLoadErr(''); setMeta(m); setVals(m.settings || {}); })
      .catch(e => setLoadErr(e?.message || 'Could not load the settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);

  async function save(next, reset = false) {
    setBusy(true);
    try {
      const m = await api.perfSettingsSave({ company, settings: next, reset });
      setMeta(m); setVals(m.settings || {});
      toastOk?.(reset ? 'Back to the default for every company.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); load(); }
    finally { setBusy(false); }
  }

  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  const canEdit = !!meta.canEdit;
  const days = vals.checkinEveryDays ?? 14;
  const dirtyDays = String(days) !== String(meta.settings?.checkinEveryDays ?? 14);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {company && <span className="nx-set-pad" style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has its own reminders.' : 'This company uses the default.'}</span>}
      <SettingCard>
        <SwitchRow id={`perf-1on1-reminder-${company || 'all'}`} title="1:1 Agenda Reminder"
          desc="The day before a 1:1, both people are told when its agenda is still empty - one notice a day, however many 1:1s it covers."
          checked={!!vals.oneOnOneReminder} disabled={!canEdit || busy}
          onChange={(v) => save({ ...vals, oneOnOneReminder: v })} />
        <SettingRow title="Goal Check-In Reminder"
          desc="A goal with no check-in for this many days reminds its owner, at most once in that time. 0 turns it off."
          control={<NumberBox label="Days between check-ins" min={0} max={90} unit="days" disabled={!canEdit || busy} value={days}
            onChange={(v) => setVals(p => ({ ...p, checkinEveryDays: v === '' ? '' : Number(v) }))} />} />
      </SettingCard>
      {!canEdit ? (
        <p className="nx-set-pad" style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          {company ? 'Only HR for this company can change these.' : 'The default for every company is changed by HR with access to every company. Pick your company to set its own.'}
        </p>
      ) : (
        <div className="nx-set-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {dirtyDays && <button type="button" className="primary-btn" disabled={busy} onClick={() => save({ ...vals, checkinEveryDays: Number(days) || 0 })}>{busy ? 'Saving…' : 'Save'}</button>}
          {dirtyDays && <button type="button" className="secondary-btn" disabled={busy} onClick={() => setVals(meta.settings || {})}>Discard Changes</button>}
          {!!company && !!meta.override && <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(vals, true)}>Use the Default</button>}
        </div>
      )}
    </div>
  );
}

export default PerformanceReminderSettings;
