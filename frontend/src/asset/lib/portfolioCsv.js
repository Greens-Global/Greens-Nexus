// "..." > Export as CSV on the portfolio's tabs (Neil, 11/17/2026): one row per property or
// vehicle, as the list shows it - a parcel group's numbers are the SUM of its parcels. On the
// Properties tab it is the list on screen (its filters and order); elsewhere every asset.
// A single asset's full export (every record under it) stays lib/csvExport.js.
import { inferAssetKind } from './vehicleFields.js';
import { cityRegion, typeLabel } from './portfolioCards.js';
import { companyName, companyIdOf } from './companies.js';
import { measuresOf } from './portfolioQuery.js';

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function portfolioCsvText(list, all = [], companies = [], metrics = {}) {
  const head = ['Name', 'Kind', 'Type', 'Stage', 'City and State', 'Address', 'Owner', 'Asset Manager', 'Company', 'Parcels', 'Acres', 'Rentable SF', 'Units', 'Occupied'];
  const rows = list.map((a) => {
    const m = measuresOf(a, all);
    const occ = metrics?.[a.id]?.occupancy;
    const kind = inferAssetKind(a);
    return [
      a.siteName && !a.parentId && m.parcels > 1 ? a.siteName : a.name,
      kind === 'property' ? 'Property' : kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment',
      typeLabel(a), a.devStage || '', cityRegion(a), a.address || '', a.entity || '', a.manager || '',
      companyName(companies, companyIdOf(a)), m.parcels, m.acres ? m.acres.toFixed(2) : '', m.sf || '', m.units || '',
      typeof occ === 'number' ? `${Math.round(occ * 100)}%` : '',
    ];
  });
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function exportPortfolioCsv(list, all, companies, metrics) {
  const blob = new Blob(['﻿' + portfolioCsvText(list, all, companies, metrics)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  a.href = url;
  a.download = `Asset Portfolio ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
