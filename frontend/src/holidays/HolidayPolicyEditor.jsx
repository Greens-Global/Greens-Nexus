// The holiday policy editor (Neil, Oct 29 2026): a named set of holidays, the
// companies it applies to and what happens when a holiday falls on a
// weekend. Works on a local draft; Save asks the server what it would change
// in each company (POST /preview), says so, then saves - the server syncs
// every assigned company's calendar in the same transaction. A policy owned
// by another company opens read-only (canEdit false).
import { useEffect, useMemo, useState } from 'react';
import { Copy, Plus, X } from 'lucide-react';
import { Modal, DateField, ChipMultiSelect } from '../tasks/components';
import { Spinner } from '../components/AsyncState';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import HolidaySourcePicker, { Chip, TentativeChip, CountrySelect } from './HolidaySourcePicker';
import {
  WEEKEND_RULES, WEEKEND_RULE_HINT, HOLIDAY_TYPES, rowFromSource, findSourceRow, realDateOf, yearOf, dateWithWeekday,
  holidayKey, yearOptions, previewLine, conflictLines, plural, syncCount, countryOfEntity, HINT, SUBHEAD,
  redate, applyRuleToAll, sameDayNotes, otherCompaniesText, weekendRuleLabel,
} from './holidayLib';
import { formatDate } from '../lib/datetime';

const FIELD = { display: 'flex', flexDirection: 'column', gap: 6 };
const LABEL = { fontSize: 12, fontWeight: 700, color: 'var(--muted)' };

