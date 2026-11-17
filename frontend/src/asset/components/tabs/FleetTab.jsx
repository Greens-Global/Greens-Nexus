// Asset Management > Fleet (Neil, 11/17/2026): every vehicle and piece of heavy equipment in
// one list - status, plate, who has it, the odometer (the highest believable reading on file,
// lib/nextService.currentOdometer), the last service, and the registration and insurance dates
// ("No date" when none is on file, red once passed). List or Gallery.

import { useMemo, useState } from 'react';
import { List, LayoutGrid } from 'lucide-react';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { fleetStatusColor, fleetMeter } from '../../lib/fleetCards.js';
import { currentOdometer } from '../../lib/nextService.js';
import { parseStoredDate } from '../../lib/criticalItems.js';
import { isoOf, plural } from '../../lib/datesModel.js';
import { snapMap } from '../../lib/assetMetrics.js';
import { formatDate, daysUntil } from '../../lib/format.js';
import { isFleet } from '../../lib/tabSignals.js';
import { C, Sentence, Toolbar, SearchBox, Segmented, FilterMenu, passesFilters, Table, RowButton, NameCell, LinkButton, Quiet, Faint, td, photoOf } from './tabParts.jsx';

const HEAD = [
  { key: 'v', label: 'Vehicle', style: { width: '28%' } },
  { key: 's', label: 'Status' },
  { key: 'p', label: 'Plate' },
  { key: 'a', label: 'Assigned To' },
  { key: 'o', label: 'Odometer' },
  { key: 'l', label: 'Last Service' },
  { key: 'r', label: 'Registration' },
  { key: 'i', label: 'Insurance' },
];

const text = (v) => String(v ?? '').trim();

/** "Ford · Expedition · White" (equipment: make, model, type). */
export function fleetFacts(a) {
  return inferAssetKind(a) === 'equipment'
    ? [a.make, a.model, a.equipType].map(text).filter(Boolean).join(' · ')
    : [a.make, a.model, a.color].map(text).filter(Boolean).join(' · ');
}

/** The newest service date on file (the service log, else the asset's own field), as ISO. */
export function lastServiceOf(a, store) {
  let best = '';
  for (const r of (store && store.vservice) || []) {
    if (r.propertyId !== a.id) continue;
    const iso = isoOf(r.date);
    if (iso && iso > best) best = iso;
  }
  return best || isoOf(a.lastServiceDate);
}

/** A dated fact's state: { state: 'none' | 'suspect' | 'passed' | 'ok', iso, raw }. */
export function dateState(raw) {
  const v = text(raw);
  if (!v) return { state: 'none', raw: '' };
  const p = parseStoredDate(v);
  if (!p) return { state: 'none', raw: v };
  if (p.suspect) return { state: 'suspect', raw: v };
  const days = daysUntil(v);
  return { state: days != null && days < 0 ? 'passed' : 'ok', iso: isoOf(v), raw: v };
}

function DateCell({ s, na }) {
  if (na) return <Faint>-</Faint>;
  if (s.state === 'none') return <span style={{ color: C.orange }}>No date</span>;
  if (s.state === 'suspect') return <span style={{ color: C.orange }} title={s.raw}>Check this date</span>;
  return <span style={{ color: s.state === 'passed' ? C.red : C.ink, fontWeight: s.state === 'passed' ? 600 : 400, fontVariantNumeric: 'tabular-nums' }}>{formatDate(s.iso)}</span>;
}

/** Everything a fleet row shows, worked out once per render. */
export function fleetRow(a, store) {
  const kind = inferAssetKind(a);
  const snap = snapMap(a);
  const vehicle = kind === 'vehicle';
  return {
    a,
    kind,
    status: text(a.devStage),
    plate: vehicle ? text(a.plate) : (text(a.serialNumber) ? `Serial ${text(a.serialNumber)}` : ''),
    assigned: text(a.manager),
    meter: vehicle ? fleetMeter(a, currentOdometer(a, store || {})) : fleetMeter(a),
    lastService: lastServiceOf(a, store),
    reg: vehicle ? dateState(a.regExpiration || snap['registration expiration']) : null,
    ins: dateState(a.insExpiration || snap['policy expiration']),
  };
}

const needsDate = (r) => (r.reg && r.reg.state !== 'ok' && r.reg.state !== 'passed') || (r.ins.state !== 'ok' && r.ins.state !== 'passed');
const hasPassed = (r) => (r.reg && r.reg.state === 'passed') || r.ins.state === 'passed';

