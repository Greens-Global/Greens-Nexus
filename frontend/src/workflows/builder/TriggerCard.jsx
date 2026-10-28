// When (Oct 2026): what starts the workflow. Four kinds - an event, a
// schedule, a date on a record, or by hand. The event picker lists what the
// catalog serves, grouped by module, searchable, with a New badge on what was
// added since the person last opened Workflows. After an event is chosen its
// filters appear ("status changed to: Approved").
import { useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { TimeField, useClickOutside } from '../../tasks/components';
import { NumberBox } from '../../components/settings/SettingsUI';
import { describeTrigger } from '../lib/text';
import { findEntity, findEvent } from '../lib/definition';
import { ConditionRow } from './ConditionsCard';
import { WEEKDAYS, card, cardTitle, chip, fieldLabel, groupBy, hint, moduleLabel, select, sentence, textInput } from '../lib/text.builder-helpers';

const KINDS = [
  { key: 'event', label: 'Event' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'date', label: 'Date' },
  { key: 'manual', label: 'Manual' },
];

function blankTrigger(kind, prev) {
  if (kind === 'event') return { kind, event: '', filters: [] };
  if (kind === 'schedule') return { kind, every: 'week', days: [1], time: '08:00', zone: 'company', entity: prev?.entity || '' };
  if (kind === 'date') return { kind, entity: prev?.entity || '', field: '', offsetDays: -14, time: '08:00' };
  return { kind, entity: prev?.entity || '' };
}

export function EventPicker({ value, onChange, catalog, isNew }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  useClickOutside([btnRef, menuRef], () => setOpen(false), open);
  const events = catalog?.events || [];
  const chosen = findEvent(catalog, value);
  const query = q.trim().toLowerCase();
  const shown = query ? events.filter((e) => `${e.label} ${e.group} ${e.module} ${e.key}`.toLowerCase().includes(query)) : events;
  const pick = (key) => { onChange(key); setOpen(false); setQ(''); };
  return (
    <div style={{ position: 'relative' }}>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label="Choose an event" style={{
        ...select, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 260, justifyContent: 'space-between',
      }}>
        <span style={{ color: chosen ? 'var(--nx-ink)' : 'var(--nx-faint)' }}>{chosen ? `${moduleLabel(chosen.module)}: ${chosen.label}` : 'Choose what happens'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div ref={menuRef} role="listbox" aria-label="Events" style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 4, width: 'min(420px, 92vw)',
          background: 'var(--nx-surface)', border: '1px solid var(--nx-border)', borderRadius: 12,
          boxShadow: '0 16px 40px rgba(17,24,39,0.18)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--nx-faint)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events" aria-label="Search events" autoFocus style={{ ...textInput, paddingLeft: 28 }} />
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!shown.length && <div style={{ ...hint, padding: 6 }}>No event matches.</div>}
            {groupBy(shown, (e) => e.module).map(([module, items]) => (
              <div key={module}>
                <div style={{ ...hint, fontWeight: 700, padding: '6px 6px 2px' }}>{moduleLabel(module)}</div>
                {groupBy(items, (e) => e.group).map(([group, rows]) => (
                  <div key={group}>
                    {group && group !== moduleLabel(module) && <div style={{ ...hint, fontSize: 11, padding: '2px 8px' }}>{group}</div>}
                    {rows.map((e) => (
                      <button key={e.key} type="button" role="option" aria-selected={e.key === value} onClick={() => pick(e.key)} style={{
                        display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                        border: 'none', background: e.key === value ? 'var(--nx-hover)' : 'transparent', padding: '7px 10px', borderRadius: 8,
                        cursor: 'pointer', fontSize: 13, color: 'var(--nx-ink)', textAlign: 'left', fontFamily: 'inherit',
                      }}>
                        <span>{e.label}</span>
                        {isNew?.(e.key) && <span style={{ ...chip, fontSize: 10.5, padding: '1px 6px', color: 'var(--nx-primary)', borderColor: 'var(--nx-primary)' }}>New</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EntitySelect({ value, onChange, catalog, onlyWithDates = false, label = 'Record' }) {
  const entities = (catalog?.entities || []).filter((e) => !onlyWithDates || (e.dates || []).length);
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={label} style={select}>
      <option value="">Choose a kind of record</option>
      {groupBy(entities, (e) => e.module).map(([module, items]) => (
        <optgroup key={module} label={moduleLabel(module)}>
          {items.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export default function TriggerCard({ definition, onChange, catalog, isNew, people, open, onToggle }) {
  const trigger = definition.trigger || { kind: 'event' };
  const set = (patch) => onChange({ ...definition, trigger: { ...trigger, ...patch } });
  const setKind = (kind) => { if (kind !== trigger.kind) onChange({ ...definition, trigger: blankTrigger(kind, trigger) }); };
  const eventDef = trigger.kind === 'event' ? findEvent(catalog, trigger.event) : null;
  const entityDef = findEntity(catalog, trigger.kind === 'event' ? eventDef?.entity : trigger.entity);
  const words = describeTrigger(trigger, catalog);

  return (
    <section style={card} aria-label="When">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={cardTitle}>When</div>
        <button type="button" onClick={onToggle} style={{ ...chip, cursor: 'pointer' }}>{open ? 'Done' : 'Edit'}</button>
      </div>
      {!open && <div style={sentence}>{words || <span style={hint}>Choose what starts this workflow.</span>}</div>}
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div role="tablist" aria-label="Trigger kind" className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
            {KINDS.map((k) => (
              <button key={k.key} type="button" role="tab" aria-selected={trigger.kind === k.key} onClick={() => setKind(k.key)} style={{
                ...chip, cursor: 'pointer', fontWeight: 600,
                ...(trigger.kind === k.key ? { background: 'var(--nx-primary)', color: '#fff', borderColor: 'var(--nx-primary)' } : null),
              }}>{k.label}</button>
            ))}
          </div>

          {trigger.kind === 'event' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <EventPicker value={trigger.event} onChange={(event) => set({ event, filters: [] })} catalog={catalog} isNew={isNew} />
              {eventDef && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={fieldLabel}>Filters</span>
                  {!(trigger.filters || []).length && <div style={hint}>Every {eventDef.label.toLowerCase()} starts it. Add a filter to narrow it, e.g. status changed to Approved.</div>}
                  {(trigger.filters || []).map((row, i) => (
                    <ConditionRow key={i} row={row} entityDef={entityDef} eventDef={eventDef} catalog={catalog} people={people}
                      onChange={(r) => set({ filters: trigger.filters.map((x, j) => (j === i ? r : x)) })}
                      onRemove={() => set({ filters: trigger.filters.filter((_, j) => j !== i) })} />
                  ))}
                  <div><button type="button" onClick={() => set({ filters: [...(trigger.filters || []), { field: '', op: '', value: '' }] })} style={{ ...chip, cursor: 'pointer' }}>+ Add Filter</button></div>
                </div>
              )}
            </div>
          )}

          {trigger.kind === 'schedule' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={hint}>Every</span>
                <select value={trigger.every || 'week'} onChange={(e) => set({ every: e.target.value, days: e.target.value === 'day' ? [] : e.target.value === 'week' ? [1] : [1] })} aria-label="How often" style={select}>
                  <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
                </select>
                <span style={hint}>at</span>
                <TimeField value={trigger.time || ''} onChange={(time) => set({ time })} ariaLabel="Time of day" />
                <span style={hint}>in each company's time zone</span>
              </div>
              {trigger.every === 'week' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {WEEKDAYS.map((d) => {
                    const on = (trigger.days || []).includes(d.n);
                    return (
                      <button key={d.n} type="button" aria-pressed={on} onClick={() => set({ days: on ? (trigger.days || []).filter((x) => x !== d.n) : [...(trigger.days || []), d.n].sort((a, b) => a - b) })} style={{
                        ...chip, cursor: 'pointer', ...(on ? { background: 'var(--nx-primary)', color: '#fff', borderColor: 'var(--nx-primary)' } : null),
                      }}>{d.label}</button>
                    );
                  })}
                </div>
              )}
              {trigger.every === 'month' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span style={hint}>On day</span>
                  <input type="text" value={(trigger.days || []).join(', ')} onChange={(e) => set({ days: e.target.value.split(',').map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= 31) })} aria-label="Days of the month" placeholder="1, 15" style={{ ...textInput, width: 120 }} />
                  <span style={hint}>of the month (1-31)</span>
                </div>
              )}
              <div>
                <span style={fieldLabel}>Runs on</span>
                <EntitySelect value={trigger.entity} onChange={(entity) => set({ entity })} catalog={catalog} label="Record kind" />
                <div style={{ ...hint, marginTop: 4 }}>Each record of this kind that passes Only If gets a run. Leave it blank for one run with no record.</div>
              </div>
            </div>
          )}

          {trigger.kind === 'date' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <span style={fieldLabel}>Record</span>
                <EntitySelect value={trigger.entity} onChange={(entity) => set({ entity, field: '' })} catalog={catalog} onlyWithDates label="Record kind" />
              </div>
              {entityDef && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <NumberBox value={Math.abs(Number(trigger.offsetDays) || 0)} onChange={(n) => set({ offsetDays: ((Number(trigger.offsetDays) || 0) < 0 ? -1 : 1) * (Number(n) || 0) })} min={0} max={3650} unit="days" label="Days" />
                  <select value={(Number(trigger.offsetDays) || 0) < 0 ? 'before' : 'after'} onChange={(e) => set({ offsetDays: (e.target.value === 'before' ? -1 : 1) * Math.abs(Number(trigger.offsetDays) || 0) })} aria-label="Before or after" style={select}>
                    <option value="before">Before</option><option value="after">After</option>
                  </select>
                  <select value={trigger.field || ''} onChange={(e) => set({ field: e.target.value })} aria-label="Which date" style={select}>
                    <option value="">Choose a date</option>
                    {(entityDef.dates || []).map((d) => <option key={d.key} value={d.key}>{d.label}{d.yearly ? ' (every year)' : ''}</option>)}
                  </select>
                  <span style={hint}>at</span>
                  <TimeField value={trigger.time || ''} onChange={(time) => set({ time })} ariaLabel="Time of day" />
                </div>
              )}
            </div>
          )}

          {trigger.kind === 'manual' && (
            <div>
              <span style={fieldLabel}>Runs on</span>
              <EntitySelect value={trigger.entity} onChange={(entity) => set({ entity })} catalog={catalog} label="Record kind" />
              <div style={{ ...hint, marginTop: 4 }}>Someone with access picks a record and clicks Run.</div>
            </div>
          )}

          {trigger.kind !== 'event' && trigger.entity && (
            <button type="button" onClick={() => set({ entity: '' })} style={{ ...chip, cursor: 'pointer', alignSelf: 'flex-start' }}><X size={12} /> Clear Record Kind</button>
          )}
          <div style={{ ...hint, fontStyle: 'italic' }}>{words}</div>
        </div>
      )}
    </section>
  );
}