export default function HolidayPolicyEditor({ policy = null, entities: entitiesProp = null, onClose, onSaved, toastOk, toastErr }) {
  const isNew = !policy?.id;
  const readOnly = !isNew && policy.canEdit === false;
  const initial = useMemo(() => ({
    name: policy?.name || '',
    description: policy?.description || '',
    weekendRule: policy?.weekendRule || 'keep',
    companies: (policy?.companies || []).map(c => c.id),
    holidays: policy?.holidays || [],
  }), [policy]);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [weekendRule, setWeekendRule] = useState(initial.weekendRule);
  const [companies, setCompanies] = useState(initial.companies);
  const [draft, setDraft] = useState(initial.holidays);
  const [saving, setSaving] = useState(false);

  // Companies: the shell's list when it has one, else our own fetch.
  const [fetched, setFetched] = useState([]);
  const haveEntities = Array.isArray(entitiesProp) && entitiesProp.length > 0;
  useEffect(() => {
    if (haveEntities) return undefined;
    let live = true;
    api.getEntities().then(r => { if (live) setFetched(r || []); }).catch(() => {});
    return () => { live = false; };
  }, [haveEntities]);
  const entities = haveEntities ? entitiesProp : fetched;
  const options = useMemo(() => {
    const opts = entities.map(e => ({ id: e.id, label: e.name }));
    // A company the list does not have (no access to it) still shows by name.
    for (const c of policy?.companies || []) if (!opts.some(o => o.id === c.id)) opts.push({ id: c.id, label: c.name });
    return opts;
  }, [entities, policy]);
  const ownerName = !isNew && policy.companyId ? (entities.find(e => e.id === policy.companyId)?.name || '') : '';

  // The year on screen and the country its list comes from (the first
  // assigned company's country, else the United States, until picked).
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(() => {
    const ys = (policy?.years || []).map(Number).filter(y => y >= thisYear);
    return ys.length ? Math.min(...ys) : thisYear;
  });
  const [countryPicked, setCountryPicked] = useState('');
  const firstCompany = entities.find(e => e.id === companies[0]);
  const country = countryPicked || countryOfEntity(firstCompany);
  const years = yearOptions([...(policy?.years || []), ...draft.map(h => yearOf(realDateOf(h)))]);

  const rowsForYear = draft
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => yearOf(realDateOf(h)) === year)
    .sort((a, b) => a.h.date.localeCompare(b.h.date));

  // ── Draft edits ──────────────────────────────────────────────────────────
  const update = (i, patch) => setDraft(d => d.map((h, x) => (x === i ? { ...h, ...patch } : h)));
  // A plain date edit changes the day only; a list holiday on a weekend keeps
  // its real date beside it (redate).
  const changeDate = (i, day) => setDraft(d => d.map((h, x) => (x === i ? redate(h, day) : h)));
  const removeAt = (i) => setDraft(d => d.filter((_, x) => x !== i));
  const addFromSource = (s, day) => setDraft(d => [...d, rowFromSource(s, country, day)]);
  const removeSource = (_s, row) => setDraft(d => d.filter(h => h !== row));
  const moveSource = (s, row, day) => setDraft(d => d.map(h => (h === row ? { ...h, date: day, actualDate: day !== s.date ? s.date : '' } : h)));

  const [manualDate, setManualDate] = useState('');
  const [manualName, setManualName] = useState('');
  const addManual = () => {
    if (!manualDate || !manualName.trim()) return;
    setDraft(d => [...d, {
      key: holidayKey(country, manualName.trim(), manualDate), date: manualDate, actualDate: '', name: manualName.trim(),
      type: 'mandatory', countries: [country], scope: 'manual', tentative: false, source: 'manual',
    }]);
    if (yearOf(manualDate) !== year) setYear(yearOf(manualDate));
    setManualDate(''); setManualName('');
  };

  // Copy To <next year>: the server rebuilds the same holidays for the next
  // year from the sources (rule applied); nothing is saved until Save.
  const [copying, setCopying] = useState(false);
  const [unmatched, setUnmatched] = useState(null);
  async function copyForward() {
    if (isNew || copying) return;
    setCopying(true); setUnmatched(null);
    try {
      const res = await api.copyHolidayPolicyYear(policy.id, year, year + 1);
      const incoming = res?.holidays || [];
      const have = new Set(draft.map(h => h.key).filter(Boolean));
      const fresh = incoming.filter(h => !have.has(h.key) && !draft.some(x => x.name === h.name && realDateOf(x) === realDateOf(h)));
      setDraft(d => [...d, ...fresh]);
      setUnmatched({ year: year + 1, names: res?.unmatched || [], notObserved: res?.notObserved || [] });
      setYear(year + 1);
      toastOk?.(`Copied ${plural(fresh.length, 'holiday')} to ${year + 1} - Save to keep them.`);
    } catch (e) { toastErr?.(e?.message || 'Could not copy the holidays.'); }
    setCopying(false);
  }

  // Apply To Existing Holidays: the weekend rule re-dates every holiday
  // picked from a list, from its real date - shown first, kept only on OK.
  async function applyRuleToExisting() {
    const { next, changes, removed } = applyRuleToAll(draft, weekendRule);
    if (!changes.length && !removed.length) {
      toastOk?.(`Every holiday already follows ${weekendRuleLabel(weekendRule)}.`);
      return;
    }
    const lines = [
      ...changes.map(c => `${c.name}: ${formatDate(c.from)} to ${formatDate(c.to)}`),
      ...removed.map(n => `${n}: no day off`),
    ];
    const ok = await dialog.confirm(`${lines.join('.\n')}.\n\nNothing is saved until you save the policy.`, {
      title: 'Apply To Existing Holidays', confirmText: `Change ${plural(lines.length, 'Holiday')}`, cancelText: 'Cancel',
    });
    if (ok) setDraft(next);
  }

  // Holidays of the draft that share their day off (shown on the row).
  const sameDay = useMemo(() => sameDayNotes(draft), [draft]);

  const body = () => ({ name: name.trim(), description: description.trim(), weekendRule, holidays: draft, companies });
  const dirty = JSON.stringify({ name, description, weekendRule, companies, holidays: draft }) !== JSON.stringify(initial);

  // Save: what it changes first, then the save itself.
  async function save() {
    if (readOnly || saving) return false;
    if (!name.trim()) { toastErr?.('Give the policy a name.'); return false; }
    setSaving(true);
    try {
      const data = body();
      // A policy not saved yet previews as 'new'.
      const preview = await api.previewHolidayPolicy(isNew ? 'new' : policy.id, data);
      const list = preview?.companies || [];
      const others = Number(preview?.otherCompanies) || 0;
      if (list.length || others) {
        const clashes = conflictLines(list);
        // One line per shared day ("Christmas Day 12/24/2027: Same day as Christmas Eve - Christmas Day wins").
        const seenDays = new Set();
        const days = (preview?.sameDay || []).filter(s => !seenDays.has(s.date) && seenDays.add(s.date))
          .map(s => `${s.name} ${formatDate(s.date)}: ${s.note}`);
        const named = list.length ? `${plural(list.length, 'company', 'companies')}: ${list.map(previewLine).join(', ')}` : '';
        const updates = named ? `${named}${otherCompaniesText(others)}` : plural(others, 'other company', 'other companies');
        const message = `This updates ${updates}.`
          + (clashes.length ? `\n\n${clashes.join('.\n')}.` : '')
          + (days.length ? `\n\n${days.join('.\n')}.` : '');
        if (!await dialog.confirm(message, { title: 'Save Holiday Policy', confirmText: 'Save', cancelText: 'Cancel' })) {
          setSaving(false);
          return false;
        }
      }
      // A new policy belongs to the first company it applies to (the server
      // falls back to the caller's own company, and says so when there is none).
      const res = isNew
        ? await api.createHolidayPolicy(companies.length ? { ...data, companyId: companies[0] } : data)
        : await api.updateHolidayPolicy(policy.id, data);
      const n = syncCount(res?.sync);
      const detached = Number(res?.sync?.detached) || 0;
      toastOk?.(`Saved - updated ${plural(n, 'company', 'companies')}`
        + (detached ? ` (${plural(detached, 'changed holiday')} kept as the company's own)` : ''));
      setSaving(false);
      onSaved?.(res?.policy);
      return true;
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the policy.');
      setSaving(false);
      return false;
    }
  }

  const title = isNew ? 'New Holiday Policy' : readOnly ? policy.name : `Edit ${policy.name}`;
  const footer = readOnly ? (
    <button className="secondary-btn" onClick={onClose}>Close</button>
  ) : (
    <>
      <button className="secondary-btn" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="primary-btn" onClick={save} disabled={saving || !name.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {saving && <Spinner size={12} />} Save Policy
      </button>
    </>
  );

  return (
    <Modal title={title} onClose={onClose} footer={footer} isDirty={!readOnly && dirty} onSave={save}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
        {readOnly && (
          <p style={{ ...HINT, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 10 }} role="note">
            {ownerName ? `Only ${ownerName} can change this policy.` : 'Only the company that made this policy can change it.'} You can still assign it to a company from that company's Holiday Calendar.
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <label style={FIELD}>
            <span style={LABEL}>Name</span>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)} disabled={readOnly} placeholder="e.g. US Holidays" />
          </label>
          <div style={FIELD}>
            <label style={FIELD}>
              <span style={LABEL}>When A Holiday Falls On A Weekend</span>
              <select className="form-input" value={weekendRule} onChange={e => setWeekendRule(e.target.value)} disabled={readOnly}>
                {WEEKEND_RULES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            {!readOnly && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={HINT}>{WEEKEND_RULE_HINT}</span>
                <button type="button" className="secondary-btn" onClick={applyRuleToExisting} disabled={draft.length === 0}
                  style={{ fontSize: 12, padding: '4px 10px' }}>
                  Apply To Existing Holidays
                </button>
              </span>
            )}
          </div>
        </div>
        <label style={FIELD}>
          <span style={LABEL}>Description</span>
          <textarea className="form-input" rows={2} value={description} onChange={e => setDescription(e.target.value)} disabled={readOnly}
            placeholder="Who it is for, e.g. US staff of every Greens company" style={{ resize: 'vertical' }} />
        </label>
        <div style={FIELD}>
          <span style={LABEL} id="holiday-policy-applies">Applies To</span>
          {readOnly ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {companies.length ? companies.map(id => <Chip key={id}>{options.find(o => o.id === id)?.label || id}</Chip>) : <span style={HINT}>No companies yet.</span>}
            </div>
          ) : (
            <ChipMultiSelect value={companies} onChange={setCompanies} options={options}
              placeholder="Pick one or more companies" searchPlaceholder="Search companies" emptyText="No companies." />
          )}
          <span style={HINT}>Each company gets these holidays on its calendar. A company can skip or change any of them for itself.</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h4 style={SUBHEAD}>Holidays For</h4>
          <select className="form-input" aria-label="Year" value={year} onChange={e => { setYear(Number(e.target.value)); setUnmatched(null); }} style={{ width: 100 }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {!readOnly && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={LABEL}>Add Holidays From</span>
              <CountrySelect value={country} onChange={setCountryPicked} />
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              <HolidaySourcePicker key={`${country}-${year}`} country={country} year={year} rule={weekendRule}
                chosen={s => findSourceRow(draft, s, country) || null}
                onAdd={addFromSource} onRemove={removeSource} onMove={moveSource} />
            </div>
          </div>
        )}

        <div className="nx-fill" style={{ gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <h4 style={SUBHEAD}>Holidays In {year} ({rowsForYear.length})</h4>
            {!readOnly && (
              <button className="secondary-btn" onClick={copyForward} disabled={isNew || copying || rowsForYear.length === 0}
                title={isNew ? 'Save the policy first' : `Build the same holidays for ${year + 1} from the holiday lists`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                {copying ? <Spinner size={12} /> : <Copy size={12} />} Copy To {year + 1}
              </button>
            )}
          </div>
          {unmatched && unmatched.names.length > 0 && (
            <p style={{ ...HINT, color: '#b45309' }} role="note">
              Not found for {unmatched.year} - add these by hand: {unmatched.names.join(', ')}.
            </p>
          )}
          {unmatched && unmatched.notObserved.length > 0 && (
            <p style={HINT} role="note">
              No day off under this policy's weekend rule: {unmatched.notObserved.join(', ')}.
            </p>
          )}
          <div style={{ flex: 1, minHeight: 120, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
            {rowsForYear.length === 0 ? (
              <p style={{ ...HINT, padding: 14 }}>No holidays in {year} yet. Tick them in the list above, or add one by hand below.</p>
            ) : rowsForYear.map(({ h, i }) => (
              <div key={`${h.key || 'row'}|${i}`} data-policy-holiday={h.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', fontSize: 12.5 }}>
                <div style={{ minWidth: 150, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <DateField value={h.date} onChange={v => changeDate(i, v)} disabled={readOnly} title="Change Date" style={{ fontWeight: 700 }} />
                  {h.actualDate && h.actualDate !== h.date && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>Holiday is {dateWithWeekday(h.actualDate)}</span>
                  )}
                  {sameDay[i] && (
                    <span role="note" style={{ fontSize: 11, color: '#b45309' }}>{sameDay[i]}</span>
                  )}
                </div>
                <input className="form-input" aria-label="Holiday name" value={h.name} disabled={readOnly}
                  onChange={e => update(i, { name: e.target.value })} style={{ flex: '1 1 180px', minWidth: 140 }} />
                {h.tentative && <TentativeChip />}
                <select className="form-input" aria-label={`Type for ${h.name}`} value={h.type || 'mandatory'} disabled={readOnly}
                  onChange={e => update(i, { type: e.target.value })} style={{ width: 120, fontSize: 12 }}>
                  {Object.entries(HOLIDAY_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <span style={{ display: 'inline-flex', gap: 4 }}>{(h.countries || []).map(c => <Chip key={c}>{c}</Chip>)}</span>
                {!readOnly && (
                  <button type="button" onClick={() => removeAt(i)} aria-label={`Remove ${h.name}`} title="Remove"
                    style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 5 }}>
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {!readOnly && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="form-input" style={{ width: 170, display: 'inline-flex', alignItems: 'center' }}>
                <DateField value={manualDate} onChange={setManualDate} placeholder="Pick a date" title="Holiday date" style={{ width: '100%' }} />
              </span>
              <input className="form-input" aria-label="New holiday name" placeholder="e.g. Founders' Day" value={manualName}
                onChange={e => setManualName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addManual(); }} style={{ flex: '1 1 180px' }} />
              <button className="secondary-btn" onClick={addManual} disabled={!manualDate || !manualName.trim()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Plus size={13} /> Add Holiday
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
