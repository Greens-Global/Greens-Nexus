// Asset Management > Development (Neil, 11/17/2026): every property in the pipeline - In
// Escrow, Entitlement, Construction Drawings, Construction, Stabilized - Renovation - grouped by
// stage in pipeline order, with its approvals (the development timeline), its permits and the
// ones waiting on us. Modes: By Stage / Permits (one row per permit) / Timelines (one row per
// approval still to come).

import { useMemo, useState } from 'react';
import ProgressTrack from '../../../ui/ProgressTrack.jsx';
import { permitValue, PERMIT_KEYS, parseStoredDate } from '../../lib/criticalItems.js';
import { isoOf, plural } from '../../lib/datesModel.js';
import { formatDate, daysUntil } from '../../lib/format.js';
import { PIPELINE, pipelineStepOf } from '../../lib/tabSignals.js';
import { C, Sentence, Toolbar, SearchBox, Segmented, FilterMenu, passesFilters, Table, RowButton, GroupRow, NameCell, Quiet, Faint, td, toneColor, photoOf } from './tabParts.jsx';

const CLOSED = /^(closed|approved|permitted|issued|finaled|n\/a|na)\b/i;
const text = (v) => String(v ?? '').trim();

/** A permit is open unless its status says it is done (closed, approved, issued...). */
export const permitOpen = (row) => !CLOSED.test(permitValue(row, PERMIT_KEYS.status));
/** The ball is in our court: "Ball in whose Court" starts with "our". */
export const permitOurs = (row) => /^our/i.test(permitValue(row, PERMIT_KEYS.court));

/** The development timeline's approvals: { done, na, total, required }. */
export function approvalsOf(asset) {
  const rows = asset.timeline || [];
  const st = (r) => text(r.status).toLowerCase();
  const done = rows.filter((r) => st(r) === 'complete').length;
  const na = rows.filter((r) => st(r) === 'n/a' || st(r) === 'na').length;
  return { done, na, total: rows.length, required: rows.length - na };
}

const nameOf = (a) => a.name || a.siteName || 'Unnamed property';
const placeOf = (a) => [a.city, a.state].map(text).filter(Boolean).join(', ');

function Approvals({ ap }) {
  if (!ap.total) return <Faint>No timeline</Faint>;
  if (!ap.required) return <Faint>All not applicable</Faint>;
  const v = ap.done / ap.required;
  return <ProgressTrack value={v} size="sm" state={v >= 1 ? 'done' : 'live'} label="Approvals" note={`${ap.done} of ${ap.required} approvals`} style={{ maxWidth: 240 }} />;
}

function statusTone(status) {
  const s = text(status).toLowerCase();
  if (s.includes('complete') || CLOSED.test(s)) return 'green';
  if (s.includes('progress')) return 'live';
  if (/denied|expired|rejected/.test(s)) return 'red';
  return 'quiet';
}

function Expiration({ raw }) {
  const v = text(raw);
  if (!v || /^n\/?a$/i.test(v)) return <Faint>-</Faint>;
  const p = parseStoredDate(v);
  if (!p) return <span>{v}</span>;
  if (p.suspect) return <span style={{ color: C.orange }} title={v}>Check this date</span>;
  const days = daysUntil(v);
  return <span style={{ color: days < 0 ? C.red : C.ink, fontVariantNumeric: 'tabular-nums' }}>{formatDate(isoOf(v))}</span>;
}

const MODES = [{ key: 'stage', label: 'By Stage' }, { key: 'permits', label: 'Permits' }, { key: 'timelines', label: 'Timelines' }];

