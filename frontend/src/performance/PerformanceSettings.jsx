// Settings > Performance (Oct 29 2026, made simple): the one group - how long
// a goal kept by hand may go without an update, and the 1:1 agenda reminder.
// An organization default a company may override (backend/scoped_settings.py,
// key "performance"). Review reminders are automatic and have no setting.
// Drawn with the Settings rows; the switch saves on click, the number through
// the group's one Save row (CLAUDE.md "Settings saves one way").
import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { SettingCard, SettingRow, SwitchRow, NumberBox } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import SaveRow from '../components/SaveRow';
import { useGroupDirty } from '../lib/groupDirty';
import TeamsTargetPicker, { EMPTY_TEAMS_TARGET } from '../components/TeamsTargetPicker';

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

// Kudos (Neil, 11/08/2026): the company values a kudos may be tagged with -
// a chip list that saves on change, an organization default a company may
// override (the same "performance" scoped setting as the reminders).
export function PerformanceKudosSettings({ company = '', onOverride, toastOk, toastErr }) {
  const [meta, setMeta] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.perfSettings(company).then(m => { setLoadErr(''); setMeta(m); }).catch(e => setLoadErr(e?.message || 'Could not load the settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);

  async function save(values, reset = false) {
    setBusy(true);
    try {
      const m = await api.perfSettingsSave({ company, settings: { kudosValues: values }, reset });
      setMeta(m); setDraft('');
      toastOk?.(reset ? 'Back to the default for every company.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); load(); }
    finally { setBusy(false); }
  }

  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  const canEdit = !!meta.canEdit;
  const values = meta.settings?.kudosValues || [];
  const add = () => { const v = draft.trim(); if (v && !values.some(x => x.toLowerCase() === v.toLowerCase())) save([...values, v]); };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {company && <span className="nx-set-pad" style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has settings of its own.' : 'This company uses the default.'}</span>}
      <SettingCard>
        <SettingRow title="Company Values" desc="The values a kudos may be tagged with - the send form asks which one they lived. No values, no question.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {values.map(v => (
              <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, border: '1px solid var(--line)', borderRadius: 999, padding: '2px 4px 2px 10px' }}>
                {v}
                {canEdit && <button type="button" aria-label={`Remove ${v}`} disabled={busy} onClick={() => save(values.filter(x => x !== v))}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', padding: 2 }}><X size={12} /></button>}
              </span>
            ))}
            {canEdit && (
              <>
                <input className="form-input" value={draft} onChange={e => setDraft(e.target.value.slice(0, 40))} placeholder="e.g. Ownership" aria-label="New value"
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} style={{ width: 150, fontSize: 12.5, padding: '3px 8px' }} />
                <button type="button" className="secondary-btn" onClick={add} disabled={busy || !draft.trim()} style={{ fontSize: 12 }}>Add Value</button>
              </>
            )}
            {!values.length && !canEdit && <span style={{ fontSize: 12, color: 'var(--muted)' }}>None yet.</span>}
          </div>
          {company && canEdit && meta.override && (
            <div style={{ marginTop: 8 }}><button type="button" className="secondary-btn" disabled={busy} onClick={() => save([], true)} style={{ fontSize: 11.5 }}>Use the Default</button></div>
          )}
        </SettingRow>
      </SettingCard>
      {!canEdit && (
        <p className="nx-set-pad" style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          {company ? 'Only HR for this company can change these.' : 'The default for every company is changed by HR with access to every company. Pick your company to set its own.'}
        </p>
      )}
    </div>
  );
}

// Kudos on Teams (Neil, 11/08/2026; a channel per company 11/12/2026): the
// channel - or a group chat - a company's kudos are posted to, layered the
// same way (an organization default, a company's own over it); its group
// opens to a Super Administrator only (AdminConsole `needs`), and the save
// route refuses anyone else. Reactions and replies there come back to Nexus
// as thanks (backend/perf_kudos_teams.py). The picker is TeamsTargetPicker,
// the one the BOD / EOD job roles use; one Save row, as a typed setting.
const sameTarget = (a, b) => (!a?.id && !b?.id)
  || ((a?.id || '') === (b?.id || '') && (a?.type || 'chat') === (b?.type || 'chat') && (a?.teamId || '') === (b?.teamId || ''));
// Nothing picked yet opens on Channel - the recommended place.
const targetOf = (m) => ({ ...EMPTY_TEAMS_TARGET, type: 'channel', ...(m?.settings?.kudosTeams || {}) });

export function PerformanceKudosChatSettings({ company = '', onOverride, toastOk, toastErr }) {
  const [meta, setMeta] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState(EMPTY_TEAMS_TARGET);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.perfSettings(company).then(m => { setLoadErr(''); setMeta(m); setDraft(targetOf(m)); })
      .catch(e => setLoadErr(e?.message || 'Could not load the settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);
  const saved = targetOf(meta);
  const dirty = !!meta && !sameTarget(draft, saved);
  useGroupDirty(dirty);

  async function save(reset = false) {
    setBusy(true);
    try {
      const m = await api.perfSettingsSave({ company, settings: { kudosTeams: draft.id ? draft : {} }, reset });
      setMeta(m); setDraft(targetOf(m));
      toastOk?.(reset ? 'Back to the default for every company.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    finally { setBusy(false); }
  }

  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {company && <span className="nx-set-pad" style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has settings of its own.' : 'This company uses the default.'}</span>}
      <SettingCard>
        <SettingRow title="Post Kudos To" desc="A channel in the company's all-staff team works best - each kudos gets its own thread. Kudos post as the sender, mentioning the recipient. Reactions and replies there come back to Nexus as thanks, and a thanks given in Nexus adds a clap there. Nothing picked = the send form offers no Teams switch for this company.">
          <div style={{ width: 'min(100%, 420px)' }}>
            <TeamsTargetPicker value={draft} onChange={setDraft} toastErr={toastErr} audience="Everyone who sends kudos" />
          </div>
        </SettingRow>
      </SettingCard>
      <div className="nx-set-pad">
        <SaveRow dirty={dirty} busy={busy} onSave={() => save(false)} onDiscard={() => setDraft(saved)}
          onUseDefault={company && meta.override ? () => save(true) : undefined} />
      </div>
    </div>
  );
}

export default PerformanceReminderSettings;
