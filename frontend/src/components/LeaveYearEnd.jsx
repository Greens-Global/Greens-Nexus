// Leave year end and the second approval level (Neil, Oct 27 2026) - the
// rules live in backend/leave_year_end.py and routers/timeclock.py.
//   LeaveYearEndSettings   - Settings > Time & Pay > Leave Year-End: per
//                            bucket Use It Or Lose It (the default) / Carry
//                            Everything / Carry Up To a cap, and the leave
//                            year. Layered: the default, or one company's own.
//   TimeOffApprovalSettings - Settings > Time & Pay > Time-Off Approval: the
//                            Second Approval By HR switch, per company.
//   LeaveYearEndPreview    - People > Time > Time Off (HR): what a company's
//                            next year end will do, or what the last one did
//                            and still owes, and Apply Year End.
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Scale } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate } from '../lib/datetime';
import { ErrorBanner, SkeletonBlocks, Spinner } from './AsyncState';
import { SettingCard, SettingRow, SwitchRow, NumberBox } from './settings/SettingsUI';
import { fmtLeave } from './LeaveBalances';

const BUCKETS = [['vacation', 'Vacation'], ['sick', 'Sick / Personal']];
const MODES = [['reset', 'Use It Or Lose It'], ['carry_all', 'Carry Everything'], ['carry_cap', 'Carry Up To a Cap']];
const KEYS = ['vacationMode', 'vacationCap', 'vacationCapUnit', 'vacationYear', 'sickMode', 'sickCap', 'sickCapUnit'];
const day = (d) => (d ? formatDate(`${String(d).slice(0, 10)}T12:00:00`) : '');
const pick = (cfg) => Object.fromEntries(KEYS.map((k) => [k, cfg?.[k]]));
const modeLabel = (m) => (MODES.find(([k]) => k === m) || MODES[0])[1];

// ── Settings ────────────────────────────────────────────────────────────────

