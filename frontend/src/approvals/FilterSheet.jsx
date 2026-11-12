// The phone's one Filter sheet (Neil, 11/02/2026): everything the desktop
// tools row and rail do - search, sort, group, priority, waiting, and the
// department / company lists when the person sees more than one - behind
// the Filter chip. Every control saves on tap (the same state ApprovalsCenter
// holds; sort and group are the person's saved table values), so Done only
// closes. The kind chips stay on the page; this sheet never filters by kind.
import { Search } from 'lucide-react';
import { Modal } from '../tasks/components';

const SORTS = [{ key: 'oldest', label: 'Oldest' }, { key: 'newest', label: 'Newest' }, { key: 'priority', label: 'Priority' }, { key: 'person', label: 'Person' }];
const GROUPS = [{ key: 'none', label: 'None' }, { key: 'person', label: 'Person' }, { key: 'kind', label: 'Type' }, { key: 'department', label: 'Department' }];
const PRIORITIES = [{ key: 'all', label: 'All' }, { key: 'urgent', label: 'Urgent' }, { key: 'high', label: 'High And Up' }];
const WAITS = [{ key: 0, label: 'Any' }, { key: 3, label: '3+ Days' }, { key: 7, label: '7+ Days' }];
// Choices only the desktop offers. One picked there (the sort and the group
// are the person's saved table values) still shows here, pressed, so the
// sheet never claims a choice that is not the one in force.
const DESKTOP_ONLY = {
  sort: { kind: 'Kind' },
  group: { company: 'Company' },
  priority: { medium: 'Medium', low: 'Low' },
};
const withCurrent = (options, value, names) => (options.some((o) => o.key === value) || !names[value] ? options : [...options, { key: value, label: names[value] }]);

function Seg({ title, options, value, onPick }) {
  return (
    <div className="apv-ph-fs-g" role="group" aria-label={title}>
      <div className="apv-ph-fs-t">{title}</div>
      <div className="apv-ph-seg">
        {options.map((o) => (
          <button key={String(o.key)} type="button" className={value === o.key ? 'is-on' : ''} aria-pressed={value === o.key} onClick={() => onPick(o.key)}>
            {o.label}{o.n !== undefined && <>{' '}<b>{o.n}</b></>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function FilterSheet({ filters, setFilters, clearFilters, onClose, sortKey, setSortKey, groupBy, setGroupBy, deptCounts = [], companyCounts = [], seesAll = false }) {
  const manyCompanies = companyCounts.length > 1;
  const sorts = withCurrent(SORTS, sortKey, DESKTOP_ONLY.sort);
  const groups = withCurrent(manyCompanies ? [...GROUPS, { key: 'company', label: 'Company' }] : GROUPS, groupBy, DESKTOP_ONLY.group);
  const priorities = withCurrent(PRIORITIES, filters.prioFilter, DESKTOP_ONLY.priority);
  const toggle = (name) => (v) => setFilters({ [name]: filters[name] === v ? '' : v });
  return (
    // Done leaves through the Modal's exit, like the X. Clear Filters stays:
    // it resets the choices in place, so the next one is a tap away.
    <Modal title="Filter" onClose={onClose} footer={(close) => (
      <>
        <button type="button" className="secondary-btn apv-ph-fbtn" onClick={clearFilters}>Clear Filters</button>
        <button type="button" className="primary-btn apv-ph-fbtn" onClick={() => close()}>Done</button>
      </>
    )}>
      <div className="apv-ph-fs">
        <div className="apv-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" className="form-input" style={{ fontSize: /* type-ok: iOS zooms a field under 16px */ 16, minHeight: 44 }} value={filters.query} onChange={(e) => setFilters({ query: e.target.value })}
            placeholder="Search by name, request or detail" aria-label="Search approvals" />
        </div>
        <Seg title="Sort" options={sorts} value={sorts.some((s) => s.key === sortKey) ? sortKey : 'oldest'} onPick={setSortKey} />
        <Seg title="Group By" options={groups} value={groups.some((g) => g.key === groupBy) ? groupBy : 'kind'} onPick={setGroupBy} />
        <Seg title="Priority" options={priorities} value={priorities.some((p) => p.key === filters.prioFilter) ? filters.prioFilter : 'all'} onPick={(v) => setFilters({ prioFilter: v })} />
        <Seg title="Waiting" options={WAITS} value={filters.ageFilter || 0} onPick={(v) => setFilters({ ageFilter: v })} />
        {(seesAll || deptCounts.length > 1) && deptCounts.length > 0 && (
          <Seg title="Department" options={deptCounts.map(([name, n]) => ({ key: name, label: name, n }))} value={filters.dept} onPick={toggle('dept')} />
        )}
        {manyCompanies && (
          <Seg title="Company" options={companyCounts.map(([name, n]) => ({ key: name, label: name, n }))} value={filters.company} onPick={toggle('company')} />
        )}
      </div>
    </Modal>
  );
}
