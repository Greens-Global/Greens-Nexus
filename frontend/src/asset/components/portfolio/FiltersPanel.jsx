import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { SHOW_OPTIONS, NONE, facetCounts, normalizeFilters } from '../../lib/portfolioQuery.js';

// The Filters panel (Neil, 11/17/2026): two columns - Stage, Type, Location on the left;
// Company, Asset Manager, Owner, Size, Shows on the right. Every count is FACETED: it counts
// what remains after the OTHER facets' picks, so a number says what picking it would show;
// a zero is gray. Picks apply as they are made; Show N Properties closes the panel.

const SHORT = 6;

function Check({ on, label, count, onChange, indent = false, describedBy }) {
  const zero = !count && !on;
  return (
    <label className={`pt-fcheck${zero ? ' is-zero' : ''}${indent ? ' is-indent' : ''}`}>
      <input type="checkbox" checked={on} onChange={onChange} aria-describedby={describedBy} />
      <span className="pt-fcheck-label">{label}</span>
      <span className="pt-fcheck-count">{count || 0}</span>
    </label>
  );
}

function Section({ title, children, id }) {
  return (
    <fieldset className="pt-fsec" aria-labelledby={id}>
      <legend id={id} className="pt-fsec-title">{title}</legend>
      {children}
    </fieldset>
  );
}

/** A list of picks that shows its first few and "Show all N" for the rest. */
function PickList({ facet, options, filters, counts, onToggle, search = false }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const picked = filters[facet];
  const needle = q.trim().toLowerCase();
  const list = needle ? options.filter((o) => String(o.label).toLowerCase().includes(needle)) : options;
  // Picked ones always show, even past the fold.
  const shown = all || needle ? list : list.filter((o, i) => i < SHORT || picked.includes(o.key));
  return (
    <>
      {search && options.length > SHORT && (
        <div className="pt-fsearch">
          <Search size={14} aria-hidden="true" />
          <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${options.length} ${facet === 'owner' ? 'owners' : 'names'}`} aria-label={`Search ${facet === 'owner' ? 'owners' : 'asset managers'}`} />
        </div>
      )}
      {shown.map((o) => (
        <Check key={o.key} on={picked.includes(o.key)} label={o.label} count={counts[facet].get(o.key)} onChange={() => onToggle(facet, o.key)} />
      ))}
      {!needle && list.length > shown.length && (
        <button type="button" className="pt-link pt-fmore" onClick={() => setAll(true)}>Show all {list.length}</button>
      )}
      {needle && !list.length && <div className="pt-fnote">No match.</div>}
    </>
  );
}

function Range({ label, min, max, onMin, onMax, unit }) {
  return (
    <div className="pt-frange">
      <span className="pt-frange-label">{label}</span>
      <input className="form-input" inputMode="decimal" value={min} onChange={(e) => onMin(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Min" aria-label={`${label} at least`} />
      <span className="pt-dim">to</span>
      <input className="form-input" inputMode="decimal" value={max} onChange={(e) => onMax(e.target.value.replace(/[^\d.]/g, ''))} placeholder="Max" aria-label={`${label} at most`} />
      {unit ? <span className="pt-dim pt-frange-unit">{unit}</span> : null}
    </div>
  );
}

/**
 * filters, onChange(next): the register's filters. ctx / options: the query context and every
 * facet's values (portfolioQuery). shownCount: how many properties the picks show now.
 */
export function FiltersPanel({ filters: raw, onChange, ctx, options, shownCount, onDone, phone = false }) {
  const filters = normalizeFilters(raw);
  const counts = useMemo(() => facetCounts(ctx, filters), [ctx, filters]);
  const toggle = (facet, key) => {
    const cur = filters[facet];
    onChange({ ...filters, [facet]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  };
  const set = (k) => (v) => onChange({ ...filters, [k]: v });
  const shows = SHOW_OPTIONS.filter(([k, , inPanel]) => inPanel || filters.shows.includes(k) || (k === 'tickets' && ctx.hasTickets));
  const clearAll = () => onChange({ ...normalizeFilters({}), q: filters.q });

  const left = (
    <div className="pt-fcol">
      <Section title="Stage" id="pt-f-stage">
        {options.stage.map((o) => <Check key={o.key} on={filters.stage.includes(o.key)} label={o.label} count={counts.stage.get(o.key)} onChange={() => toggle('stage', o.key)} />)}
      </Section>
      <Section title="Type" id="pt-f-type">
        {options.type.map((o) => <Check key={o.key} on={filters.type.includes(o.key)} label={o.label} count={counts.type.get(o.key)} onChange={() => toggle('type', o.key)} />)}
      </Section>
      {options.loc.length > 0 && (
        <Section title="Location" id="pt-f-loc">
          {options.loc.map((c) => (
            <div key={c.key}>
              <Check on={filters.loc.includes(c.key)} label={c.label} count={counts.loc.get(c.key)} onChange={() => toggle('loc', c.key)} />
              {c.states.map((s) => <Check key={s.key} indent on={filters.loc.includes(s.key)} label={s.label} count={counts.loc.get(s.key)} onChange={() => toggle('loc', s.key)} />)}
            </div>
          ))}
          <div className="pt-fnote">"CA" and "California" count as one state.</div>
        </Section>
      )}
    </div>
  );
  const right = (
    <div className="pt-fcol">
      {options.company.length > 1 || filters.company.length ? (
        <Section title="Company" id="pt-f-company">
          <PickList facet="company" options={options.company} filters={filters} counts={counts} onToggle={toggle} />
        </Section>
      ) : null}
      <Section title="Asset Manager" id="pt-f-manager">
        <PickList facet="manager" options={options.manager} filters={filters} counts={counts} onToggle={toggle} />
      </Section>
      <Section title="Owner" id="pt-f-owner">
        <PickList facet="owner" options={options.owner.filter((o) => o.key !== NONE || filters.owner.includes(NONE) || counts.owner.get(NONE))} filters={filters} counts={counts} onToggle={toggle} search />
      </Section>
      <Section title="Size" id="pt-f-size">
        <Range label="Acres" min={filters.acresMin} max={filters.acresMax} onMin={set('acresMin')} onMax={set('acresMax')} />
        <Range label="Rentable SF" min={filters.sfMin} max={filters.sfMax} onMin={set('sfMin')} onMax={set('sfMax')} />
      </Section>
      <Section title="Shows" id="pt-f-shows">
        {shows.map(([k, label]) => <Check key={k} on={filters.shows.includes(k)} label={label} count={counts.shows.get(k)} onChange={() => toggle('shows', k)} />)}
      </Section>
    </div>
  );

  return (
    <div className={`pt-filters${phone ? ' is-phone' : ''}`} role={phone ? undefined : 'dialog'} aria-label="Filters">
      <div className="pt-fcols">{left}{right}</div>
      <div className="pt-ffoot">
        <span className="pt-dim">Counts follow the other filters you picked.</span>
        <button type="button" className="pt-link" onClick={clearAll}>Clear All</button>
        <button type="button" className="primary-btn" onClick={onDone}>Show {shownCount} {shownCount === 1 ? 'Property' : 'Properties'}</button>
      </div>
    </div>
  );
}
