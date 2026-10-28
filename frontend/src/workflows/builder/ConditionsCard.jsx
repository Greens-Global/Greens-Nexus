// Only If (Oct 2026): condition groups. Rows inside a group are AND, groups
// are OR. A row is field / operator / value, and the field's type (from the
// catalog) picks the operators and the value control - a DateField for a
// date, a person picker for a person, the options source for a select.
// `ConditionRow` is shared with the trigger's filters and the If step.
import { Plus, X } from 'lucide-react';
import { describeCondition } from '../lib/text';
import { DateField, PersonMultiSelect, PersonSelect, ChipMultiSelect } from '../../tasks/components';
import { NumberBox } from '../../components/settings/SettingsUI';
import { DAYS_OPS, LIST_OPS, NO_VALUE_OPS, operatorsFor } from '../lib/definition';
import { card, cardTitle, chip, hint, iconBtn, select, sentence, textInput } from '../lib/text.builder-helpers';

const EMPTY_ROW = { field: '', op: '', value: '' };

function fieldChoices(entityDef, eventDef) {
  const fields = (entityDef?.fields || []).slice();
  return { fields, changed: new Set(eventDef?.changes || []) };
}

function optionsOf(field) {
  if (Array.isArray(field?.options)) return field.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o.value ?? o.id, label: o.label ?? o.name ?? String(o.value ?? o.id) }));
  return null;
}

