// Asset Management > Overview (Neil, 11/17/2026: "I don't need the useless information. Make
// it relevant or take it out"): ONE prioritized worklist - what needs doing, nothing
// descriptive. Mine (the assets I manage) or Everyone. Groups, in order: Overdue (dates passed,
// preventive maintenance overdue, expired permits), Open Work (open tickets per property,
// permits with the ball in our court), Next 30 Days, To Fix (mistyped dates, flagged fields, no
// asset manager). Every row carries its own action: Mark Paid / Mark Renewed, Open, Fix,
// Review, Assign.

import { useMemo, useState, Fragment } from 'react';
import { CircleCheck, ChevronRight, ChevronDown } from 'lucide-react';
import { SkeletonBlocks } from '../../../components/AsyncState';
import { useTableValue } from '../../../tasks/tableCols.jsx';
import { collectDates, bucketOf, kindLabel, actionFor, markItems, assetNoun, plural } from '../../lib/datesModel.js';
import { permitValue, PERMIT_KEYS } from '../../lib/criticalItems.js';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { formatDate } from '../../lib/format.js';
import { useMaintenancePortfolio } from '../../lib/tabSignals.js';
import { pushToast } from '../shared/ToastHost.jsx';
import { C, Segmented, LinkButton, Quiet, toneColor, personKey } from './tabParts.jsx';
import { permitOpen, permitOurs } from './DevelopmentTab.jsx';

export const GROUP_CAP = 8;
const GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'work', label: 'Open Work' },
  { key: 'soon', label: 'Next 30 Days' },
  { key: 'fix', label: 'To Fix' },
];

/** The ways the signed-in person may be written in an asset's free-text manager field. */
export function myNames(session) {
  const s = session || {};
  const out = new Set();
  [s.name, s.displayName, s.userName, s.fullName].forEach((v) => { const k = personKey(v); if (k) out.add(k); });
  const email = String(s.email || s.username || '').trim().toLowerCase();
  if (email) {
    out.add(email);
    const local = email.split('@')[0];
    if (local) out.add(local.replace(/[._-]+/g, ' ').trim());
  }
  return out;
}

/** Is this asset managed by me? */
export const managedBy = (asset, names) => {
  const k = personKey(asset && asset.manager);
  return !!k && names.has(k);
};

const nameOf = (a) => (a && (a.name || a.siteName)) || 'Unnamed asset';
const overdueWords = (d) => `${-d} ${d === -1 ? 'day' : 'days'} overdue`;
const soonWords = (d) => (d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `In ${d} days`);

/** Date items -> rows, same kind and same day collapsed ("Property tax installment - 30
 *  properties - 12/10/2026"). */
