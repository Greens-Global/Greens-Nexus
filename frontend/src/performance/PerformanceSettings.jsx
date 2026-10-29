// Settings > Performance (Oct 29 2026, made simple): the one group - how long
// a goal kept by hand may go without an update, and the 1:1 agenda reminder.
// An organization default a company may override (backend/scoped_settings.py,
// key "performance"). Review reminders are automatic and have no setting.
// Drawn with the Settings rows; the switch saves on click, the number through
// the group's one Save row (CLAUDE.md "Settings saves one way").
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { SettingCard, SettingRow, SwitchRow, NumberBox } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import SaveRow from '../components/SaveRow';
import { useGroupDirty } from '../lib/groupDirty';

export function PerformanceReminderSettings({ company = '', onOverride, toastOk, toastErr }) {
  const [meta, setMeta] = useState(null);
  const [days, setDays] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.perfSettings(company).then(m => { setLoadErr(''); setMeta(m); setDays(String(m.settings?.checkinEveryDays ?? 14)); })
      .catch(e => setLoadErr(e?.message || 'Could not load the settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);
  const saved = String(meta?.settings?.checkinEveryDays ?? 14);
  const dirty = !!meta && days !== saved;
  useGroupDirty(dirty);

  async function save(next, reset = false) {
    setBusy(true);
    try {
      const m = await api.perfSettingsSave({ company, settings: next, reset });
      setMeta(m); setDays(String(m.settings?.checkinEveryDays ?? 14));
      toastOk?.(reset ? 'Back to the default for every company.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); load(); }
    finally { setBusy(false); }
  }

  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  const canEdit = !!meta.canEdit;
  const vals = meta.settings || {};
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {company && <span className="nx-set-pad" style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has its own reminders.' : 'This company uses the default.'}</span>}
      <SettingCard>
        <SettingRow title="Goal Update Reminder"
          desc="A goal kept by hand with no update for this many days reminds its owner, at most once in that time. Goals measured by Nexus need no updates. 0 turns it off."
          control={<NumberBox label="Days between updates" min={0} max={90} unit="days" disabled={!canEdit || busy} value={days}
            onChange={(v) => setDays(v === '' ? '' : String(Number(v)))} />} />
        <SwitchRow id={`perf-1on1-reminder-${company || 'all'}`} title="1:1 Agenda Reminder"
          desc="The day before a 1:1, both people are told when its agenda is still empty - one notice a day, however many 1:1s it covers."
          checked={!!vals.oneOnOneReminder} disabled={!canEdit || busy}
          onChange={(v) => save({ ...vals, oneOnOneReminder: v })} />
      </SettingCard>
      {!canEdit ? (
        <p className="nx-set-pad" style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          {company ? 'Only HR for this company can change these.' : 'The default for every company is changed by HR with access to every company. Pick your company to set its own.'}
        </p>
      ) : (
        <div className="nx-set-pad">
          <SaveRow dirty={dirty} busy={busy} onSave={() => save({ ...vals, checkinEveryDays: Number(days) || 0 })}
            onDiscard={() => setDays(saved)}
            onUseDefault={company && meta.override ? () => save(vals, true) : undefined} />
        </div>
      )}
    </div>
  );
}

export default PerformanceReminderSettings;