export function LeaveYearEndSettings({ toastOk, toastErr, company = '', onOverride }) {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setErr('');
    api.leaveYearEndSettings(company).then((d) => { setCfg(d); setDraft(pick(d)); })
      .catch((e) => setErr(e?.message || 'Could not load the year-end rule.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (cfg && company) onOverride?.(!!cfg.hasOverride); }, [cfg, company, onOverride]);

  if (err) return <div style={{ padding: 14 }}><ErrorBanner message={err} onRetry={load} /></div>;
  if (!cfg || !draft) return <div style={{ padding: 14 }}><SkeletonBlocks count={3} height={44} borderRadius={10} /></div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(cfg));
  const edit = (patch) => setDraft((d) => ({ ...d, ...patch }));
  async function save(reset = false) {
    setBusy(true);
    try {
      const d = await api.leaveYearEndSettingsSave(reset ? { reset: true } : draft, company);
      setCfg(d); setDraft(pick(d));
      toastOk?.(reset ? 'Back to the default year-end rule.' : 'Year-end rule saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save the year-end rule.'); }
    setBusy(false);
  }
  const legal = (cfg.legal || []).map((l) => l.note).join(' ');
  return (
    <SettingCard>
      {BUCKETS.map(([b, label]) => (
        <SettingRow key={b} title={`${label} At Year End`}
          desc={b === 'vacation'
            ? `What happens to unused vacation when the leave year ends. ${legal}`
            : 'What happens to unused sick time when the calendar year ends. A California-style lump grant starts fresh each year either way.'}
          control={(
            <select className="form-input" aria-label={`${label} at year end`} value={draft[`${b}Mode`]} onChange={(e) => edit({ [`${b}Mode`]: e.target.value })}
              style={{ fontSize: 13, width: 'auto' }}>
              {MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}>
          {draft[`${b}Mode`] === 'carry_cap' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Carry up to</span>
              <NumberBox label={`${label} carry-over cap`} min={0} max={2000} value={draft[`${b}Cap`]} onChange={(v) => edit({ [`${b}Cap`]: v === '' ? '' : Number(v) })} />
              <select className="form-input" aria-label={`${label} cap unit`} value={draft[`${b}CapUnit`]} onChange={(e) => edit({ [`${b}CapUnit`]: e.target.value })}
                style={{ fontSize: 13, width: 'auto' }}>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>- the rest expires. Days use each person&apos;s policy hours a day.</span>
            </span>
          )}
        </SettingRow>
      ))}
      <SettingRow title="Vacation Leave Year"
        desc="The calendar year (January 1 - December 31), or each person's work anniversary - only for vacation granted on the anniversary (India). Everyone else stays on the calendar year."
        control={(
          <select className="form-input" aria-label="Vacation leave year" value={draft.vacationYear} onChange={(e) => edit({ vacationYear: e.target.value })}
            style={{ fontSize: 13, width: 'auto' }}>
            <option value="calendar">Calendar Year</option>
            <option value="anniversary">Work Anniversary</option>
          </select>
        )} />
      <div className="nx-set-note">
        <Scale size={13} aria-hidden="true" />
        <span style={{ flex: 1, minWidth: 200 }}>
          {legal || 'Some states do not allow vacation to expire.'} What expires is written to each person&apos;s leave history - nothing is deleted. HR can preview the year end under People &gt; Time &gt; Time Off.
        </span>
        {company && cfg.hasOverride && !dirty && (
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(true)} style={{ fontSize: 12 }}>Use the Default</button>
        )}
        {dirty && (
          <>
            <button type="button" className="secondary-btn" disabled={busy} onClick={() => setDraft(pick(cfg))} style={{ fontSize: 12 }}>Discard</button>
            <button type="button" className="primary-btn" disabled={busy} onClick={() => save(false)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy && <Spinner size={12} />} Save
            </button>
          </>
        )}
      </div>
    </SettingCard>
  );
}

export function TimeOffApprovalSettings({ toastOk, toastErr, company = '', onOverride }) {
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setErr('');
    api.timeOffApprovalGet(company).then(setCfg).catch((e) => setErr(e?.message || 'Could not load the approval setting.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (cfg && company) onOverride?.(!!cfg.hasOverride); }, [cfg, company, onOverride]);
  if (err) return <div style={{ padding: 14 }}><ErrorBanner message={err} onRetry={load} /></div>;
  if (!cfg) return <div style={{ padding: 14 }}><SkeletonBlocks count={1} height={44} borderRadius={10} /></div>;
  async function save(body) {
    setBusy(true);
    try {
      const d = await api.timeOffApprovalSet(body, company);
      setCfg(d);
      toastOk?.(body.reset ? 'Back to the default.' : d.secondHr ? 'Time off now needs HR approval after the manager.' : 'The manager\'s approval is final again.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  return (
    <SettingCard>
      <SwitchRow id={`timeoff-second-hr-${company || 'default'}`} title="Second Approval By HR" disabled={busy}
        desc="After the manager approves, a time-off request waits for HR (the company's HR contact, an administrator or Full HR access) before it is approved. The employee sees Awaiting HR Approval. Off by default."
        checked={!!cfg.secondHr} onChange={(on) => save({ secondHr: on })} />
      {company && cfg.hasOverride && (
        <div className="nx-set-note">
          <span style={{ flex: 1 }}>This company has its own setting.</span>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => save({ secondHr: false, reset: true })} style={{ fontSize: 12 }}>Use the Default</button>
        </div>
      )}
    </SettingCard>
  );
}

// ── HR preview ──────────────────────────────────────────────────────────────

function BucketCell({ r, policy }) {
  if (!r) return <span>-</span>;
  if (r.skip) return <span style={{ color: 'var(--muted)' }}>{r.skip}</span>;
  const owed = Object.values(r.toWrite || {}).some((v) => Math.abs(v) >= 0.005);
  return (
    <span style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{fmtLeave(r.closing, policy)} left</span>
      <span>
        {r.carried > 0 ? `${fmtLeave(r.carried, policy)} carries` : 'Nothing carries'}
        {r.expired > 0 ? ` · ${fmtLeave(r.expired, policy)} expires` : ''}
      </span>
      {r.exempt && <span style={{ color: 'hsl(var(--color-blue))' }}>{r.note}</span>}
      {!r.projected && (
        <span style={{ color: owed ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))', fontWeight: 600 }}>
          {owed ? 'Not Applied Yet' : 'Applied'}
        </span>
      )}
    </span>
  );
}

export function LeaveYearEndPreview({ toastOk, toastErr }) {
  const [company, setCompany] = useState('');
  const [period, setPeriod] = useState('next');
  const [data, setData] = useState(undefined);   // undefined loading, false hidden (not HR / not set up)
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setErr(''); setData(undefined);
    api.leaveYearEndPreview(company, period).then((d) => { setData(d); if (!company && d.company) setCompany(d.company); })
      .catch((e) => {
        if (e?.status === 403 || e?.status === 400) setData(false);
        else setErr(e?.message || 'Could not load the year-end preview.');
      });
  }, [company, period]);
  useEffect(() => { load(); }, [load]);
  if (data === false) return null;

  const people = Array.isArray(data?.people) ? data.people : [];
  const companies = Array.isArray(data?.companies) ? data.companies : [];
  const owed = people.some((p) => Object.values(p.buckets || {}).some((r) => !r.skip && Object.values(r.toWrite || {}).some((v) => Math.abs(v) >= 0.005)));
  const closes = [...new Set(people.flatMap((p) => Object.values(p.buckets || {}).map((r) => r.closesOn).filter(Boolean)))].sort();
  async function apply() {
    const ok = await dialog.confirm('Write the year-end rows for everyone shown: what expires and what carries over. Nothing is deleted, and running it again changes nothing.',
      { title: 'Apply Year End', confirmText: 'Apply Year End' });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.leaveYearEndApply(company);
      toastOk?.(`Year end applied - ${r.rows} row${r.rows === 1 ? '' : 's'} written for ${r.people} ${r.people === 1 ? 'person' : 'people'}.${r.failed?.length ? ` ${r.failed.length} could not be read.` : ''}`);
      setData(r.preview ? { ...data, ...r.preview } : data);
    } catch (e) { toastErr?.(e?.message || 'Could not apply the year end.'); }
    setBusy(false);
  }
  const seg = (on) => ({ padding: '6px 12px', fontSize: 12.5, fontWeight: 700, borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--wk-font)',
    border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--wk-line2)'}`, background: on ? 'var(--wk-brand-tint)' : 'var(--card)', color: on ? 'var(--wk-brand)' : 'var(--muted)' });

  return (
    <section aria-label="Year End" style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '14px 16px', margin: '14px 0', boxShadow: 'var(--wk-shadow)', fontFamily: 'var(--wk-font)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="wkc-chip"><CalendarClock size={14} /></span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Year End</span>
        <span style={{ flex: 1 }} />
        {companies.length > 0 && (
          <select className="form-input" aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)}
            style={{ fontSize: 12.5, padding: '4px 8px', width: 'auto', maxWidth: '100%' }}>
            {data.canAll && <option value="">All Companies</option>}
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
          </select>
        )}
        <span role="group" aria-label="Which year end" style={{ display: 'inline-flex', gap: 6 }}>
          <button type="button" aria-pressed={period === 'next'} style={seg(period === 'next')} onClick={() => setPeriod('next')}>Next Year End</button>
          <button type="button" aria-pressed={period === 'last'} style={seg(period === 'last')} onClick={() => setPeriod('last')}>Last Year End</button>
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        {data?.settings ? `Vacation: ${modeLabel(data.settings.vacationMode)}. Sick: ${modeLabel(data.settings.sickMode)}. ` : ''}
        {period === 'next'
          ? 'Projected from today\'s balances - what is earned and used before the year ends changes it.'
          : 'What the last year end wrote, and anything still owed (a pay period finalized after it settles as a correction). The daily run applies it for 45 days after the year ends.'}
        {closes.length > 0 && ` Closes ${closes.map(day).join(', ')}.`} Change the rule in Settings &gt; Time &amp; Pay &gt; Leave Year-End.
      </div>
      {err ? <ErrorBanner message={err} onRetry={load} />
        : data === undefined ? <SkeletonBlocks count={3} height={30} borderRadius={8} />
        : people.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>Nobody with a balance here yet.</div>
        : (
          <>
            <div style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 10, padding: '8px 12px', background: 'var(--wk-hover)', fontSize: 12, color: 'var(--wk-dim)', fontWeight: 600 }}>
                <span>Person</span><span>Vacation</span><span>Sick / Personal</span>
              </div>
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                {people.map((p) => (
                  <div key={p.email} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 10, padding: '9px 12px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)', alignItems: 'start' }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                      <span>{p.policy?.name}{p.state ? ` · ${p.state}` : ''}</span>
                    </span>
                    <BucketCell r={p.buckets?.vacation} policy={p.policy} />
                    <BucketCell r={p.buckets?.sick} policy={p.policy} />
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
              <span style={{ flex: 1, minWidth: 200 }}>
                Expires: vacation {fmtLeave(data.totals?.vacation?.expired || 0)}, sick {fmtLeave(data.totals?.sick?.expired || 0)} across {people.length} {people.length === 1 ? 'person' : 'people'}.
              </span>
              {period === 'last' && owed && (
                <button type="button" className="primary-btn" disabled={busy} onClick={apply} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {busy && <Spinner size={12} />} Apply Year End
                </button>
              )}
            </div>
          </>
        )}
    </section>
  );
}