function statusWords(rows) {
  const counts = new Map();
  rows.forEach((r) => { const k = r.status || 'Not set'; counts.set(k, (counts.get(k) || 0) + 1); });
  if (counts.size === 1 && counts.has('In Service')) return rows.length === 1 ? 'in service' : 'every one in service';
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${k === 'Not set' ? 'with no status' : k.toLowerCase()}`).join(', ');
}

function fleetCount(rows) {
  const v = rows.filter((r) => r.kind === 'vehicle').length;
  const e = rows.length - v;
  return [v && plural(v, 'vehicle'), e && plural(e, 'piece of equipment', 'pieces of equipment')].filter(Boolean).join(' and ');
}

export function FleetTab({ store, assets, openAsset }) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({});
  const [mode, setMode] = useState('list');
  const [review, setReview] = useState(false);

  const rows = useMemo(() => (assets || []).filter((a) => a && !a.deleted && isFleet(a))
    .map((a) => fleetRow(a, store))
    .sort((x, y) => text(x.a.name).localeCompare(text(y.a.name))), [assets, store]);

  const q = query.trim().toLowerCase();
  const get = (k, r) => (k === 'status' ? r.status || 'Not set' : r.kind);
  const shown = rows.filter((r) => passesFilters(r, filters, get)
    && (!review || needsDate(r) || hasPassed(r))
    && (!q || [r.a.name, r.a.plate, r.a.vin, r.a.serialNumber, r.assigned, r.a.make, r.a.model, r.a.color].map(text).join(' ').toLowerCase().includes(q)));

  if (!rows.length) return <Quiet>No vehicles or heavy equipment yet - add one with + New.</Quiet>;

  const missing = rows.filter(needsDate).length;
  const passed = rows.filter(hasPassed).length;
  const noMeter = rows.filter((r) => !r.meter).length;
  const noPlate = rows.filter((r) => r.kind === 'vehicle' && !r.plate).length;
  const vehicles = rows.filter((r) => r.kind === 'vehicle').length;
  const counts = [...new Set(rows.map((r) => r.status || 'Not set'))].map((s) => ({ value: s, label: s, count: rows.filter((r) => (r.status || 'Not set') === s).length }));
  const kinds = [['vehicle', 'Vehicles'], ['equipment', 'Heavy Equipment']].map(([v, l]) => ({ value: v, label: l, count: rows.filter((r) => r.kind === v).length })).filter((o) => o.count);

  const needs = [
    passed > 0 && <span key="p" style={{ color: C.red, fontWeight: 600 }}>{plural(passed, 'has a date that has', 'have a date that has')} passed</span>,
    missing > 0 && <span key="m" style={{ color: C.orange, fontWeight: 600 }}>{missing} {missing === 1 ? 'has' : 'have'} no registration or insurance date on file</span>,
    vehicles > 0 && noMeter === rows.length && noPlate === vehicles && <span key="n">none has an odometer reading or a plate</span>,
    vehicles > 0 && noPlate > 0 && noPlate < vehicles && <span key="pl">{plural(noPlate, 'vehicle has', 'vehicles have')} no plate</span>,
    (passed > 0 || missing > 0) && <LinkButton key="r" onClick={() => setReview((v) => !v)}>{review ? 'Show All' : 'Review'}</LinkButton>,
  ];

  return (
    <div data-tab="fleet">
      <Sentence parts={[`${fleetCount(rows)} - ${statusWords(rows)}.`]} />
      <Sentence size={13} parts={needs} style={{ fontWeight: 400, marginTop: 4 }} />
      <Toolbar right={<Segmented label="View" value={mode} onChange={setMode}
        options={[{ key: 'list', label: 'List', icon: <List size={14} /> }, { key: 'gallery', label: 'Gallery', icon: <LayoutGrid size={14} /> }]} />}>
        <SearchBox value={query} onChange={setQuery} placeholder="Search plate, VIN, driver" />
        <FilterMenu groups={[{ key: 'status', title: 'Status', options: counts }, { key: 'kind', title: 'Kind', options: kinds.length > 1 ? kinds : [] }]} value={filters} onChange={setFilters} />
      </Toolbar>

      {!shown.length ? <Quiet>No vehicles match.</Quiet> : mode === 'gallery' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '24px 20px', marginTop: 12 }}>
          {shown.map((r) => (
            <button key={r.a.id} type="button" onClick={() => openAsset?.(r.a.id)}
              style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: C.ink }}>
              <span aria-hidden="true" style={{ display: 'block', aspectRatio: '16 / 10', borderRadius: 10, background: photoOf(r.a) ? `#fff url("${photoOf(r.a).replace(/"/g, '%22')}") center / contain no-repeat` : 'var(--bg-secondary)' }} />
              <span style={{ display: 'block', fontSize: 15, fontWeight: 600, marginTop: 10 }}>{r.a.name || 'Unnamed'}</span>
              <span style={{ display: 'block', fontSize: 12, color: C.muted, marginTop: 2 }}>{[fleetFacts(r.a), r.plate].filter(Boolean).join(' · ') || 'No details on file'}</span>
              <span style={{ display: 'block', fontSize: 12, marginTop: 4, color: r.status ? fleetStatusColor(r.status) : C.faint, fontWeight: 500 }}>
                {r.status || 'No status'}{r.assigned ? <span style={{ color: C.muted, fontWeight: 400 }}>{` · ${r.assigned}`}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Table label="Vehicles and equipment" head={HEAD} minWidth={960}>
          <tbody>
            {shown.map((r) => (
              <RowButton key={r.a.id} label={r.a.name} onOpen={() => openAsset?.(r.a.id)}>
                <td style={td}><NameCell src={photoOf(r.a)} contain name={r.a.name || 'Unnamed'} sub={fleetFacts(r.a)} /></td>
                <td style={{ ...td, color: r.status ? fleetStatusColor(r.status) : C.faint, fontWeight: 500 }}>{r.status || 'Not set'}</td>
                <td style={td}>{r.plate || <Faint />}</td>
                <td style={td}>{r.assigned || <Faint />}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.meter || <Faint>-</Faint>}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.lastService ? formatDate(r.lastService) : <Faint>-</Faint>}</td>
                <td style={td}><DateCell s={r.reg || {}} na={!r.reg} /></td>
                <td style={td}><DateCell s={r.ins} /></td>
              </RowButton>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

export default FleetTab;