function dateRows(items, byId, group) {
  const m = new Map();
  items.forEach((x) => {
    const k = `${x.kind}~${x.suspect ? x.date : x.iso}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  });
  return [...m.entries()].map(([k, list]) => {
    const x = list[0];
    const action = list.every((y) => actionFor(y)) ? actionFor(x) : '';
    const fix = group === 'fix';
    return {
      key: `${group}~${k}`,
      what: kindLabel(x.kind),
      detail: list.length === 1 ? x.detail : '',
      where: list.length === 1 ? x.assetName : assetNoun(list, byId),
      when: fix ? x.date : group === 'overdue' ? overdueWords(x.days) : soonWords(x.days),
      whenSub: fix ? '' : formatDate(x.iso),
      tone: fix ? 'orange' : group === 'overdue' ? 'red' : x.days <= 1 ? 'live' : 'ink',
      items: list,
      sort: fix ? 0 : x.days,
      kind: fix ? 'fix' : 'date',
      action,
    };
  });
}

/**
 * The worklist, as groups of rows: [{ key, label, rows }] (empty groups left out). Inputs:
 *   assets       the assets in scope (Mine or Everyone)
 *   store        the module store (records for the dates)
 *   maintenance  GET /maintenance/portfolio's answer or null (not loaded / not for this person)
 *   everyone     the Everyone scope (adds the one "no asset manager" row)
 */
export function buildWorklist({ assets, store, maintenance, everyone }) {
  const live = (assets || []).filter((a) => a && !a.deleted);
  const byId = Object.fromEntries(live.map((a) => [a.id, a]));
  const items = collectDates(store || {}, live);
  const groups = { overdue: [], work: [], soon: [], fix: [] };

  groups.overdue.push(...dateRows(items.filter((x) => bucketOf(x) === 'passed'), byId, 'overdue'));
  groups.soon.push(...dateRows(items.filter((x) => !x.suspect && x.days >= 0 && x.days <= 30), byId, 'soon'));
  groups.fix.push(...dateRows(items.filter((x) => x.suspect), byId, 'fix'));

  // Permits: an expired one (status says so, and no passed expiration date already listed it)
  // is overdue; an open one with the ball in our court is open work.
  const datedPermits = new Set(items.filter((x) => x.kind === 'permit' && bucketOf(x) === 'passed').map((x) => `${x.id}~${x.recordId}`));
  live.filter((a) => inferAssetKind(a) === 'property').forEach((a) => {
    (a.permits || []).forEach((p, i) => {
      const type = permitValue(p, PERMIT_KEYS.type) || permitValue(p, PERMIT_KEYS.number) || 'Permit';
      const open = { id: a.id, view: 'permit', item: String(i) };
      if (/expired/i.test(permitValue(p, PERMIT_KEYS.status)) && !datedPermits.has(`${a.id}~${i}`)) {
        groups.overdue.push({ key: `permit-x~${a.id}~${i}`, what: 'Permit expired', detail: type, where: nameOf(a), when: 'Expired', tone: 'red', sort: 0, kind: 'open', open });
      } else if (permitOpen(p) && permitOurs(p)) {
        groups.work.push({ key: `permit-o~${a.id}~${i}`, what: 'Permit waiting on us', detail: type, where: nameOf(a), when: permitValue(p, PERMIT_KEYS.status) || 'Ball in our court', tone: 'live', sort: 1000, kind: 'open', open });
      }
    });
  });

  // Tickets (only for people the portfolio endpoint admits).
  ((maintenance && maintenance.properties) || []).forEach((r) => {
    if (!byId[r.propertyId]) return;
    const open = { id: r.propertyId, view: 'maintenance', item: '' };
    if (r.preventiveOverdue > 0) {
      groups.overdue.push({ key: `pm~${r.propertyId}`, what: 'Preventive maintenance overdue', where: r.propertyName || nameOf(byId[r.propertyId]), when: `${plural(r.preventiveOverdue, 'ticket')} overdue`, tone: 'red', sort: 0, kind: 'open', open });
    }
    if (r.open > 0) {
      groups.work.push({ key: `tickets~${r.propertyId}`, what: plural(r.open, 'open ticket'), where: r.propertyName || nameOf(byId[r.propertyId]), when: r.lastCreatedAt ? `Last on ${formatDate(r.lastCreatedAt)}` : '', tone: 'quiet', sort: -r.open, kind: 'open', open });
    }
  });

  // Fields someone flagged for review.
  live.forEach((a) => (a.reviewFlags || []).forEach((f, i) => {
    groups.fix.push({ key: `flag~${a.id}~${i}`, what: `${f.f || 'A field'} flagged for review`, detail: f.reason || '', where: nameOf(a), when: f.user ? `By ${f.user}` : '', tone: 'quiet', sort: 1, kind: 'review', open: { id: a.id, view: 'property', item: '' } });
  }));

  if (everyone) {
    const noManager = live.filter((a) => inferAssetKind(a) === 'property' && !(a.parentId && byId[a.parentId]) && !String(a.manager || '').trim());
    if (noManager.length) {
      groups.fix.push({ key: 'no-manager', what: `${plural(noManager.length, 'property has', 'properties have')} no asset manager`, where: '', when: '', tone: 'quiet', sort: 2, kind: 'assign' });
    }
  }

  return GROUPS.map((g) => ({ ...g, rows: groups[g.key].sort((x, y) => x.sort - y.sort) })).filter((g) => g.rows.length);
}

/** The next date past the 30-day window, for the quiet line under an empty list. */
export function nextDateLine(assets, store) {
  const live = (assets || []).filter((a) => a && !a.deleted);
  const later = collectDates(store || {}, live).filter((x) => !x.suspect && x.days > 30).sort((a, b) => a.days - b.days);
  if (!later.length) return '';
  const first = later[0];
  const same = later.filter((x) => x.kind === first.kind && x.iso === first.iso);
  const byId = Object.fromEntries(live.map((a) => [a.id, a]));
  return `Next: ${kindLabel(first.kind).toLowerCase()} on ${formatDate(first.iso)} at ${same.length === 1 ? first.assetName : assetNoun(same, byId)}`;
}

const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', padding: '11px 0', borderBottom: `1px solid ${C.line}`, fontSize: 13 };

function Row({ r, depth = 0, expanded, onToggle, actions }) {
  const many = r.items && r.items.length > 1;
  return (
    <div data-row={r.kind} style={{ ...rowStyle, paddingLeft: depth ? 22 : 0 }}>
      <div style={{ flex: '2 1 220px', minWidth: 0 }}>
        <span style={{ fontWeight: depth ? 400 : 600, color: depth ? C.muted : C.ink }}>{r.what}</span>
        {r.detail && <span style={{ color: C.muted }}>{` - ${r.detail}`}</span>}
      </div>
      <div style={{ flex: '2 1 200px', minWidth: 0, color: C.ink }}>
        {many ? (
          <button type="button" onClick={onToggle} aria-expanded={expanded}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: C.ink, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {expanded ? <ChevronDown size={14} color="var(--text-muted)" /> : <ChevronRight size={14} color="var(--text-muted)" />}{r.where}
          </button>
        ) : r.where}
      </div>
      <div style={{ flex: '1 1 150px', minWidth: 0, color: toneColor(r.tone), fontWeight: r.tone === 'red' || r.tone === 'live' ? 600 : 400 }}>
        {r.when}
        {r.whenSub && <span style={{ color: C.muted, fontWeight: 400 }}>{` · ${r.whenSub}`}</span>}
      </div>
      <div style={{ flex: '0 0 auto', marginLeft: 'auto', display: 'inline-flex', gap: 14 }}>{actions}</div>
    </div>
  );
}

export function OverviewTab({ store, assets, openAsset, goTab, session, canEdit = false, onPatchAsset }) {
  const live = useMemo(() => (assets || []).filter((a) => a && !a.deleted), [assets]);
  const names = useMemo(() => myNames(session), [session]);
  const mine = useMemo(() => live.filter((a) => managedBy(a, names)), [live, names]);
  const [stored, setScope] = useTableValue('asset-overview', 'scope', undefined);
  const scope = stored === 'mine' || stored === 'everyone' ? stored : (mine.length ? 'mine' : 'everyone');
  const everyone = scope === 'everyone';
  const inScope = everyone ? live : mine;

  const m = useMaintenancePortfolio();
  const [openKeys, setOpenKeys] = useState(() => new Set());
  const [more, setMore] = useState(() => new Set());
  const byId = useMemo(() => Object.fromEntries(live.map((a) => [a.id, a])), [live]);

  const groups = useMemo(() => buildWorklist({ assets: inScope, store, maintenance: m.status === 'ok' ? m.data : null, everyone }),
    [inScope, store, m.status, m.data, everyone]);

  const toggle = (setter, key) => setter((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const mark = (items) => {
    const n = markItems(items, byId, onPatchAsset);
    if (n && pushToast) pushToast(`${plural(items.length, 'date')} rolled to next year - Undo is in Activity.`);
  };
  const go = (o) => openAsset?.(o.id, o.view || 'property', o.item || '');

  const actionsFor = (r, item) => {
    const list = item ? [item] : r.items;
    if (r.kind === 'date') {
      const action = item ? actionFor(item) : r.action;
      return (
        <>
          {action && canEdit && onPatchAsset && <LinkButton onClick={() => mark(list)} aria-label={!item && list.length > 1 ? `${action} for all ${list.length}` : action}>{action}</LinkButton>}
          {(item || list.length === 1) && <LinkButton tone="quiet" onClick={() => go({ id: list[0].id, view: list[0].tab, item: list[0].recordId })}>Open</LinkButton>}
        </>
      );
    }
    if (r.kind === 'fix') {
      return (item || list.length === 1) ? <LinkButton tone="orange" onClick={() => go({ id: list[0].id, view: list[0].tab, item: list[0].recordId })}>Fix</LinkButton> : null;
    }
    if (r.kind === 'review') return <LinkButton onClick={() => go(r.open)}>Review</LinkButton>;
    if (r.kind === 'assign') return <LinkButton onClick={() => goTab?.('properties', { preset: 'no-manager' })}>Assign</LinkButton>;
    return <LinkButton onClick={() => go(r.open)}>Open</LinkButton>;
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const overdue = (groups.find((g) => g.key === 'overdue') || { rows: [] }).rows.length;

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <Segmented label="Whose assets" value={scope} onChange={setScope} options={[{ key: 'mine', label: 'Mine' }, { key: 'everyone', label: 'Everyone' }]} />
      {m.status !== 'loading' && total > 0 && (
        <span data-summary style={{ fontSize: 15, fontWeight: 500 }}>
          {plural(total, 'thing needs', 'things need')} you
          {overdue > 0 && <span style={{ color: C.red }}>{` - ${overdue} overdue`}</span>}
        </span>
      )}
    </div>
  );

  if (m.status === 'loading') {
    return <div data-tab="overview" aria-busy="true">{head}<div style={{ marginTop: 20 }}><SkeletonBlocks count={5} height={30} borderRadius={8} /></div></div>;
  }

  return (
    <div data-tab="overview">
      {head}
      {!everyone && !mine.length && (
        <Quiet style={{ paddingBottom: 0 }}>You are not the asset manager on any asset yet - Everyone shows the whole portfolio.</Quiet>
      )}
      {m.status === 'error' && <Quiet style={{ paddingBottom: 0 }}>Couldn&apos;t load tickets - the list below is everything else.</Quiet>}
      {!total ? (
        <div style={{ padding: '28px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
            <CircleCheck size={18} color="hsl(var(--color-green))" /> Nothing needs you right now.
          </div>
          {nextDateLine(inScope, store) && <div style={{ fontSize: 13, color: C.muted, marginTop: 6, marginLeft: 26 }}>{nextDateLine(inScope, store)}</div>}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {groups.map((g) => {
            const all = more.has(g.key);
            const rows = all ? g.rows : g.rows.slice(0, GROUP_CAP);
            return (
              <section key={g.key} aria-label={g.label} style={{ marginTop: 22 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, paddingBottom: 8, borderBottom: `1px solid ${C.line}`, color: C.ink }}>
                  {g.label} <span style={{ color: C.muted, fontWeight: 400, fontSize: 13 }}>{g.rows.length}</span>
                </h3>
                {rows.map((r) => {
                  const expanded = openKeys.has(r.key);
                  return (
                    <Fragment key={r.key}>
                      <Row r={r} expanded={expanded} onToggle={() => toggle(setOpenKeys, r.key)} actions={actionsFor(r)} />
                      {expanded && r.items.map((x) => (
                        <Row key={x.key} depth={1} actions={actionsFor(r, x)}
                          r={{ what: x.detail || kindLabel(x.kind), where: x.assetName, when: r.kind === 'fix' ? x.date : '', tone: r.tone, kind: r.kind }} />
                      ))}
                    </Fragment>
                  );
                })}
                {g.rows.length > GROUP_CAP && (
                  <div style={{ paddingTop: 10 }}>
                    <LinkButton onClick={() => toggle(setMore, g.key)} style={{ fontSize: 13 }}>{all ? 'Show Fewer' : `Show ${g.rows.length - GROUP_CAP} More`}</LinkButton>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default OverviewTab;
