// Asset Management > Dates (Neil, 11/17/2026): every dated item on the records - property tax
// installments, insurance, registrations, warranties, inspections, permits, renewals - in one
// list. Passed / Next 90 Days / This Year / Missing; grouped by month with "Passed" first; one
// kind in one month collapses to one row that opens to its assets; a mistyped date sits in
// "Check These Dates" with Fix and never counts as passed or due. Mark Paid / Mark Renewed
// rolls a yearly date one year on (onPatchAsset - one log entry per asset, undoable there).
// Missing fills in place (Neil, 11/20/2026 - production had an insurance expiration on 5
// properties): an editor picks the day right on the row instead of opening each property.

import { useMemo, useState, Fragment } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { collectDates, itemsForMode, groupDates, missingByKind, markItems, addDatePatch, datesSummary, DATE_MODES, DATE_KINDS, kindLabel, actionFor, relativeDays, toneOfDays, plural } from '../../lib/datesModel.js';
import { formatDate } from '../../lib/format.js';
import { pushToast } from '../shared/ToastHost.jsx';
import { DateField } from '../../../tasks/components.jsx';
import { C, Sentence, Toolbar, SearchBox, Segmented, FilterMenu, Table, GroupRow, LinkButton, Quiet, td, toneColor } from './tabParts.jsx';

const HEAD = [
  { key: 'what', label: 'What', style: { width: '26%' } },
  { key: 'where', label: 'How Many', style: { width: '24%' } },
  { key: 'when', label: 'When', style: { width: '18%' } },
  { key: 'stands', label: 'Where It Stands' },
  { key: 'act', label: '', style: { width: 1 } },
];

