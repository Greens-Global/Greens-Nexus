// Item Management - CSV export, the import template and the import file parser.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { ITEM_TYPES, normalizeType, STATUS_META, OP_STATUS_META, displayStatus } from './status';

// ── Import helpers ──────────────────────────────────────────────────────────────
// Maps a parsed spreadsheet (array-of-rows, header first) to item rows. Works
// for CSV, XLSX, and XLS because SheetJS produces the same matrix for all three
// - and it strips the UTF-8 BOM Excel prepends to the first header cell (the
// reason "Name column not found" fired on a file that clearly had one). Jun 16.
function mapItemsMatrix(matrix, customFields = []) {
  const grid = (matrix || []).filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim() !== ''));
  if (grid.length < 2) return { rows: [], error: 'File looks empty - needs a header row plus at least one item.' };
  const header = grid[0].map(h => String(h ?? '').trim().toLowerCase());
  const idx = {
    serial_number: header.findIndex(h => ['serial','serial number','serial_number','serial no','asset tag','asset_tag'].includes(h)),
    name:          header.findIndex(h => ['name','item','item name'].includes(h)),
    item_type:     header.findIndex(h => ['type','item_type','item type'].includes(h)),
    make:          header.findIndex(h => h === 'make'),
    model:         header.findIndex(h => h === 'model'),
    year:          header.findIndex(h => h === 'year'),
    department:    header.findIndex(h => ['department','dept'].includes(h)),
    default_owner: header.findIndex(h => ['owner','default_owner','default owner'].includes(h)),
    ownership_type:header.findIndex(h => ['ownership','ownership_type','ownership type'].includes(h)),
    location:      header.findIndex(h => ['location','site'].includes(h)),
  };
  if (idx.name === -1) return { rows: [], error: 'Could not find a "Name" column in the header.' };
  // Map any header that matches a custom field's label → that field's key.
  const cfCols = (customFields || [])
    .map(f => ({ key: f.fieldKey, col: header.findIndex(h => h === f.label.trim().toLowerCase()) }))
    .filter(x => x.col > -1);
  const rows = grid.slice(1).map(cells => {
    const get = i => (i > -1 ? String(cells[i] ?? '').trim() : '');
    const name = get(idx.name);
    const item_type = normalizeType(get(idx.item_type));
    const ownership_type = get(idx.ownership_type) || 'transient';
    const custom_fields = {};
    for (const { key, col } of cfCols) {
      const v = get(col);
      if (v) custom_fields[key] = v;
    }
    return {
      name, serial_number: get(idx.serial_number), item_type, make: get(idx.make), model: get(idx.model), year: get(idx.year),
      department: get(idx.department), default_owner: get(idx.default_owner),
      ownership_type: ownership_type.toLowerCase(),
      location: get(idx.location),
      custom_fields,
      _valid: !!name,
      _unknownType: !!item_type && !ITEM_TYPES.includes(item_type),
    };
  });
  return { rows, error: null };
}

// Read a spreadsheet file (csv/xlsx/xls) into the item-row shape. SheetJS is
// dynamically imported so it only loads when someone actually imports a file.
export async function parseItemsFile(file, customFields = []) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], error: 'That file has no sheets to read.' };
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return mapItemsMatrix(matrix, customFields);
}

function csvField(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// Export the DISPLAY status (Unassigned / Assigned · Location / Checked out …)
// rather than the raw lifecycle string, so who-has-what round-trips (P4). The
// unclear "Lifecycle"/"Status" pair is renamed to "Status" (deployment state) and
// "Condition" (op-status). Extra columns are ignored on re-import.
function itemDisplayStatusLabel(i) {
  const s = displayStatus(i);
  if (s === 'location_assigned') return i.location ? `Assigned · ${i.location}` : 'Assigned · Location';
  return STATUS_META[s]?.label || s || '';
}
export function downloadItemsCsv(items, customFields = []) {
  // Serial leads the export so re-importing this file updates rows in place
  // (the importer matches on serial, not name). Display status + holder columns +
  // every custom field follow the core columns, so a round-trip carries the full record.
  const cf = customFields || [];
  const header = ['Serial','Name','Type','Make','Model','Year','Department','Owner','Ownership','Location','Status','Condition','Assigned To Name','Assigned To Email', ...cf.map(f => f.label)];
  const lines = [header.map(csvField).join(',')];
  for (const i of items) {
    const base = [i.serialNumber,i.name,i.itemType,i.make,i.model,i.year,i.department,i.defaultOwner,i.ownershipType,i.location,
      itemDisplayStatusLabel(i), OP_STATUS_META[i.opStatus]?.label || i.opStatus || '',
      i.assignedToName || '', i.assignedToEmail || ''];
    const extra = cf.map(f => (i.customFields && i.customFields[f.fieldKey] != null) ? i.customFields[f.fieldKey] : '');
    lines.push([...base, ...extra].map(csvField).join(','));
  }
  triggerDownload(`items-catalog-${new Date().toISOString().slice(0,10)}.csv`, new Blob([lines.join('\r\n')], { type:'text/csv;charset=utf-8;' }));
}

export function downloadImportTemplate(customFields = []) {
  // Leave Serial blank for new units - Nexus assigns one. Keep a row's serial to
  // update that exact unit on re-import. Custom-field columns are appended so the
  // template stays in sync with whatever fields have been defined.
  const cf = customFields || [];
  const header = ['Serial','Name','Type','Make','Model','Year','Department','Owner','Ownership','Location', ...cf.map(f => f.label)];
  const samples = [
    ['', 'Dell XPS 15 Laptop','Devices','Dell','XPS 15','2023','IT','IT Department','permanent','GSE'],
    ['', 'DeWalt Cordless Drill','Tools','DeWalt','DCD777C2','','Construction','Tool Crib','transient','GSVC'],
    ['', 'Ford F-150 Pickup','Vehicles','Ford','F-150','2022','Construction','Fleet Team','permanent','Yard'],
  ];
  const lines = [header, ...samples.map(r => [...r, ...cf.map(() => '')])].map(r => r.map(csvField).join(','));
  triggerDownload('items-import-template.csv', new Blob([lines.join('\r\n')], { type:'text/csv;charset=utf-8;' }));
}
