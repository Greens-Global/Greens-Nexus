// The one Works In picker (Neil, 11/04/2026): United States - CA, United
// States - TX or India, for every hiring document. A place saved before the
// three (another state, Anywhere In The US, another country) still shows as
// it was, so opening an older packet never quietly changes where it goes.
import { WORKS_IN, worksInKey, worksInLabel } from '../lib/usStates';

export default function WorksInSelect({ id, country, region, onChange, emptyLabel = '', countryNames = {}, style }) {
  const key = worksInKey(country, region);
  const older = key && !WORKS_IN.some(w => w.key === key);
  const pick = (value) => {
    if (value === key) return;
    const w = WORKS_IN.find(x => x.key === value);
    onChange(w ? { country: w.country, region: w.region } : { country: '', region: '' });
  };
  return (
    <select id={id} className="form-input" style={{ width: '100%', ...style }} value={key} onChange={e => pick(e.target.value)}>
      {emptyLabel && <option value="">{emptyLabel}</option>}
      {older && <option value={key}>{worksInLabel(country, region, countryNames)}</option>}
      {WORKS_IN.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
    </select>
  );
}
