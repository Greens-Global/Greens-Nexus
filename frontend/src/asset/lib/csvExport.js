// Asset export - CSV (flat "Section / Group / Field / Value" dump of everything related to an
// asset) and a print-ready PDF/HTML report (property-oriented one-pager: status & alerts, key
// spec sheets, and tables for warranties/inspections/documents/AHJ/utilities/vendors).
//
// Also home to the general-purpose CSV escape/parse helpers used by both export and CSV bulk
// import (see AddAssetModal.jsx's "Import CSV" step).

import { RECORD_TYPES } from './recordTypes.jsx';
import { formatNumber, formatMoney, formatDate, daysUntil, currentUser, toNumber, acresOf } from './format.js';

/** Escape a single CSV field: wraps in quotes (doubling any embedded quotes) if it contains a
 *  comma, quote, or newline. */
export function nexusCsvEsc(v) {
  v = v == null ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Parse CSV text into rows of string cells. Handles quoted fields (with "" escaping), \r\n or
 *  \n line endings, and drops any row that's entirely blank cells. */
export function nexusCsvParse(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n') {
      row.push(cur); rows.push(row); row = []; cur = '';
    } else if (c === '\r') {
      // ignore - paired \n (if any) handles the row break
    } else {
      cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// Collections included in an asset's CSV export, in the order they appear. `propertyId` is the
// foreign key every collection record carries pointing back at the asset's id (see recordTypes.js).
const EXPORT_COLLECTIONS = [
  'maintenance', 'warranties', 'inspections', 'documents', 'ahj',
  'utilities', 'vendors', 'vservice', 'odometer', 'vdocs',
];

/**
 * Build and download a flat CSV of everything tied to an asset: its Overview snapshot fields,
 * every related collection record (maintenance, warranties, inspections, documents, AHJ,
 * utilities, vendors, service, odometer, docs), plus permits and timeline. Every row carries a
 * Section column so the whole asset can be reconstructed/audited from one file.
 */
export function exportAssetCsv(asset, store) {
  const rows = [['Section', 'Group', 'Field', 'Value']];

  // Overview: the free-text snapshot groups (Project Details, Financial & Investment, etc).
  (asset.snapshot || []).forEach((group) => {
    (group.fields || []).forEach((f) => {
      rows.push(['Overview', group.group || '', f.label || '', f.value == null ? '' : String(f.value)]);
    });
  });

  // Every related collection, scoped to this asset via propertyId.
  EXPORT_COLLECTIONS.forEach((coll) => {
    const recs = ((store && store[coll]) || []).filter((r) => r.propertyId === asset.id);
    if (!recs.length) return;
    const cfg = RECORD_TYPES[coll] || {};
    const label = cfg.plural || coll;
    const fields = cfg.fields || [];
    recs.forEach((r, i) => {
      const rowLabel = 'Record ' + (i + 1);
      if (fields.length) {
        fields.forEach((f) => {
          if (f.k && f.k !== 'docFile') {
            rows.push([label, rowLabel, f.label || f.k, r[f.k] == null ? '' : String(r[f.k])]);
          }
        });
      } else {
        Object.keys(r).forEach((k) => {
          if (!['id', 'propertyId'].includes(k)) rows.push([label, rowLabel, k, r[k] == null ? '' : String(r[k])]);
        });
      }
    });
  });

  // Permits and timeline live directly on the asset record (not in the shared store), so they're
  // dumped as raw key/value pairs rather than through a RECORD_TYPES field schema.
  (asset.permits || []).forEach((r, i) => {
    Object.keys(r).forEach((k) => rows.push(['Permits', 'Record ' + (i + 1), k, r[k] == null ? '' : String(r[k])]));
  });
  (asset.timeline || []).forEach((r, i) => {
    Object.keys(r).forEach((k) => rows.push(['Timeline', 'Record ' + (i + 1), k, r[k] == null ? '' : String(r[k])]));
  });

  const csv = rows.map((r) => r.map(nexusCsvEsc).join(',')).join('\n');
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (asset.name || 'asset') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (typeof window !== 'undefined' && window.__pushToast) window.__pushToast('CSV exported', 'ok');
  } catch (e) {
    // Swallow - e.g. Blob/URL unsupported in this environment.
  }
}

// Alias kept for callers that expect an "AsFile" name (e.g. App.jsx's ExportMenu wiring) -
// identical behavior to exportAssetCsv, just a friendlier name at that call site.
export const exportAssetCsvAsFile = exportAssetCsv;

// ---- PDF / print report -----------------------------------------------------------------

/** HTML-escape a value for safe interpolation into the report markup. */
function escHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Escaped value, or an em dash for empty/nullish. */
function escOrDash(v) {
  const s = (v ?? '') === '' ? '' : String(v);
  return s ? escHtml(s) : '-';
}

/** Format + escape a date, or an em dash. */
function escDate(v) {
  return v ? escHtml(formatDate(v)) : '-';
}

/**
 * Format a free-text address field: strips city/state/zip/county components that are already
 * duplicated inline in the raw `address` string (a common data-entry habit), leaving a clean
 * "street, city, state zip" line built from the asset's discrete city/state/zip fields.
 */
function formatAddress(asset) {
  const city = String(asset.city || '').replace(/^\s*(city|town|county)\s+of\s+/i, '').trim();
  const state = String(asset.state || '').trim();
  let zip = String(asset.zip || '').trim();
  const cityLower = city.toLowerCase();
  const rawAddress = String(asset.address || '').trim();
  let stateFromMatch = state;

  if (!zip) {
    const m = rawAddress.match(/\b([A-Za-z]{2})[\s,]+(\d{5})(?:-\d{4})?\b/);
    if (m) { zip = m[2]; stateFromMatch = stateFromMatch || m[1].toUpperCase(); }
  }

  // Is this comma-separated segment a duplicate of city/state/zip/county that should be dropped?
  const isDuplicateSegment = (seg) => {
    const segLower = seg.toLowerCase();
    return !!(
      /^county\s+of\s+/i.test(seg) ||
      /\bcounty$/i.test(seg) ||
      /^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(seg) ||
      (stateFromMatch && segLower === stateFromMatch.toLowerCase()) ||
      (zip && segLower === zip) ||
      (cityLower && (segLower === cityLower || segLower === `city of ${cityLower}` || segLower === `town of ${cityLower}`))
    );
  };

  const segments = rawAddress.split(',').map((s) => s.trim()).filter(Boolean);
  const cityIdx = segments.findIndex((seg) => {
    const segLower = seg.toLowerCase();
    return cityLower && (segLower === cityLower || segLower === `city of ${cityLower}` || segLower === `town of ${cityLower}`);
  });
  const streetSegments = (cityIdx >= 0 ? segments.slice(0, cityIdx) : segments).filter((seg) => !isDuplicateSegment(seg));
  const street = streetSegments.join(', ').replace(/^(\d+[a-z]?),\s+/i, '$1 ').trim();

  return [street, city, [stateFromMatch, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || street;
}

/** "X" -> "X County" (skips if already ends in "County"), or '' if empty. */
function formatCounty(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return /county$/i.test(s) ? s : s + ' County';
}

/** devStage free text -> coarse Active / Under Dev / - classification, for the report's status tile. */
function devStageClass(devStage) {
  const s = (devStage || '').toLowerCase();
  if (!s) return '-';
  if (/(built|in[\s-]?use|open|developed|stabili|operat|complete|occupied|finaled)/.test(s)) return 'Active';
  if (/(feasib|entitl|permit|construction|planning|grading|design)/.test(s)) return 'Under Dev';
  return '-';
}

/**
 * Open a new tab with a print-ready one-page HTML report for a property asset (status/alerts,
 * key spec sheets, related-property rollup for assemblages, and tables for warranties,
 * inspections, documents, AHJ, utilities, vendors) and trigger the browser print dialog.
 *
 * Note: this report is real-estate-oriented (NRSF, unit mix, zoning, CO, property tax) - it does
 * not currently branch for vehicle/equipment assets. The CSV export (exportAssetCsv) is the
 * universal one that covers every asset kind and every collection.
 */
export function exportAssetPdf(asset, store) {
  const recordsOf = (coll) => (store[coll] || []).filter((r) => r.propertyId === asset.id);

  // Assemblage rollup: if this asset shares a siteName with others, the report also lists every
  // member of the group and a combined-totals row.
  const groupMembers = asset.siteName ? store.properties.filter((p) => p.siteName === asset.siteName) : [asset];
  const totals = groupMembers.reduce((acc, p) => ({
    nrsf: acc.nrsf + toNumber(p.nrsf),
    units: acc.units + toNumber(p.unitsTotal),
    rv: acc.rv + toNumber(p.unitsRV),
    ac: acc.ac + acresOf(p.acreage, p.acreageUnit),
  }), { nrsf: 0, units: 0, rv: 0, ac: 0 });

  // Status & alerts strip: insurance expiration, overdue/upcoming inspections, expiring
  // warranties, missing/lapsed vendor COIs. Capped at 10 items.
  const alerts = [];
  const insDays = daysUntil(asset.insExpiration);
  if (insDays != null && insDays < 0) alerts.push(['red', `Insurance policy expired ${Math.abs(insDays)}d ago (${escHtml(asset.insCarrier || 'carrier')})`]);
  else if (insDays != null && insDays <= 90) alerts.push(['amber', `Insurance expires in ${insDays}d (${escHtml(asset.insCarrier || 'carrier')})`]);
  recordsOf('inspections').forEach((r) => {
    const d = daysUntil(r.nextDue);
    if (d != null && d < 0) alerts.push(['red', `Inspection overdue ${Math.abs(d)}d - ${escHtml(r.type)}`]);
    else if (d != null && d <= 30) alerts.push(['amber', `Inspection due in ${d}d - ${escHtml(r.type)}`]);
  });
  recordsOf('warranties').forEach((r) => {
    const d = daysUntil(r.expiration);
    if (d != null && d >= 0 && d <= 90) alerts.push(['amber', `Warranty expires in ${d}d - ${escHtml(r.scope)}`]);
  });
  recordsOf('vendors').forEach((r) => {
    if (!r.coiExpiration) alerts.push(['amber', `Vendor COI missing - ${escHtml(r.company)}`]);
    else {
      const d = daysUntil(r.coiExpiration);
      if (d != null && d < 0) alerts.push(['red', `Vendor COI lapsed ${Math.abs(d)}d - ${escHtml(r.company)}`]);
    }
  });
  const alertsHtml = alerts.length
    ? `<div class="alerts">${alerts.slice(0, 10).map(([tone, msg]) => `<div class="alert ${tone}">${msg}</div>`).join('')}</div>`
    : `<div class="alerts"><div class="alert green">All current - no open compliance items.</div></div>`;

  // Small helpers for the report's key/value cards and data tables.
  const kvTable = (pairs) => `<table class="kv"><tbody>${pairs.map(([label, value, mono]) =>
    `<tr><td class="k">${escHtml(label)}</td><td class="v${mono === false ? ' txt' : ''}">${escOrDash(value)}</td></tr>`).join('')}</tbody></table>`;

  const card = (num, title, body) => body
    ? `<section class="card"><div class="card-h">${num == null ? '' : `<span class="num">${num}</span>`}<span>${escHtml(title)}</span></div>${body}</section>`
    : '';

  // Status chip for a table row: 'w' = warranty-style, 'i' = inspection-style, else renewal-style.
  const statusChip = (kind, days) => {
    if (days == null) return `<span class="chip mut">-</span>`;
    if (kind === 'w') return days < 0 ? `<span class="chip mut">Expired</span>` : days <= 90 ? `<span class="chip amber">${days}d</span>` : `<span class="chip green">Active</span>`;
    if (kind === 'i') return days < 0 ? `<span class="chip red">Overdue ${Math.abs(days)}d</span>` : days <= 30 ? `<span class="chip amber">${days}d</span>` : `<span class="chip green">Current</span>`;
    return days < 0 ? `<span class="chip red">Lapsed</span>` : days <= 60 ? `<span class="chip amber">${days}d</span>` : `<span class="chip green">Current</span>`;
  };

  // Renders a data table for a collection: `columns` is [key, header, format?] where format is
  // 'date' or plain text/mono. `statusKey`/`statusKind` add a trailing Status column driven by
  // daysUntil(row[statusKey]).
  const dataTable = (coll, columns, statusKey, statusKind) => {
    const recs = recordsOf(coll);
    if (!recs.length) return '';
    const headerCells = columns.map(([, header]) => `<th>${escHtml(header)}</th>`).join('') + (statusKind ? '<th>Status</th>' : '');
    const bodyRows = recs.map((r) => {
      const cells = columns.map(([key, , fmt]) => `<td${fmt === 'date' ? ' class="mono"' : ''}>${fmt === 'date' ? escDate(r[key]) : escOrDash(r[key])}</td>`).join('');
      const statusCell = statusKind ? `<td>${statusChip(statusKind, daysUntil(r[statusKey]))}</td>` : '';
      return `<tr>${cells}${statusCell}</tr>`;
    }).join('');
    return `<table class="data"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
  };

  const metricTile = (value, label) => `<div class="m"><div class="mv">${value}</div><div class="ml">${escHtml(label)}</div></div>`;

  const statusClass = devStageClass(asset.devStage);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(asset.name)} - Asset Report</title><style>
@page{size:A4;margin:14mm 13mm 16mm}
*{box-sizing:border-box}body{font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a;margin:0;font-size:11.5px;line-height:1.45}
.band{background:#0f172a;color:#fff;padding:16px 18px;border-radius:10px;display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px}
.band h1{margin:0;font-size:20px;letter-spacing:-.01em}.band .sub{color:#cbd5e1;font-size:11px;margin-top:3px}
.band .r{text-align:right;font-size:10px;color:#cbd5e1;line-height:1.6}.band .r b{color:#fff;letter-spacing:1px}
.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:14px}
.m{border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px}.mv{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:15px}.ml{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin-top:2px}
.alerts{margin-bottom:16px}.alert{padding:7px 11px;border-radius:7px;font-size:11px;font-weight:600;margin-bottom:5px;border-left:3px solid}
.alert.red{background:#fef2f2;color:#b91c1c;border-color:#dc2626}.alert.amber{background:#fffbeb;color:#b45309;border-color:#d97706}.alert.green{background:#f0fdf4;color:#15803d;border-color:#16a34a}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#0f172a;margin:18px 0 8px}
.card{border:1px solid #e5e7eb;border-radius:9px;padding:13px 15px;margin-bottom:11px;break-inside:avoid}
.card-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;margin-bottom:9px;padding-bottom:7px;border-bottom:1px solid #eef2f7}
.num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:#0f172a;color:#fff;font-size:10px;font-family:ui-monospace,Menlo,monospace}
table{width:100%;border-collapse:collapse}
table.kv{display:grid;grid-template-columns:1fr 1fr;gap:0 22px}table.kv tbody{display:contents}table.kv tr{display:grid;grid-template-columns:46% 54%;padding:3px 0;border-bottom:1px solid #f4f6f9}
.kv .k{color:#64748b;font-size:9px;text-transform:uppercase;letter-spacing:.03em;align-self:center}.kv .v{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:10.5px}.kv .v.txt{font-family:inherit;font-weight:500}
table.data{border:1px solid #e5e7eb;border-radius:8px;font-size:10px;margin-top:4px;overflow:hidden}
table.data th{background:#f8fafc;text-transform:uppercase;font-size:8.5px;letter-spacing:.03em;color:#64748b;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb}
table.data td{padding:6px 8px;border-bottom:1px solid #f4f6f9;vertical-align:top}table.data td.mono{font-family:ui-monospace,Menlo,monospace}
.chip{display:inline-block;font-size:8.5px;font-weight:700;padding:2px 7px;border-radius:999px}
.chip.green{background:#dcfce7;color:#15803d}.chip.amber{background:#fef3c7;color:#b45309}.chip.red{background:#fee2e2;color:#b91c1c}.chip.mut{background:#f1f5f9;color:#64748b}
.foot{margin-top:18px;padding-top:9px;border-top:1px solid #e5e7eb;font-size:9px;color:#94a3b8;display:flex;justify-content:space-between}
section{break-inside:avoid}
</style></head><body>
<div class="band"><div><h1>${escHtml(asset.name)}</h1><div class="sub">${escHtml(formatAddress(asset))}${asset.county ? ` · ${escHtml(formatCounty(asset.county))}` : ''} · APN ${escHtml(asset.apn || '-')}</div></div>
<div class="r"><b>GREENS</b><br>Asset Report<br>${escHtml(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}<br>by ${escHtml(currentUser())}</div></div>

<div class="metrics">
${metricTile(formatNumber(asset.nrsf), 'NRSF')}${metricTile(toNumber(asset.unitsTotal) ? formatNumber(asset.unitsTotal) : '-', 'Units')}${metricTile(acresOf(asset.acreage, asset.acreageUnit) ? acresOf(asset.acreage, asset.acreageUnit).toFixed(2) + ' ac' : '-', 'Acreage')}${metricTile(escOrDash(asset.yearBuilt), 'Year built')}${metricTile(groupMembers.length > 1 ? groupMembers.length : '-', 'Linked')}${metricTile(statusClass, 'Status')}
</div>

<h2>Status &amp; alerts</h2>
${alertsHtml}

${card(1, 'Identity & ownership', kvTable([['Operating entity', asset.entity, false], ['Parcel role', asset.parcelRole, false], ['Builder (GC)', asset.builder, false], ['Asset manager', asset.manager, false], ['County', asset.county, false], ['Legal description', asset.legalDesc, false]]))}
${card(2, 'Building & site', kvTable([['Year built', asset.yearBuilt], ['Construction', asset.constructionType, false], ['Stories', asset.stories], ['NRSF', asset.nrsf ? formatNumber(asset.nrsf) : ''], ['GSF', asset.gsf ? formatNumber(asset.gsf) : ''], ['Acreage', acresOf(asset.acreage, asset.acreageUnit) ? acresOf(asset.acreage, asset.acreageUnit).toFixed(2) : ''], ['Zoning / land use', asset.zoning, false], ['Flood zone', asset.floodZone], ['Sprinklered', asset.sprinklered, false], ['Alarm monitored', asset.alarmMonitored, false], ['Development stage', asset.devStage, false]]))}
${card(3, 'Placed in service', kvTable([['Placed-in-service', formatDate(asset.placedInService)], ['CO number', asset.coNumber], ['CO date', formatDate(asset.coDate)]]))}
${card(4, 'Unit mix', kvTable([['Non-climate', asset.unitsNonClimate ? formatNumber(asset.unitsNonClimate) : ''], ['Climate-controlled', asset.unitsClimate ? formatNumber(asset.unitsClimate) : ''], ['Vehicle', asset.unitsRV ? formatNumber(asset.unitsRV) : ''], ['Total units', asset.unitsTotal ? formatNumber(asset.unitsTotal) : '']]))}
${card(5, 'Insurance', kvTable([['Carrier', asset.insCarrier, false], ['Policy #', asset.insPolicy], ['Expiration', formatDate(asset.insExpiration)], ['Agent / broker', [asset.insAgent, asset.insPhone].filter(Boolean).join(' · '), false]]))}
${card(6, 'Property tax', kvTable([['Tax account', asset.taxId], ['Annual tax', asset.taxAnnual ? formatMoney(asset.taxAnnual) : ''], ['Due dates', asset.taxDue, false]]))}
${groupMembers.length > 1 ? `<section class="card"><div class="card-h"><span>Related properties - ${escHtml(asset.siteName)}</span></div>
<table class="data"><thead><tr><th>Property</th><th>APN</th><th>NRSF</th><th>Units</th><th>Acres</th></tr></thead><tbody>
${groupMembers.map((p) => `<tr><td>${escHtml(p.name)}${p.id === asset.id ? ' (this property)' : ''}</td><td class="mono">${escOrDash(p.apn)}</td><td class="mono">${formatNumber(p.nrsf)}</td><td class="mono">${toNumber(p.unitsTotal) ? formatNumber(p.unitsTotal) : '-'}</td><td class="mono">${acresOf(p.acreage, p.acreageUnit) ? acresOf(p.acreage, p.acreageUnit).toFixed(2) : '-'}</td></tr>`).join('')}
<tr style="font-weight:700;background:#f8fafc"><td>Combined</td><td>-</td><td class="mono">${formatNumber(totals.nrsf)}</td><td class="mono">${formatNumber(totals.units)}</td><td class="mono">${totals.ac.toFixed(2)}</td></tr>
</tbody></table></section>` : ''}

${(() => { const t = dataTable('warranties', [['scope', 'Scope'], ['party', 'Party / contractor'], ['kind', 'Type'], ['expiration', 'Expires', 'date']], 'expiration', 'w'); return t ? `<h2>Warranties</h2>${t}` : ''; })()}
${(() => { const t = dataTable('inspections', [['type', 'Inspection'], ['frequency', 'Frequency'], ['vendor', 'Vendor'], ['nextDue', 'Next due', 'date']], 'nextDue', 'i'); return t ? `<h2>Inspections</h2>${t}` : ''; })()}
${(() => { const t = dataTable('documents', [['title', 'Document'], ['category', 'Category'], ['version', 'Version'], ['location', 'Egnyte location']]); return t ? `<h2>Plans &amp; Documents</h2>${t}` : ''; })()}
${(() => { const t = dataTable('ahj', [['authority', 'Authority'], ['jurisdiction', 'Jurisdiction'], ['accountOrPermit', 'Account / permit'], ['renewalDate', 'Renewal', 'date']], 'renewalDate', 'r'); return t ? `<h2>Authorities Having Jurisdiction</h2>${t}` : ''; })()}
${(() => { const t = dataTable('utilities', [['service', 'Service'], ['provider', 'Provider'], ['accountNumber', 'Account #'], ['meterNumber', 'Meter'], ['avgMonthly', 'Avg / mo']]); return t ? `<h2>Utilities</h2>${t}` : ''; })()}
${(() => { const t = dataTable('vendors', [['company', 'Vendor'], ['category', 'Category'], ['contractEnd', 'Contract end', 'date'], ['coiExpiration', 'COI', 'date']], 'coiExpiration', 'r'); return t ? `<h2>Vendors</h2>${t}` : ''; })()}

<div style="margin-top:16px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#f8fafc;font-size:8.5px;line-height:1.55;color:#475569"><strong style="color:#0f172a">CONFIDENTIAL</strong> - This document and the information contained herein are the confidential and proprietary property of the company${asset.entity ? ' and ' + escHtml(asset.entity) : ''}, prepared solely for internal asset-management purposes and authorized recipients. Any review, reproduction, distribution, or disclosure without prior written consent is strictly prohibited.</div><div class="foot"><span>Confidential · Asset Management</span><span>Generated ${escHtml(new Date().toLocaleString())} · ${escHtml(currentUser())}</span></div>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<${'/'}script></body></html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Allow pop-ups to export the PDF report.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