export function DevelopmentTab({ assets, openAsset }) {
  const [mode, setMode] = useState('stage');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({});

  const pipe = useMemo(() => (assets || []).filter((a) => a && !a.deleted && pipelineStepOf(a))
    .map((a) => {
      const permits = a.permits || [];
      return { a, step: pipelineStepOf(a), ap: approvalsOf(a), permits, open: permits.filter(permitOpen).length, ours: permits.filter((p) => permitOpen(p) && permitOurs(p)).length };
    })
    .sort((x, y) => nameOf(x.a).localeCompare(nameOf(y.a))), [assets]);

  if (!pipe.length) return <Quiet>No property is in development right now - nothing is in escrow, entitlement, drawings, construction or renovation.</Quiet>;

  const q = query.trim().toLowerCase();
  const hit = (...vals) => !q || vals.map(text).join(' ').toLowerCase().includes(q);
  const inFilter = pipe.filter((r) => passesFilters(r, filters, (k, x) => x.step.key));
  const waiting = pipe.reduce((n, r) => n + r.ours, 0);
  const noTimeline = pipe.filter((r) => !r.ap.total).length;

  const sentence = [
    <span key="p">{plural(pipe.length, 'property', 'properties')} in the pipeline</span>,
    waiting > 0 && <span key="w" style={{ color: C.live }}>{plural(waiting, 'permit')} waiting on us</span>,
    noTimeline > 0 && <span key="t">{noTimeline} without a timeline</span>,
  ];
  const stageOptions = PIPELINE.map((s) => ({ value: s.key, label: s.label, count: pipe.filter((r) => r.step.key === s.key).length })).filter((o) => o.count);

  let body;
  if (mode === 'permits') {
    const rows = inFilter.flatMap((r) => r.permits.map((p, i) => ({ r, p, i })))
      .filter(({ r, p }) => hit(nameOf(r.a), ...Object.values(p)));
    body = rows.length ? (
      <Table label="Permits" minWidth={900} head={[{ key: 'p', label: 'Property' }, { key: 't', label: 'Permit' }, { key: 'a', label: 'Agency' }, { key: 's', label: 'Status' }, { key: 'b', label: 'Ball in Court' }, { key: 'e', label: 'Expiration' }]}>
        <tbody>
          {rows.map(({ r, p, i }) => {
            const status = permitValue(p, PERMIT_KEYS.status);
            const court = permitValue(p, PERMIT_KEYS.court);
            return (
              <RowButton key={`${r.a.id}-${i}`} onOpen={() => openAsset?.(r.a.id, 'permit', String(i))}>
                <td style={{ ...td, fontWeight: 600 }}>{nameOf(r.a)}</td>
                <td style={td}>
                  {permitValue(p, PERMIT_KEYS.type) || <Faint>Permit</Faint>}
                  {permitValue(p, PERMIT_KEYS.number) && <div style={{ fontSize: 12, color: C.muted }}>{permitValue(p, PERMIT_KEYS.number)}</div>}
                </td>
                <td style={td}>{permitValue(p, PERMIT_KEYS.agency) || <Faint>-</Faint>}</td>
                <td style={{ ...td, color: status ? toneColor(statusTone(status)) : C.faint, fontWeight: 500 }}>{status || 'No status'}</td>
                <td style={td}>{permitOurs(p) && permitOpen(p) ? <span style={{ color: C.live, fontWeight: 600 }}>Ours</span> : court || <Faint>-</Faint>}</td>
                <td style={td}><Expiration raw={permitValue(p, PERMIT_KEYS.expiration)} /></td>
              </RowButton>
            );
          })}
        </tbody>
      </Table>
    ) : <Quiet>{q ? 'No permits match.' : 'No permits are on file for these properties.'}</Quiet>;
  } else if (mode === 'timelines') {
    const rows = inFilter.flatMap((r) => (r.a.timeline || []).map((t, i) => ({ r, t, i })))
      .filter(({ t }) => !/^(complete|n\/?a)$/i.test(text(t.status)))
      .filter(({ r, t }) => hit(nameOf(r.a), t.phase, t.permit, t.agency, t.status));
    body = rows.length ? (
      <Table label="Approvals to come" minWidth={860} head={[{ key: 'p', label: 'Property' }, { key: 'ph', label: 'Phase' }, { key: 'ap', label: 'Approval' }, { key: 'ag', label: 'Agency' }, { key: 's', label: 'Status' }, { key: 'rt', label: 'Review Time' }]}>
        <tbody>
          {rows.map(({ r, t, i }) => (
            <RowButton key={`${r.a.id}-${i}`} onOpen={() => openAsset?.(r.a.id, 'timeline', String(i))}>
              <td style={{ ...td, fontWeight: 600 }}>{nameOf(r.a)}</td>
              <td style={td}>{text(t.phase) || <Faint>-</Faint>}</td>
              <td style={td}>{text(t.permit) || <Faint>-</Faint>}</td>
              <td style={td}>{text(t.agency) || <Faint>-</Faint>}</td>
              <td style={{ ...td, color: text(t.status) ? toneColor(statusTone(t.status)) : C.faint, fontWeight: 500 }}>{text(t.status) || 'Not started'}</td>
              <td style={{ ...td, color: C.muted }}>{text(t.reviewTime) || '-'}</td>
            </RowButton>
          ))}
        </tbody>
      </Table>
    ) : <Quiet>{q ? 'No approvals match.' : 'Every approval on these timelines is complete or not applicable.'}</Quiet>;
  } else {
    const rows = inFilter.filter((r) => hit(nameOf(r.a), placeOf(r.a), r.a.manager, ...r.permits.flatMap((p) => Object.values(p))));
    body = rows.length ? (
      <Table label="Pipeline" minWidth={900} head={[{ key: 'p', label: 'Property', style: { width: '32%' } }, { key: 'a', label: 'Approvals', style: { width: 260 } }, { key: 'pe', label: 'Permits' }, { key: 'b', label: 'Ball in Our Court' }, { key: 'm', label: 'Asset Manager' }]}>
        {PIPELINE.map((step) => {
          const list = rows.filter((r) => r.step.key === step.key);
          if (!list.length) return null;
          return (
            <tbody key={step.key}>
              <GroupRow cols={5} label={step.label} count={list.length} tone={step.tone} />
              {list.map((r) => (
                <RowButton key={r.a.id} label={nameOf(r.a)} onOpen={() => openAsset?.(r.a.id, r.ap.total ? 'timeline' : 'property')}>
                  <td style={td}><NameCell src={photoOf(r.a)} name={nameOf(r.a)} sub={placeOf(r.a)} /></td>
                  <td style={td}><Approvals ap={r.ap} /></td>
                  <td style={td}>{r.open ? <span>{r.open} open <span style={{ color: C.muted }}>of {r.permits.length}</span></span> : r.permits.length ? <span style={{ color: C.green }}>All closed</span> : <Faint>None</Faint>}</td>
                  <td style={td}>{r.ours ? <span style={{ color: C.live, fontWeight: 600 }}>Ours{r.ours > 1 ? ` - ${r.ours}` : ''}</span> : <Faint>-</Faint>}</td>
                  <td style={td}>{text(r.a.manager) || <Faint />}</td>
                </RowButton>
              ))}
            </tbody>
          );
        })}
      </Table>
    ) : <Quiet>No properties match.</Quiet>;
  }

  return (
    <div data-tab="development">
      <Sentence parts={sentence} />
      <Toolbar right={<Segmented label="Show" value={mode} onChange={setMode} options={MODES} />}>
        <SearchBox value={query} onChange={setQuery} placeholder="Search properties, permits, agencies" />
        <FilterMenu groups={[{ key: 'stage', title: 'Stage', options: stageOptions }]} value={filters} onChange={setFilters} />
      </Toolbar>
      {body}
    </div>
  );
}

export default DevelopmentTab;
