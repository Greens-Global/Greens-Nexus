// Operations: the page's ONE facility dropdown (Visesh / Neil, Oct 20 2026:
// "Clearly we don't want these different chips. This needs to be a drop down
// again, similar to accounting"). It replaces the facility chip row and the
// per-tab pickers Rate Management, Revenue Management and Reports had; every
// tab reads this one choice.
//
// The look is Accounting's entity picker (components/accounting/reportControls
// EntityPicker: building icon, chevron, brand color once one is picked) on a
// native select, so arrow keys, type-ahead and a phone's own list all work.
// Stores another operator runs sit under their operator's heading
// ("CubeSmart Managed"); picking one shows that tag and how old its data is.
import { Building2, ChevronDown } from 'lucide-react';
import { dataAsOf, isThirdParty, managedLabel } from './thirdParty';

// `allowAll` false on the tabs that work on one facility at a time.
export default function FacilityPicker({ facilities, value, onChange, allowAll = true }) {
  const own = facilities.filter((f) => !isThirdParty(f));
  const groups = [];
  facilities.filter(isThirdParty).forEach((f) => {
    const label = managedLabel(f) || 'Managed by an Operator';
    const g = groups.find((x) => x.label === label);
    if (g) g.list.push(f); else groups.push({ label, list: [f] });
  });
  const one = value === 'all' ? null : facilities.find((f) => f.id === value);
  const option = (f) => <option key={f.id} value={f.id}>{f.shortName}</option>;
  return (
    <div className="ops-facility">
      <label className="ops-facility-label" htmlFor="ops-facility-select">Facility</label>
      <span className="ops-facility-box">
        <Building2 size={14} className="ops-facility-icon" aria-hidden="true" />
        <select id="ops-facility-select" value={value} data-active={!!one} onChange={(e) => onChange(e.target.value)}
          title={one ? one.shortName : 'All Facilities'}>
          {(allowAll || !one) && <option value="all">All Facilities</option>}
          {own.map(option)}
          {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.list.map(option)}</optgroup>)}
        </select>
        <ChevronDown size={13} className="ops-facility-chev" aria-hidden="true" />
      </span>
      {one && isThirdParty(one) && (
        <>
          <span className="ops-pill-tag">{managedLabel(one)}</span>
          <span className="ops-facility-asof">{dataAsOf(one)}</span>
        </>
      )}
    </div>
  );
}