function ValueControl({ field, op, value, onChange, people }) {
  if (!field || !op || NO_VALUE_OPS.has(op)) return null;
  const type = field.type || 'text';
  const opts = optionsOf(field);
  if (DAYS_OPS.has(op)) return <NumberBox value={value ?? ''} onChange={(v) => onChange(v === '' ? '' : Number(v))} min={0} max={3650} unit="days" label="Days" />;
  if (LIST_OPS.has(op)) {
    if (opts) return <ChipMultiSelect value={Array.isArray(value) ? value : []} onChange={onChange} options={opts.map((o) => ({ id: o.value, label: o.label }))} placeholder="Choose values" />;
    return <input type="text" value={Array.isArray(value) ? value.join(', ') : (value ?? '')} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="One, two, three" aria-label="Values" style={{ ...textInput, maxWidth: 260 }} />;
  }
  if (type === 'date' || type === 'datetime') {
    return <span style={{ ...select, display: 'inline-flex' }}><DateField value={value || ''} onChange={onChange} placeholder="Pick a date" /></span>;
  }
  if (type === 'number' || type === 'money') return <NumberBox value={value ?? ''} onChange={(v) => onChange(v === '' ? '' : Number(v))} min={-999999} max={999999999} label="Value" />;
  if (type === 'bool') {
    return (
      <select value={value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : ''} onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'true')} aria-label="Value" style={select}>
        <option value="">Choose</option><option value="true">Yes</option><option value="false">No</option>
      </select>
    );
  }
  if (type === 'person') return <PersonSelect value={value || ''} onChange={(v) => onChange(v || '')} people={people || []} placeholder="Choose a person" noneLabel="Nobody" ariaLabel="Person" />;
  if (type === 'people') return <PersonMultiSelect value={Array.isArray(value) ? value : []} onChange={onChange} people={people || []} placeholder="Choose people" />;
  if (type === 'select') {
    if (opts) {
      return (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Value" style={select}>
          <option value="">Choose</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    return <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Value" placeholder={typeof field.options === 'string' ? `A ${field.label.toLowerCase()}` : ''} style={{ ...textInput, maxWidth: 260 }} />;
  }
  return <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Value" style={{ ...textInput, maxWidth: 260 }} />;
}

// One field / operator / value row.
export function ConditionRow({ row, onChange, onRemove, entityDef, eventDef, catalog, people }) {
  const { fields, changed } = fieldChoices(entityDef, eventDef);
  const field = fields.find((f) => f.key === row.field) || null;
  const ops = field ? operatorsFor(catalog, field.type).filter((o) => changed.has(field.key) || !o.key.startsWith('changed')) : [];
  const setField = (key) => {
    const f = fields.find((x) => x.key === key);
    const first = f ? operatorsFor(catalog, f.type)[0]?.key || '' : '';
    onChange({ field: key, op: first, value: '' });
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <select value={row.field || ''} onChange={(e) => setField(e.target.value)} aria-label="Field" style={{ ...select, minWidth: 150 }}>
        <option value="">Choose a field</option>
        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      {field && (
        <select value={row.op || ''} onChange={(e) => onChange({ ...row, op: e.target.value, value: NO_VALUE_OPS.has(e.target.value) ? '' : row.value })} aria-label="Operator" style={{ ...select, minWidth: 120 }}>
          {!row.op && <option value="">How</option>}
          {ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      )}
      <ValueControl field={field} op={row.op} value={row.value} onChange={(v) => onChange({ ...row, value: v })} people={people} />
      {onRemove && <button type="button" onClick={onRemove} aria-label="Remove condition" style={iconBtn}><X size={14} /></button>}
    </div>
  );
}

// `groups` = [[row, ...], ...]; `onChange(nextGroups)`.
export function ConditionGroups({ groups, onChange, entityDef, eventDef, catalog, people, emptyText = 'Runs every time.' }) {
  const list = Array.isArray(groups) ? groups : [];
  const setRow = (g, r, row) => onChange(list.map((grp, i) => (i === g ? grp.map((x, j) => (j === r ? row : x)) : grp)));
  const removeRow = (g, r) => {
    const next = list.map((grp, i) => (i === g ? grp.filter((_, j) => j !== r) : grp)).filter((grp) => grp.length);
    onChange(next);
  };
  const addRow = (g) => onChange(list.map((grp, i) => (i === g ? [...grp, { ...EMPTY_ROW }] : grp)));
  const addGroup = () => onChange([...list, [{ ...EMPTY_ROW }]]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!list.length && <div style={hint}>{emptyText}</div>}
      {list.map((grp, g) => (
        <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {g > 0 && <div style={{ ...hint, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>Or</div>}
          <div style={{ border: '1px solid var(--nx-border2)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {grp.map((row, r) => (
              <div key={r} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {r > 0 && <div style={{ ...hint, fontSize: 11, fontWeight: 700 }}>and</div>}
                <ConditionRow row={row} onChange={(x) => setRow(g, r, x)} onRemove={() => removeRow(g, r)} entityDef={entityDef} eventDef={eventDef} catalog={catalog} people={people} />
                {row.field && row.op && <div style={{ ...hint, fontStyle: 'italic' }}>{describeCondition(row, entityDef)}</div>}
              </div>
            ))}
            <div>
              <button type="button" onClick={() => addRow(g)} style={{ ...chip, cursor: 'pointer' }}><Plus size={12} /> And</button>
            </div>
          </div>
        </div>
      ))}
      <div>
        <button type="button" onClick={addGroup} style={{ ...chip, cursor: 'pointer' }}><Plus size={12} /> {list.length ? 'Or Another Group' : 'Add A Condition'}</button>
      </div>
    </div>
  );
}

export default function ConditionsCard({ definition, onChange, entityDef, eventDef, catalog, people, open, onToggle }) {
  const groups = definition.conditions || [];
  const lines = groups.map((grp) => grp.filter((r) => r.field && r.op).map((r) => describeCondition(r, entityDef)).join(' and ')).filter(Boolean);
  return (
    <section style={card} aria-label="Only If">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={cardTitle}>Only If</div>
        <button type="button" onClick={onToggle} style={{ ...chip, cursor: 'pointer' }}>{open ? 'Done' : 'Edit'}</button>
      </div>
      {!open && (
        <div style={sentence}>
          {!entityDef ? <span style={hint}>Choose a trigger first.</span>
            : !lines.length ? <span style={hint}>Runs every time. Add a condition to narrow it.</span>
              : lines.map((l, i) => <div key={i}>{i > 0 && <span style={{ ...hint, fontWeight: 700 }}>or </span>}Only if {l}</div>)}
        </div>
      )}
      {open && (
        !entityDef ? <div style={hint}>Choose a trigger first - the fields come from the record it is about.</div>
          : <ConditionGroups groups={groups} onChange={(c) => onChange({ ...definition, conditions: c })} entityDef={entityDef} eventDef={eventDef} catalog={catalog} people={people} />
      )}
    </section>
  );
}
