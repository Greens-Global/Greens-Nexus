// An asset's company (Neil, 11/03/2026: "A company field on asset management
// would replace the inferred company"). The row keeps `companyId` (an HR
// company id); the server checks every change on the row save
// (routers/property_assets._check_company) and reads it first wherever a
// property's company matters (property_links.property_company). This file is
// the screen's side: the picker's list, the names, and "Needs a Company".

import { useEffect, useState } from 'react';
import { api } from '../../api.js';

/** The Company filter's value for "Needs a Company" (no company set). */
export const NO_COMPANY = '__none__';

/** The picker's list: { companies: [{ id, name, assignable }], canClear, loaded }. */
export function useAssetCompanies() {
  const [state, setState] = useState({ companies: [], canClear: false, loaded: false });
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.getAssetCompanies?.())
      .then((r) => { if (alive) setState({ companies: (r && r.companies) || [], canClear: !!(r && r.canClear), loaded: true }); })
      .catch(() => { if (alive) setState((s) => ({ ...s, loaded: true })); });
    return () => { alive = false; };
  }, []);
  return state;
}

export const companyIdOf = (asset) => String((asset && asset.companyId) || '').trim();

/** "Greens Storage", '' for no company (or while the list is still loading),
 *  "Unknown Company" for an id the loaded list does not name. */
export function companyName(companies, id) {
  const key = String(id || '').trim();
  const list = companies || [];
  if (!key || !list.length) return '';
  const hit = list.find((c) => c.id === key);
  return hit ? hit.name : 'Unknown Company';
}

/** A live asset with no company set - what "Needs a Company" lists. */
export const needsCompany = (asset) => !!asset && !asset.deleted && !companyIdOf(asset);

/**
 * The picker's options for an asset whose company is `current`: every company
 * the person may assign, the current one even when they may not (shown, so the
 * value reads right), and "No Company" only while the asset has none or the
 * person may clear it. `locked` = they may not move it at all (its company is
 * outside theirs) - the screen shows it read-only.
 */
export function companyOptions(companies, current, canClear) {
  const cur = String(current || '').trim();
  const list = companies || [];
  const mine = list.filter((c) => c.assignable);
  const curRow = list.find((c) => c.id === cur);
  const locked = !!cur && !!curRow && !curRow.assignable;
  const opts = [];
  if (!cur || canClear) opts.push({ v: '', l: 'No Company' });
  if (cur && !mine.some((c) => c.id === cur)) opts.push({ v: cur, l: companyName(list, cur) || 'Current Company' });
  mine.forEach((c) => opts.push({ v: c.id, l: c.name }));
  return { options: opts, locked };
}
