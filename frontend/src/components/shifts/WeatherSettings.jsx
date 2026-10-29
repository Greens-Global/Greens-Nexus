import { useEffect, useRef, useState } from 'react';
import { CloudRain, Check, Play, Building2 } from 'lucide-react';
import { api } from '../../api';
import { useGroupDirty } from '../../lib/groupDirty';
import SaveRow from '../../components/SaveRow';
import AsyncSection, { Spinner, SkeletonBlocks } from '../AsyncState';
import { formatDateTime } from '../../lib/datetime';

// Settings > Global Settings > Shifts > Weather Alerts (Weather Call,
// Oct 2026). The per-company switch the feature ships behind, the rain
// thresholds (deliberately high by default - Neil: "it must be major"),
// quiet hours, the heads-up Teams line, and Check Now. Registered in
// views/AdminConsole.jsx GLOBAL_SECTIONS as 'shift-weather'.

const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
const ROW = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 10, flexWrap: 'wrap' };
const NUM = { width: '100%', fontSize: 13 };
const FIELDS = [
  ['majorChance', 'Major: chance of rain (%)', 'Together with the inches below. 70 means an hour at 70% or more.'],
  ['majorInches', 'Major: rain over the shift (in)', 'Expected rainfall across the scheduled hours.'],
  ['anyChanceInches', 'Major at any chance (in)', 'This much rain is major whatever the chance.'],
  ['stormChance', 'Thunderstorm chance (%)', 'A thunderstorm hour at this chance is major.'],
  ['headsUpChance', 'Heads-up: chance of rain (%)', 'Below major: an icon on the schedule, no bell.'],
  ['headsUpInches', 'Heads-up: rain over the shift (in)', ''],
];

