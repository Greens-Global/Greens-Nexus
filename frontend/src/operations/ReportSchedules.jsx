// Operations > Reports > Scheduled: reports Nexus emails on a schedule as an
// XLSX / PDF / CSV attachment, to people picked from Nexus People. List,
// switch on and off, send now, edit, delete; the dialog is shared with the
// clock icon on the report list. Before the server has schedules (404) the
// tab says so calmly instead of showing an error.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDateTime } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { WEEKDAYS, hourLabel, ordinal, periodName, scheduleWords } from './reportPeriod';
import { FORMATS, Field, FacilitiesField, FormatField, OptionsField, PeopleField, PeriodField, ReportModal, cleanOptions, facilitiesWords, initials } from './reportFields';

export function useSchedules() {
  const [state, setState] = useState({ status: 'loading', list: [] });
  const reload = useCallback(async () => {
    try {
      const out = await api.opsReportSchedules();
      const list = Array.isArray(out) ? out : (out?.schedules || []);
      setState({ status: 'ready', list });
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) setState({ status: 'off', list: [] });
      else setState((s) => ({ status: 'error', list: s.list, error: err?.message || "Couldn't load the scheduled reports." }));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

const FREQ = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
const formatLabel = (k) => (FORMATS.find(([f]) => f === k) || FORMATS[0])[1];

export function blankSchedule(meta, facilityIds) {
  return { name: meta ? meta.title : '', kind: meta?.key || '', frequency: 'weekly', day: 0, hour: 8, includeWeekends: false, active: true,
    recipients: [], period: { mode: meta?.period ? 'previous' : 'current', unit: 'week' }, facilityIds, options: meta ? cleanOptions(meta) : {}, format: 'xlsx' };
}

export function ScheduleDialog({ initial, reports, facilities, today, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...initial, facilityIds: initial.facilityIds?.length ? initial.facilityIds : facilities.map((f) => f.id) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choosable = reports.filter((r) => r.source !== 'unavailable');
  const meta = reports.find((r) => r.key === form.kind);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const pickReport = (kind) => {
    const m = reports.find((r) => r.key === kind);
    setForm((f) => ({ ...f, kind, name: !f.name || f.name === reports.find((r) => r.key === f.kind)?.title ? (m?.title || '') : f.name,
      options: m ? cleanOptions(m) : {} }));
  };
  const setFreq = (frequency) => setForm((f) => ({ ...f, frequency, day: frequency === 'monthly' ? Math.min(28, Math.max(1, Number(f.day) || 1)) : Math.min(6, Number(f.day) || 0) }));

  const ok = form.name.trim() && meta && form.recipients.length && form.facilityIds.length;
  const save = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError('');
    const all = form.facilityIds.length >= facilities.length;
    const body = { name: form.name.trim(), kind: form.kind, frequency: form.frequency, day: Number(form.day), hour: Number(form.hour),
      includeWeekends: form.frequency === 'daily' ? !!form.includeWeekends : false, active: !!form.active, recipients: form.recipients,
      period: meta.period ? { mode: form.period.mode, unit: form.period.unit || 'month' } : { mode: 'current', unit: 'day' },
      facilityIds: all ? [] : form.facilityIds, options: cleanOptions(meta, form.options), format: form.format };
    try {
      const out = form.id ? await api.updateOpsReportSchedule(form.id, body) : await api.createOpsReportSchedule(body);
      onSaved(out?.schedule || out);
    } catch (err) {
      setError(err?.status === 404 ? 'Scheduled reports are not switched on yet. Try again after the next update.' : (err?.message || 'The schedule was not saved.'));
    } finally { setBusy(false); }
  };

  const title = form.id ? 'Edit Scheduled Report' : 'Schedule Report';
  return (
    <ReportModal title={title} sub="Emailed from Nexus with the report attached." onClose={onClose}
      footer={(
        <>
          {error && <p className="ops-form-error" role="alert" style={{ flex: '1 1 100%' }}>{error}</p>}
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="ops-sched-form" className="primary-btn" disabled={!ok || busy}>{busy ? 'Saving...' : 'Save Schedule'}</button>
        </>
      )}>
      <form id="ops-sched-form" onSubmit={save} className="ops-rd-stack">
        <div className="ops-rd-grid">
          <label className="ops-rd-opt">
            <span className="ops-rd-label">Name</span>
            <input className="form-input" value={form.name} maxLength={120} required onChange={(e) => set('name')(e.target.value)} />
          </label>
          <label className="ops-rd-opt">
            <span className="ops-rd-label">Report</span>
            <select className="form-input" value={form.kind} required onChange={(e) => pickReport(e.target.value)}>
              {!form.kind && <option value="">Pick a report</option>}
              {choosable.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
            </select>
          </label>
        </div>
        <Field label="Send" id="rs-when" hint={`${scheduleWords(form)}, Pacific Time.`}>
          <div className="ops-rd-row">
            <select className="form-input ops-rd-select" aria-label="How Often" value={form.frequency} onChange={(e) => setFreq(e.target.value)}>
              {FREQ.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {form.frequency === 'weekly' && (
              <select className="form-input ops-rd-select" aria-label="Day of the Week" value={form.day} onChange={(e) => set('day')(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            {form.frequency === 'monthly' && (
              <select className="form-input ops-rd-select" aria-label="Day of the Month" value={form.day} onChange={(e) => set('day')(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{`The ${ordinal(d)}`}</option>)}
              </select>
            )}
            <span className="ops-rd-at">at</span>
            <select className="form-input ops-rd-select" aria-label="Time" value={form.hour} onChange={(e) => set('hour')(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
          <div className="ops-rd-row" style={{ marginTop: 10 }}>
            {form.frequency === 'daily' && (
              <label className="ops-rd-check"><input type="checkbox" checked={!!form.includeWeekends} onChange={(e) => set('includeWeekends')(e.target.checked)} />
                <span className="ops-rd-opt-l">Include Weekends</span></label>
            )}
            <label className="ops-rd-check"><input type="checkbox" checked={!!form.active} onChange={(e) => set('active')(e.target.checked)} />
              <span className="ops-rd-opt-l">Active</span></label>
          </div>
        </Field>
        <PeopleField value={form.recipients} onChange={set('recipients')} />
        {meta && (
          <>
            <PeriodField meta={meta} value={form.period} onChange={set('period')} today={today} allowManual={false} scheduled />
            <FacilitiesField facilities={facilities} value={form.facilityIds} onChange={set('facilityIds')} />
            <OptionsField meta={meta} value={cleanOptions(meta, form.options)} onChange={set('options')} />
            <FormatField value={form.format} onChange={set('format')} />
          </>
        )}
      </form>
    </ReportModal>
  );
}

function Switch({ on, label, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} className="ops-switch" disabled={disabled} onClick={onChange}>
      <span />
    </button>
  );
}

export default function ReportSchedules({ schedules, reports, facilities, onNew, onEdit }) {
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  useEffect(() => { api.getPeopleDirectory().then((p) => setPeople(Array.isArray(p) ? p : [])).catch(() => setPeople([])); }, []);
  const nameOf = useMemo(() => {
    const map = new Map(people.map((p) => [(p.email || '').toLowerCase(), p.name]));
    return (email) => map.get(String(email).toLowerCase()) || email;
  }, [people]);
  const titleOf = (s) => s.title || reports.find((r) => r.key === s.kind)?.title || s.kind;

  const act = async (id, fn, done) => {
    setBusy(id); setNote(null);
    try { await fn(); if (done) setNote({ ok: true, text: done }); await schedules.reload(); } catch (err) {
      setNote({ ok: false, text: err?.message || 'That did not work. Try again.' });
    } finally { setBusy(''); }
  };
  const remove = async (s) => {
    const yes = await dialog.confirm(`Delete the scheduled report "${s.name}"? Nobody will get it any more.`, { title: 'Delete Scheduled Report', confirmText: 'Delete', danger: true });
    if (yes) act(s.id, () => api.deleteOpsReportSchedule(s.id), `${s.name} was deleted.`);
  };

  if (schedules.status === 'loading') return <div className="dash-card"><SkeletonBlocks count={3} height={56} /></div>;

  const list = schedules.list;
  return (
    <div className="dash-card">
      <div className="dash-card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="dash-card-title">Scheduled Reports</div>
          <div className="dash-card-sub">Emailed from Nexus with the report attached. Times are Pacific Time.</div>
        </div>
        {schedules.status !== 'off' && (
          <button type="button" className="primary-btn" onClick={onNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} aria-hidden="true" /> New Schedule
          </button>
        )}
      </div>
      {schedules.status === 'error' && <ErrorBanner message={schedules.error} onRetry={schedules.reload} />}
      {note && <div className={`ops-rep-flash${note.ok ? '' : ' is-bad'}`} role="status">{note.text}</div>}
      {schedules.status === 'off' && (
        <div className="ops-empty ops-lib-empty">
          <CalendarClock size={22} aria-hidden="true" />
          <div>Scheduled report emails are not switched on yet.</div>
          <div>Reports can still be opened and downloaded from the Reports tab.</div>
        </div>
      )}
      {schedules.status === 'ready' && !list.length && (
        <div className="ops-empty ops-lib-empty">
          <CalendarClock size={22} aria-hidden="true" />
          <div>No scheduled reports yet.</div>
          <div>Use the clock next to any report, or New Schedule, to email it to people on a schedule.</div>
        </div>
      )}
      {list.length > 0 && (
        <div className="req-table-wrapper">
          <table className="req-table ops-lib ops-sched">
            <thead>
              <tr><th>Name</th><th>When</th><th>Send To</th><th>Format</th><th>Active</th><th>Last Sent</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const names = (s.recipients || []).map(nameOf);
                return (
                  <tr key={s.id}>
                    <td data-label="Name">
                      <div className="ops-lib-name">{s.name}</div>
                      <div className="ops-lib-sub">{titleOf(s)}{reports.find((r) => r.key === s.kind)?.period ? ` - ${periodName(s.period)}` : ''} - {facilitiesWords(s.facilityIds || [], facilities)}{!s.mine && s.owner ? ` - by ${nameOf(s.owner)}` : ''}</div>
                    </td>
                    <td data-label="When">
                      <div>{scheduleWords(s)}</div>
                      {s.active && s.nextRunAt && <div className="ops-lib-sub">Next {formatDateTime(s.nextRunAt)}</div>}
                    </td>
                    <td data-label="Send To">
                      <span className="ops-avatars" title={names.join(', ')}>
                        {names.slice(0, 3).map((n) => <span key={n} className="ops-avatar">{initials(n)}</span>)}
                        <span className="ops-lib-sub" style={{ marginLeft: 6 }}>{names.length === 1 ? names[0] : `${names.length} People`}</span>
                      </span>
                    </td>
                    <td data-label="Format">{formatLabel(s.format)}</td>
                    <td data-label="Active">
                      <Switch on={s.active} label={`${s.name} Active`} disabled={!s.canEdit || busy === s.id}
                        onChange={() => act(s.id, () => api.updateOpsReportSchedule(s.id, { active: !s.active }))} />
                    </td>
                    <td data-label="Last Sent">
                      <div>{s.lastSentAt ? formatDateTime(s.lastSentAt) : <span className="ops-lib-sub">Not Sent Yet</span>}</div>
                      {s.lastError && <div className="ops-sched-err" title={s.lastError}>Last send failed: {s.lastError}</div>}
                    </td>
                    <td className="ops-lib-acts">
                      <button type="button" className="secondary-btn ops-btn-sm" disabled={busy === s.id}
                        onClick={() => act(s.id, () => api.sendOpsReportSchedule(s.id), `${s.name} is on its way to ${names.length === 1 ? names[0] : `${names.length} people`}.`)}>
                        <Send size={13} aria-hidden="true" /> Send Now
                      </button>
                      {s.canEdit !== false && (
                        <>
                          <button type="button" className="ops-icon-btn" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => onEdit(s)}><Pencil size={15} /></button>
                          <button type="button" className="ops-icon-btn" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => remove(s)}><Trash2 size={15} /></button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
