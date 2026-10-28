// A company's Holiday Calendar (Settings > Companies with one company picked;
// Neil, Oct 29 2026). The effective calendar for a year, from
// GET /hr/entities/{id}/holiday-calendar: the holidays its policies bring
// (each with its policy chip) and the company's own. A policy holiday can be
// skipped, moved or retyped for this company alone - the row then says
// "Changed For This Company" and Reset To Policy puts it back. The company's
// own holidays come from a country list or are typed by hand, as before.
// Every row here shows on the company's employees' Calendar dashboard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Plus, RotateCcw, Trash2, EyeOff, CalendarDays } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate, formatWeekday } from '../lib/datetime';
import { SkeletonBlocks, ErrorBanner, Spinner } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import AnchoredMenu from '../components/AnchoredMenu';
import { DateField, Modal } from '../tasks/components';
import HolidaySourcePicker, { Chip, CountrySelect } from './HolidaySourcePicker';
import {
  HOLIDAY_TYPES, holidayTypeLabel, dateWithWeekday, realDateOf, yearOptions, plural, countryOfEntity, sourceLabel, daysBetween, HINT, SUBHEAD,
} from './holidayLib';

const SMALL_BTN = { background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', fontSize: 11.5, whiteSpace: 'nowrap' };
const CARD = { border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' };
const SECTION = { display: 'flex', flexDirection: 'column', gap: 8 };

// The hint on a row that sits on an observed day: the server's words, or
// built from the real date it sends.
function observedText(h) {
  const hint = h.observedHint;
  if (!hint) return '';
  if (typeof hint === 'string') return hint;
  const real = hint.actualDate || hint.date;
  return real ? `${h.name} is ${formatDate(real)}, a ${formatWeekday(real)} - this company takes ${formatDate(h.date)}.` : '';
}

export default function CompanyHolidayCalendar({ entity, toastOk, toastErr }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [busy, setBusy] = useState('');
  const [dateEdit, setDateEdit] = useState(null);   // { id, value } while a row's date is being changed

  // The calendar on screen belongs to one company and year (`key`); another
  // year shows the skeleton until its own answer arrives.
  const calKey = `${entity.id}|${year}`;
  const [loaded, setLoaded] = useState({ key: '', data: null, error: '' });
  const load = useCallback(() => {
    const key = `${entity.id}|${year}`;
    return api.getHolidayCalendar(entity.id, year)
      .then(r => setLoaded({ key, data: r || { policies: [], holidays: [], skipped: [], available: [] }, error: '' }))
      .catch(e => {
        const error = e?.message || 'The holiday calendar could not be loaded.';
        setLoaded(l => (l.key === key ? { ...l, error } : { key, data: null, error }));
      });
  }, [entity.id, year]);
  useEffect(() => { load(); }, [load]);
  const cal = loaded.key === calKey ? loaded.data : null;
  const error = loaded.key === calKey ? loaded.error : '';
  const setCal = (data) => setLoaded({ key: calKey, data, error: '' });

  // Run one change; a route that answers with the calendar sets it, the
  // others re-read it. Resolves true when the change went through.
  async function run(tag, fn, fail) {
    if (busy) return false;
    setBusy(tag);
    let ok = false;
    try {
      const res = await fn();
      const next = res?.calendar || res;   // PATCH answers the row with the calendar beside it
      if (next && Array.isArray(next.holidays) && Array.isArray(next.policies)) setCal(next);
      else await load();
      ok = true;
    } catch (e) { toastErr?.(e?.message || fail); }
    setBusy('');
    return ok;
  }

  const policies = cal?.policies || [];
  const holidays = (cal?.holidays || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const fromPolicies = holidays.filter(h => h.source === 'policy');
  const own = holidays.filter(h => h.source !== 'policy');
  const skipped = cal?.skipped || [];
  const available = cal?.available || [];

  async function unassign(p) {
    if (!await dialog.confirm(`Its holidays come off ${entity.name}'s calendar. Holidays changed for this company stay as its own.`,
      { title: `Unassign ${p.name}?`, confirmText: 'Unassign', danger: true })) return;
    run(`unassign-${p.id}`, () => api.unassignHolidayPolicy(entity.id, p.id, year), 'Could not unassign the policy.')
      .then(ok => ok && toastOk?.(`${p.name} unassigned.`));
  }
  // Assign A Policy. When its holidays would land beside ones already on the
  // calendar the server answers 409 with them: the admin ticks the company's
  // own ones to replace, keeps both, or cancels (Oct 29 2026 review).
  const [clash, setClash] = useState(null);   // { policy, clashes, picked: [ids] }
  async function assign(pid, opts) {
    const p = available.find(a => a.id === pid) || (clash?.policy?.id === pid ? clash.policy : null);
    if (!p || busy) return;
    setBusy(`assign-${pid}`);
    try {
      const res = opts ? await api.assignHolidayPolicy(entity.id, pid, year, opts) : await api.assignHolidayPolicy(entity.id, pid, year);
      if (res && Array.isArray(res.holidays) && Array.isArray(res.policies)) setCal(res); else await load();
      setClash(null);
      const n = opts?.replace?.length || 0;
      toastOk?.(`${p.name} assigned to ${entity.name}.${n ? ` Replaced ${plural(n, 'holiday')}.` : ''}`);
    } catch (e) {
      if (e?.status === 409 && Array.isArray(e?.body?.clashes)) setClash({ policy: e.body.policy || p, clashes: e.body.clashes, picked: [] });
      else toastErr?.(e?.message || 'Could not assign the policy.');
    }
    setBusy('');
  }
  const togglePick = (id) => setClash(c => ({ ...c, picked: c.picked.includes(id) ? c.picked.filter(x => x !== id) : [...c.picked, id] }));

  const skip = (h, on) => run(`skip-${h.policyId}-${h.policyKey || h.key}`,
    () => api.skipPolicyHoliday(entity.id, h.policyId, h.policyKey || h.key, on, year), 'Could not update the holiday.');
  // Skip on a holiday this company changed asks first; the change is kept
  // and Restore brings it back.
  async function skipRow(h) {
    if (h.overridden && !await dialog.confirm(
      `${h.name} was changed for ${entity.name}. Skip it anyway? Restore brings it back with the change.`,
      { title: 'Skip A Changed Holiday?', confirmText: 'Skip Holiday', cancelText: 'Cancel' })) return;
    skip(h, true);
  }
  const changeType = (h, type) => run(`type-${h.id}`, () => api.updateCompanyHoliday(entity.id, h.id, { type }, year), 'Could not change the type.');
  const saveDate = () => {
    if (!dateEdit?.value) return;
    const { id, value } = dateEdit;
    run(`date-${id}`, () => api.updateCompanyHoliday(entity.id, id, { date: value }, year), 'Could not change the date.')
      .then(ok => ok && setDateEdit(null));
  };
  const reset = (h) => run(`reset-${h.id}`, () => api.resetCompanyHoliday(entity.id, h.id, year), 'Could not reset the holiday.');
  async function remove(h) {
    if (!await dialog.confirm(`Remove ${h.name} (${formatDate(h.date)}) from ${entity.name}'s calendar?`, { title: 'Remove Holiday', confirmText: 'Remove', danger: true })) return;
    run(`remove-${h.id}`, () => api.deleteCompanyHoliday(entity.id, h.id), 'Could not remove the holiday.');
  }

  // ── Add this company's own ────────────────────────────────────────────────
  const [country, setCountry] = useState(countryOfEntity(entity));
  const hasCountry = (h, cc) => (h.countries || []).includes(cc);
  // The company's own copy of a source holiday: same name and country, on
  // its real date or a day it was moved to (the add route keeps no real date).
  const ownFor = (s) => own.find(h => h.name === s.name && hasCountry(h, country)
    && (realDateOf(h) === s.date || (h.source === 'public' && Math.abs(daysBetween(h.date, s.date)) <= 2))) || null;
  const fromPolicy = (s) => {
    const hit = fromPolicies.find(h => h.name === s.name && realDateOf(h) === s.date && hasCountry(h, country));
    return hit ? `Already from ${hit.policyName}` : '';
  };
  const addPublic = (s, day) => run(`add-${s.name}`, () => api.createCompanyHoliday(entity.id, {
    date: day, name: s.name, source: 'public', country_code: country, type: s.suggestedType || 'mandatory',
    actual_date: day !== s.date ? s.date : '',
  }), 'Could not add the holiday.');
  const removePublic = (_s, row) => run(`remove-${row.id}`, () => api.deleteCompanyHoliday(entity.id, row.id, country), 'Could not remove the holiday.');
  const movePublic = (_s, row, day) => run(`date-${row.id}`, () => api.updateCompanyHoliday(entity.id, row.id, { date: day }, year), 'Could not change the date.');

  const [manualDate, setManualDate] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualType, setManualType] = useState('mandatory');
  const addManual = () => {
    if (!manualDate || !manualName.trim()) return;
    run('manual', () => api.createCompanyHoliday(entity.id, { date: manualDate, name: manualName.trim(), source: 'manual', type: manualType }), 'Could not add the holiday.')
      .then(ok => { if (ok) { setManualDate(''); setManualName(''); setManualType('mandatory'); } });
  };

  // ── Export (Pranshu, Sep 22: one or more years, up to 15 back) ──────────────
  const exportRef = useRef(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportYears, setExportYears] = useState([]);
  const [exporting, setExporting] = useState(false);
  const exportOptions = Array.from({ length: 21 }, (_, i) => thisYear + 5 - i);
  const toggleExportYear = (y) => setExportYears(ys => (ys.includes(y) ? ys.filter(x => x !== y) : [...ys, y]));
  async function exportCsv() {
    if (!exportYears.length || exporting) return;
    setExporting(true);
    try {
      const sorted = exportYears.slice().sort((a, b) => a - b);
      const cals = await Promise.all(sorted.map(y => api.getHolidayCalendar(entity.id, y).catch(() => ({ holidays: [] }))));
      const rows = cals.flatMap(c => c?.holidays || []).sort((a, b) => a.date.localeCompare(b.date));
      const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [
        ['Date', 'Weekday', 'Holiday', 'Type', 'Source', 'Countries'],
        ...rows.map(h => [formatDate(h.date), formatWeekday(h.date), h.name, holidayTypeLabel(h.type), sourceLabel(h), (h.countries || []).join('/')]),
      ].map(r => r.map(esc).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([lines], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      const label = sorted.length > 1 ? `${sorted[0]}-${sorted[sorted.length - 1]}` : `${sorted[0]}`;
      a.href = url;
      a.download = `${(entity.name || 'company').replace(/[^\w-]+/g, '-')}-holidays-${label}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
      toastOk?.(`Exported ${plural(rows.length, 'holiday')}.`);
    } catch (e) { toastErr?.(e?.message || 'Could not export the holidays.'); }
    setExporting(false);
  }

  // ── One calendar row ────────────────────────────────────────────────────
  function renderRow(h) {
    const isPolicy = h.source === 'policy';
    const editing = dateEdit?.id === h.id;
    const hint = observedText(h);
    return (
      <div key={h.id} style={{ borderBottom: '1px solid var(--line)', padding: '9px 14px', display: 'flex', flexDirection: 'column', gap: 6 }} data-holiday={h.name}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
          <div style={{ minWidth: 150, display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontWeight: 700 }}>{formatDate(h.date)}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.weekday || formatWeekday(h.date)}</span>
          </div>
          <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{h.name}</span>
              <Chip title={isPolicy ? 'From this policy' : undefined}>{sourceLabel(h)}</Chip>
              {h.overridden && <StatusLabel label="Changed For This Company" color="#ea580c" size="sm" />}
              {(h.countries || []).map(c => <Chip key={c}>{c}</Chip>)}
            </span>
            {h.actualDate && h.actualDate !== h.date && !h.yearNote && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Holiday is {dateWithWeekday(h.actualDate)}</span>
            )}
            {h.yearNote &&<span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.yearNote}</span>}
            {h.sameDayNote && <span role="note" style={{ fontSize: 11, color: '#b45309' }}>{h.sameDayNote}</span>}
            {hint && (
              <span style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {hint}
                <button type="button" style={{ ...SMALL_BTN, padding: '1px 7px', fontSize: 11 }} onClick={() => setDateEdit({ id: h.id, value: h.date })}>Change Date</button>
              </span>
            )}
          </div>
          <select className="form-input" aria-label={`Type for ${h.name}`} value={h.type || 'mandatory'} disabled={!!busy}
            onChange={e => changeType(h, e.target.value)} style={{ width: 118, fontSize: 11.5, padding: '4px 8px' }} title="Change Type">
            {Object.entries(HOLIDAY_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {!hint && (
              <button type="button" style={SMALL_BTN} onClick={() => setDateEdit(editing ? null : { id: h.id, value: h.date })} aria-label={`Change Date of ${h.name}`}>
                <CalendarDays size={12} /> Change Date
              </button>
            )}
            {isPolicy && h.overridden && (
              <button type="button" style={SMALL_BTN} onClick={() => reset(h)} disabled={!!busy}><RotateCcw size={12} /> Reset To Policy</button>
            )}
            {isPolicy ? (
              <button type="button" style={SMALL_BTN} onClick={() => skipRow(h)} disabled={!!busy} aria-label={`Skip ${h.name} For This Company`}>
                <EyeOff size={12} /> Skip For This Company
              </button>
            ) : (
              <button type="button" style={{ ...SMALL_BTN, color: 'hsl(var(--color-red))' }} onClick={() => remove(h)} disabled={!!busy} aria-label={`Remove ${h.name}`}>
                <Trash2 size={12} /> Remove
              </button>
            )}
          </div>
        </div>
        {editing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: 150 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>New date for this company</span>
            <span className="form-input" style={{ width: 160, display: 'inline-flex', alignItems: 'center' }}>
              <DateField value={dateEdit.value} onChange={v => setDateEdit({ id: h.id, value: v })} title="Change Date" style={{ width: '100%' }} />
            </span>
            <button className="primary-btn" style={{ fontSize: 12, padding: '5px 12px' }} onClick={saveDate} disabled={!dateEdit.value || dateEdit.value === h.date || !!busy}>Save Date</button>
            <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setDateEdit(null)}>Cancel</button>
          </div>
        )}
      </div>
    );
  }

  if (error && !cal) return <div style={{ padding: '18px 4px' }}><ErrorBanner message={error} onRetry={load} /></div>;

  return (
    <div style={{ padding: '18px 4px', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <p style={HINT}>Every holiday below shows on {entity.name}'s employees' Calendar dashboard and their Time Sheets.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="form-input" aria-label="Year" value={year} onChange={e => { setYear(Number(e.target.value)); setDateEdit(null); }} style={{ width: 100 }}>
            {yearOptions([], 2).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button ref={exportRef} className="secondary-btn" onClick={() => setExportOpen(v => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            title="Export this company's holidays as a CSV file, for one or more years">
            <Download size={12} /> Export Holidays
          </button>
          <AnchoredMenu anchorRef={exportRef} open={exportOpen} onClose={() => setExportOpen(false)} role="dialog" align="end" minWidth={180}
            style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 8 }}>Export Years</div>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {exportOptions.map(y => (
                <label key={y} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 12.5 }}>
                  <input type="checkbox" checked={exportYears.includes(y)} onChange={() => toggleExportYear(y)} /> {y}
                </label>
              ))}
            </div>
            <button className="primary-btn" onClick={exportCsv} disabled={!exportYears.length || exporting} style={{ width: '100%', marginTop: 10, fontSize: 12, padding: '6px 0' }}>
              {exporting ? 'Exporting…' : `Export${exportYears.length ? ` ${plural(exportYears.length, 'Year')}` : ''}`}
            </button>
          </AnchoredMenu>
        </div>
      </div>

      {!cal ? <SkeletonBlocks count={4} height={48} borderRadius={10} /> : (
        <>
          <section style={SECTION} aria-label="Policies For This Company">
            <h4 style={SUBHEAD}>Policies For This Company</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {policies.length === 0 && <span style={HINT}>No policy yet - assign one, or add this company's own holidays below.</span>}
              {policies.map(p => (
                <Chip key={p.id} onRemove={() => unassign(p)} removeLabel={`Unassign ${p.name}`}
                  title={p.skipped?.length ? `${plural(p.skipped.length, 'holiday')} skipped for this company` : undefined}>
                  {p.name}
                </Chip>
              ))}
              {available.length > 0 && (
                <select className="form-input" aria-label="Assign A Policy" value="" disabled={!!busy}
                  onChange={e => assign(e.target.value)} style={{ width: 220, fontSize: 12 }}>
                  <option value="">Assign A Policy…</option>
                  {available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
              {busy.startsWith('assign') && <Spinner size={13} />}
            </div>
          </section>

          <section style={SECTION} aria-label="From Policies">
            <h4 style={SUBHEAD}>From Policies ({fromPolicies.length})</h4>
            <div style={CARD}>
              {fromPolicies.length === 0
                ? <p style={{ ...HINT, padding: 14 }}>No policy holidays in {year}.</p>
                : fromPolicies.map(renderRow)}
            </div>
          </section>

          <section style={SECTION} aria-label="This Company's Own">
            <h4 style={SUBHEAD}>This Company's Own ({own.length})</h4>
            <div style={CARD}>
              {own.length === 0
                ? <p style={{ ...HINT, padding: 14 }}>No holidays of {entity.name}'s own in {year}.</p>
                : own.map(renderRow)}
            </div>
          </section>

          {skipped.length > 0 && (
            <section style={SECTION} aria-label="Skipped For This Company">
              <h4 style={{ ...SUBHEAD, color: 'var(--muted)' }}>Skipped For This Company ({skipped.length})</h4>
              <div style={{ ...CARD, opacity: 0.75 }}>
                {skipped.map(s => (
                  <div key={`${s.policyId}-${s.key}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--line)', fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 150 }}>{dateWithWeekday(s.date)}</span>
                    <span style={{ flex: '1 1 200px', display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ textDecoration: 'line-through' }}>{s.name}</span>
                      {s.yearNote && <span style={{ fontSize: 11 }}>{s.yearNote}</span>}
                    </span>
                    {s.changed && <StatusLabel label="Changed For This Company" color="#ea580c" size="sm" title="Restore brings it back with this company's change" />}
                    <Chip>{s.policyName}</Chip>
                    <button type="button" style={SMALL_BTN} disabled={!!busy} onClick={() => skip({ policyId: s.policyId, policyKey: s.key }, false)} aria-label={`Restore ${s.name}`}>
                      <RotateCcw size={12} /> Restore
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section style={SECTION} aria-label="Add This Company's Own">
            <h4 style={SUBHEAD}>Add This Company's Own</h4>
            <p style={HINT}>Holidays only {entity.name} gives. Tick them from a country's list for {year}, or add one by hand.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <CountrySelect value={country} onChange={setCountry} />
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              <HolidaySourcePicker key={`${country}-${year}`} country={country} year={year} rule="keep" disabled={!!busy}
                chosen={ownFor} blocked={fromPolicy} onAdd={addPublic} onRemove={removePublic} onMove={movePublic} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="form-input" style={{ width: 170, display: 'inline-flex', alignItems: 'center' }}>
                <DateField value={manualDate} onChange={setManualDate} placeholder="Pick a date" title="Holiday date" style={{ width: '100%' }} />
              </span>
              <input className="form-input" aria-label="New holiday name" placeholder="e.g. Founders' Day" value={manualName}
                onChange={e => setManualName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addManual(); }} style={{ flex: '1 1 180px' }} />
              <select className="form-input" aria-label="New holiday type" value={manualType} onChange={e => setManualType(e.target.value)} style={{ width: 120 }}>
                {Object.entries(HOLIDAY_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <button className="primary-btn" onClick={addManual} disabled={!manualDate || !manualName.trim() || !!busy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Plus size={13} /> Add Holiday
              </button>
            </div>
          </section>
        </>
      )}
      {clash && (
        <Modal title={`Assign ${clash.policy?.name || 'Policy'}`} onClose={() => setClash(null)}
          footer={(
            <>
              <button className="secondary-btn" onClick={() => setClash(null)} disabled={!!busy}>Cancel</button>
              <button className="secondary-btn" onClick={() => assign(clash.policy.id, { confirm: true })} disabled={!!busy}>Keep Both</button>
              <button className="primary-btn" onClick={() => assign(clash.policy.id, { replace: clash.picked })}
                disabled={!!busy || clash.picked.length === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy.startsWith('assign') && <Spinner size={12} />}
                {clash.picked.length ? `Replace ${plural(clash.picked.length, 'Holiday')} With The Policy's` : "Replace With The Policy's"}
              </button>
            </>
          )}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
            <p style={HINT}>These holidays are already on {entity.name}'s calendar. Tick the company's own ones to replace with the policy's, or keep both. Another policy's holidays stay - unassign that policy to remove them.</p>
            <div className="nx-fill" style={{ ...CARD, overflowY: 'auto' }} role="list" aria-label="Already On This Calendar">
              {clash.clashes.map(c => (
                <label key={c.id} role="listitem" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--line)', fontSize: 12.5, cursor: c.replaceable ? 'pointer' : 'default' }}>
                  <input type="checkbox" aria-label={`Replace ${c.name}`} checked={clash.picked.includes(c.id)} disabled={!c.replaceable || !!busy}
                    onChange={() => togglePick(c.id)} style={{ marginTop: 2 }} />
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                      <span style={{ color: 'var(--muted)' }}>{dateWithWeekday(c.date)}</span>
                      <Chip>{c.with}</Chip>
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {`The policy brings ${c.holiday?.name} on ${formatDate(c.holiday?.date)}`}{c.note ? ` - ${c.note}` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