// `company` (Settings' scope picker, Oct 23): only that company's switch and
// readiness; the thresholds, quiet hours and Teams line are for every company.
export default function WeatherSettingsPanel({ toastOk, toastErr, company = '' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [tick, setTick] = useState(0);
  const baseline = useRef(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api.weatherWatchSettings().then((r) => {
      if (!live) return;
      setData(r);
      const f = { ...r.config, companies: Object.fromEntries((r.companies || []).map((c) => [c.id, !!c.enabled])) };
      setForm(f);
      baseline.current = JSON.stringify(f);
    }).catch((e) => { if (live) setError(e?.message || 'Could not load the weather settings.'); });
    return () => { live = false; };
  }, [tick]);
  const reload = () => setTick((t) => t + 1);
  const dirty = !!form && baseline.current !== null && JSON.stringify(form) !== baseline.current;

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const r = await api.weatherWatchSettingsSave(form);
      setData(r);
      const f = { ...r.config, companies: Object.fromEntries((r.companies || []).map((c) => [c.id, !!c.enabled])) };
      setForm(f);
      baseline.current = JSON.stringify(f);
      toastOk?.('Weather alert settings saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save the weather settings.'); }
    setBusy(false);
  }
  async function checkNow() {
    setChecking(true);
    try {
      const s = await api.weatherWatchScan();
      const bits = [`${s.groups} group${s.groups === 1 ? '' : 's'}`, `${s.days} day${s.days === 1 ? '' : 's'} with shifts`];
      if (s.advisories) bits.push(`${s.advisories} advisor${s.advisories === 1 ? 'y' : 'ies'} sent`);
      if (s.headsUp) bits.push(`${s.headsUp} heads-up`);
      if (s.held) bits.push(`${s.held} held for quiet hours`);
      if (s.providerDown) bits.push('forecast unavailable for some sites');
      toastOk?.(s.groups ? `Checked ${bits.join(', ')}.` : 'Nothing to check - no company is switched on, or no group is ready.');
      reload();
    } catch (e) { toastErr?.(e?.message || 'The check could not run.'); }
    setChecking(false);
  }
  useGroupDirty(dirty);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const num = (k) => (e) => set(k, e.target.value === '' ? '' : Number(e.target.value));

  return (
    <AsyncSection loading={!data && !error} error={!!error} onRetry={reload} errorMessage="The weather settings could not be loaded right now." skeleton={<SkeletonBlocks count={3} height={56} borderRadius={10} />}>
      {form && (
        <div style={{ fontFamily: 'Inter,sans-serif', display: 'grid', gap: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Every half hour Nexus checks the forecast for each watched group's work site over the next two days. Major rain during scheduled hours sends a priority alert to the group's weather deciders and the company's managers so they can make the weather call. Nexus never cancels work by itself.
          </div>

          <div>
            <div style={{ ...LBL, display: 'flex', alignItems: 'center', gap: 5 }}><Building2 size={12} /> Companies - the watch runs only for the companies switched on</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {(data.companies || []).filter((c) => !company || c.id === company).map((c) => (
                <label key={c.id} style={ROW}>
                  <input type="checkbox" checked={!!form.companies[c.id]} onChange={(e) => set('companies', { ...form.companies, [c.id]: e.target.checked })} aria-label={`Watch the weather for ${c.name}`} />
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 140 }}>{c.name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>
                    {c.groupsReady.length ? `${c.groupsReady.length} group${c.groupsReady.length === 1 ? '' : 's'} ready: ${c.groupsReady.join(', ')}` : 'No group ready'}
                    {c.groupsNotReady.length ? ` · not ready (no located site or alerts off): ${c.groupsNotReady.join(', ')}` : ''}
                  </span>
                </label>
              ))}
              {!(data.companies || []).length && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No companies set up yet.</div>}
              {!!company && !(data.companies || []).some((c) => c.id === company) && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>This company has no groups to watch yet.</div>}
              {/* Weather by department (Neil, 10/29/2026): who the weather applies to. */}
              <div data-weather-departments="" style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                Applies to people in departments with Weather Calls on: {(data.companies || []).filter((c) => !company || c.id === company)
                  .map((c) => `${c.name}: ${(c.weatherDepartments || []).join(', ') || 'none'}`).join('; ') || 'none'}.{' '}
                <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'companies' } }))}
                  style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'var(--wk-brand)', fontWeight: 600, cursor: 'pointer' }}>
                  Settings &gt; Companies
                </button>
              </div>
              {!company && data.untaggedGroups?.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'hsl(var(--color-orange))' }}>
                  Groups whose members have no company, so no switch covers them: {data.untaggedGroups.join(', ')}.
                </div>
              )}
            </div>
          </div>

          {company ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>What counts as major rain, the quiet hours and the Teams line are set for every company.</div>
          ) : (<>
          <div>
            <div style={LBL}>Thresholds - measured over the hours the group is scheduled, not the whole day</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              {FIELDS.map(([k, label, hint]) => (
                <label key={k}><div style={LBL}>{label}</div>
                  <input type="number" className="form-input" step={k.endsWith('Inches') ? 0.05 : 1} min={0} max={k.endsWith('Inches') ? 20 : 100} value={form[k]} onChange={num(k)} aria-label={label} style={NUM} />
                  {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{hint}</div>}
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <label><div style={LBL}>Quiet hours start (site time)</div>
              <input type="time" className="form-input" value={form.quietStart} onChange={(e) => set('quietStart', e.target.value)} aria-label="Quiet hours start" style={NUM} />
            </label>
            <label><div style={LBL}>Quiet hours end</div>
              <input type="time" className="form-input" value={form.quietEnd} onChange={(e) => set('quietEnd', e.target.value)} aria-label="Quiet hours end" style={NUM} />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Advisories wait until the morning. A National Weather Service warning never waits.</div>
            </label>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.headsUpTeams} onChange={(e) => set('headsUpTeams', e.target.checked)} aria-label="Post a quiet Teams line for a heads-up" />
              Post one quiet line in the group's Teams chat for a heads-up day (no bell)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!form.smsDefault} onChange={(e) => set('smsDefault', e.target.checked)} aria-label="Text the crew by default when a weather call is made" />
              Text the crew by default when a weather call is made (each person can turn their own texts off)
            </label>
          </div>
          </>)}

          <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}><CloudRain size={11} /> Forecast by Open-Meteo. Warnings by the National Weather Service (US sites).</div>
          <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={() => setForm(JSON.parse(baseline.current))} style={{ marginTop: 4 }}
            note={data.lastAdvisoryAt ? `Last notice sent ${formatDateTime(data.lastAdvisoryAt)}.` : 'No notice has been sent yet.'}>
            <button type="button" className="secondary-btn" onClick={checkNow} disabled={checking || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {checking ? <Spinner size={13} /> : <Play size={13} />} Check Now
            </button>
          </SaveRow>
        </div>
      )}
    </AsyncSection>
  );
}