function Actions({ item, canEdit, onMark, openAsset }) {
  const action = actionFor(item);
  return (
    <span style={{ display: 'inline-flex', gap: 14, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
      {action && canEdit && <LinkButton onClick={(e) => { e.stopPropagation(); onMark([item]); }}>{action}</LinkButton>}
      <LinkButton tone={item.suspect ? 'orange' : 'quiet'} onClick={(e) => { e.stopPropagation(); openAsset?.(item.id, item.tab, item.recordId || ''); }}>
        {item.suspect ? 'Fix' : 'Open'}
      </LinkButton>
    </span>
  );
}

export function DatesTab({ store, assets, openAsset, onPatchAsset, canEdit = false }) {
  const [mode, setMode] = useState('next90');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({});
  const [open, setOpen] = useState(() => new Set());

  const live = useMemo(() => (assets || []).filter((a) => a && !a.deleted), [assets]);
  const byId = useMemo(() => Object.fromEntries(live.map((a) => [a.id, a])), [live]);
  const all = useMemo(() => collectDates(store || {}, live), [store, live]);
  const sum = useMemo(() => datesSummary(all, live), [all, live]);

  const q = query.trim().toLowerCase();
  const kinds = filters.kind || [];
  const matches = (x) => (!kinds.length || kinds.includes(x.kind))
    && (!q || `${x.assetName} ${x.name} ${kindLabel(x.kind)} ${x.detail} ${x.date}`.toLowerCase().includes(q));
  const shown = itemsForMode(all, mode).filter(matches);
  const groups = groupDates(shown, byId);
  const missing = mode !== 'missing' ? [] : missingByKind(live)
    .filter((m) => !kinds.length || kinds.includes(m.kind))
    .map((m) => ({ ...m, assets: m.assets.filter((a) => !q || `${a.name} ${a.siteName || ''}`.toLowerCase().includes(q)) }))
    .filter((m) => m.assets.length);

  const kindOptions = Object.keys(DATE_KINDS)
    .map((k) => ({ value: k, label: kindLabel(k), count: all.filter((x) => x.kind === k).length }))
    .filter((o) => o.count || kinds.includes(o.value));

  const mark = (items) => {
    const n = markItems(items, byId, onPatchAsset);
    if (n && pushToast) pushToast(`${items.length === 1 ? 'Rolled to next year' : `${plural(items.length, 'date')} rolled to next year`} - Undo is in Activity.`);
  };
  // A first date typed on the Missing row: one patch, one Activity entry, and the row leaves the list.
  const addDate = (kind, asset, isoDay) => {
    const out = addDatePatch(kind, isoDay);
    if (!out || !onPatchAsset) return;
    onPatchAsset(asset.id, out.patch, out.changes);
    if (pushToast) pushToast(`Added the ${DATE_KINDS[kind].missing} of ${asset.name || asset.siteName || 'the asset'} - Undo is in Activity.`);
  };
  const toggle = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const sentence = [
    sum.passed > 0 && <span key="p" style={{ color: C.red }}>{plural(sum.passed, 'date')} passed without being marked done</span>,
    sum.due90 > 0 && <span key="d">{sum.due90.toLocaleString('en-US')} due in the next 90 days</span>,
    sum.assets > 0 && sum.withInsurance < sum.assets && (
      <span key="i">{sum.withInsurance === 0 ? 'no asset has an insurance expiration on file' : `only ${sum.withInsurance} of ${sum.assets} assets have an insurance expiration on file`}</span>
    ),
    sum.suspect > 0 && <span key="s" style={{ color: C.orange }}>{plural(sum.suspect, 'date')} {sum.suspect === 1 ? 'looks' : 'look'} mistyped</span>,
  ];
  const nothingAtAll = !sentence.some(Boolean);

  return (
    <div data-tab="dates">
      {nothingAtAll ? <Sentence parts={['No dates are on file yet.']} /> : <Sentence parts={sentence} />}
      <Toolbar right={null}>
        <SearchBox value={query} onChange={setQuery} placeholder="Search properties and dates" />
        <FilterMenu groups={[{ key: 'kind', title: 'What', options: kindOptions }]} value={filters} onChange={setFilters} />
        <Segmented label="Show" value={mode} onChange={setMode} options={DATE_MODES} />
      </Toolbar>

      {mode === 'missing' ? (
        missing.length ? (
          <Table label="Missing dates" head={[{ key: 'what', label: 'What Is Missing', style: { width: '30%' } }, { key: 'asset', label: 'Asset' }, { key: 'act', label: '', style: { width: 1 } }]} minWidth={520}>
            {missing.map((m) => (
              <tbody key={m.kind}>
                <GroupRow cols={3} label={`No ${m.label}`} count={m.assets.length} />
                {m.assets.map((a) => (
                  <tr key={a.id}>
                    <td style={{ ...td, color: C.muted }}>{kindLabel(m.kind)}</td>
                    <td style={td}>{a.name || a.siteName || 'Unnamed asset'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {canEdit && onPatchAsset ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
                          <DateField value="" onChange={(day) => addDate(m.kind, a, day)} placeholder="Add Date" color={toneColor('green')}
                            title={`Add the ${m.label} of ${a.name || a.siteName || 'this asset'}`} style={{ fontWeight: 500 }} />
                          <LinkButton tone="quiet" onClick={() => openAsset?.(a.id, 'property')}>Open</LinkButton>
                        </span>
                      ) : <LinkButton onClick={() => openAsset?.(a.id, 'property')}>Add Date</LinkButton>}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </Table>
        ) : <Quiet>Every asset has its tax, insurance and registration dates on file.</Quiet>
      ) : groups.length ? (
        <Table label="Dates" head={HEAD}>
          {groups.map((g) => (
            <tbody key={g.key}>
              <GroupRow cols={HEAD.length} label={g.label} tone={g.key === 'suspect' ? 'orange' : undefined} />
              {g.rows.map((r) => {
                const many = r.items.length > 1;
                const isOpen = open.has(r.key);
                const one = r.items[0];
                return (
                  <Fragment key={r.key}>
                    <tr onClick={many ? () => toggle(r.key) : undefined} style={{ cursor: many ? 'pointer' : 'default' }} aria-expanded={many ? isOpen : undefined}>
                      <td style={{ ...td, fontWeight: 600 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {many && (isOpen ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronRight size={14} color="var(--text-muted)" />)}
                          {r.label}
                        </span>
                        {!many && one.detail && <div style={{ fontSize: 12, fontWeight: 400, color: C.muted }}>{one.detail}</div>}
                      </td>
                      <td style={td}>{r.where}</td>
                      <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.when}</td>
                      <td style={{ ...td, color: toneColor(r.tone), fontWeight: r.tone === 'quiet' ? 400 : 600 }}>{r.stands}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {many
                          ? (r.action && canEdit && <LinkButton onClick={(e) => { e.stopPropagation(); mark(r.items); }} aria-label={`${r.action} for all ${r.items.length}`}>{r.action.replace('Mark ', 'Mark All ')}</LinkButton>)
                          : <Actions item={one} canEdit={canEdit} onMark={mark} openAsset={openAsset} />}
                      </td>
                    </tr>
                    {many && isOpen && r.items.map((x) => (
                      <tr key={x.key}>
                        <td style={{ ...td, paddingLeft: 32, color: C.muted }}>{x.detail || kindLabel(x.kind)}</td>
                        <td style={td}>{x.assetName}</td>
                        <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{x.suspect ? x.date : formatDate(x.iso)}</td>
                        <td style={{ ...td, color: x.suspect ? C.orange : toneColor(toneOfDays(x.days)) }}>{x.suspect ? 'Check this date' : relativeDays(x.days)}</td>
                        <td style={{ ...td, textAlign: 'right' }}><Actions item={x} canEdit={canEdit} onMark={mark} openAsset={openAsset} /></td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          ))}
        </Table>
      ) : (
        <Quiet>{q || kinds.length ? 'No dates match.' : mode === 'passed' ? 'Nothing has passed - every date on file is still ahead.' : 'Nothing falls due in this window.'}</Quiet>
      )}
      {mode !== 'missing' && groups.length > 0 && (
        <Quiet style={{ paddingTop: 12 }}>{canEdit ? 'Mark Paid or Mark Renewed rolls a yearly date to next year and logs who did it.' : 'Dates come from each asset\'s records.'}</Quiet>
      )}
    </div>
  );
}

export default DatesTab;
