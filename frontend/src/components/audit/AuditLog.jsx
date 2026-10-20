// Settings > Logs: the ONE Audit Log (Visesh, Oct 20 2026). Every change in
// Nexus - who made it, whether they were acting as someone else, what the
// record looked like before and after - in one timeline, filtered by module,
// person, Act As, action, date and text (dropdowns, not chip rows), with the
// filters in the address bar so a filtered view can be shared.
//
// Data: GET /audit/events (keyset cursor), /audit/events/{id} (the full
// diff), /audit/records/{type}/{id}/history and /audit/facets. While those
// are not deployed (a 404), the screen falls back to the older
// GET /audit-logs list so it keeps working.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Download, SlidersHorizontal, ScrollText, ChevronDown } from 'lucide-react';
import { api, saveBlob } from '../../api';
import { SkeletonBlocks, ErrorBanner, Spinner } from '../AsyncState';
import PersonSearchSelect from '../PersonSearchSelect';
import { useNameResolver } from '../../lib/useNameResolver';
import { useIsMobile } from '../../lib/useIsMobile';
import { isTypingTarget } from '../../lib/keys';
import { openNotificationTarget } from '../../lib/openTarget';
import { formatDate } from '../../lib/datetime';
import AuditDetailDrawer, { TargetLink } from './AuditDetailDrawer';
import { PersonAvatar, ModuleBadge, ActAsBadge, ActionIcon, ChangePreview, AMBER } from './AuditParts';
import {
  DEFAULT_FILTERS, RANGES, ACTIONS, ACTING_AS_ANY, LEGACY_MODULES,
  filtersFromSearch, searchFromFilters, activeFilterCount, apiParams, rangePhrase,
  groupByDay, dayBuckets, countByDay, relativeTime, exactTime, exactDateTime, legacyRowToEvent, rangeDates,
} from './auditModel';

const PAGE = 50;

const CSS = `
.nx-audit-entry { transition: background .12s; }
.nx-audit-entry:hover { background: var(--mist); }
.nx-audit-entry[data-selected="true"] { background: var(--mist); box-shadow: inset 2px 0 0 var(--wk-brand, #2b45e1); }
.nx-audit-entry:focus-visible { outline: 2px solid var(--wk-brand, #2b45e1); outline-offset: -2px; }
.nx-audit-bar { background: color-mix(in srgb, var(--wk-brand, #2b45e1) 30%, transparent); border: none; padding: 0; cursor: pointer; border-radius: 2px 2px 0 0; }
.nx-audit-bar:hover, .nx-audit-bar:focus-visible { background: var(--wk-brand, #2b45e1); }
`;

const selectStyle = { height: 34, fontSize: 12.5, minWidth: 0, width: '100%' };
const fieldLabel = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 };

// ── Data loading ────────────────────────────────────────────────────────────

async function fetchLegacy(f, cursor) {
  const offset = Number(cursor) || 0;
  const data = await api.getAuditLogs({ limit: PAGE, offset, user_email: f.person, action: f.module });
  const rows = data?.rows || [];
  const total = data?.total ?? null;
  return {
    events: rows.map(legacyRowToEvent),
    nextCursor: total !== null && offset + rows.length < total ? String(offset + PAGE) : null,
    total,
  };
}

// The header count for the current filter: the API's own total when it sends
// one, else what the facets can answer exactly (one filter at most).
function filterTotal(f, facets, total) {
  if (typeof total === 'number') return total;
  if (!facets || f.q || f.as || f.system) return null;
  const set = [f.module, f.person, f.action].filter(Boolean).length;
  if (set > 1) return null;
  const sum = (list) => (list || []).reduce((n, x) => n + (x.count || 0), 0);
  if (f.module) return facets.modules?.find(m => m.key === f.module)?.count ?? 0;
  if (f.person) return facets.actors?.find(a => (a.email || '').toLowerCase() === f.person.toLowerCase())?.count ?? 0;
  if (f.action) return facets.actions?.find(a => a.key === f.action)?.count ?? 0;
  return facets.modules ? sum(facets.modules) : null;
}

// ── Filters ─────────────────────────────────────────────────────────────────

function PersonFilter({ value, onChange, groups, nameOf, placeholder, ariaLabel }) {
  if (value) {
    return (
      <div className="form-input" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 8px' }}>
        <PersonAvatar email={value} name={nameOf(value)} size={20} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(value)}</span>
        <button type="button" onClick={() => onChange('')} aria-label={`Clear ${ariaLabel}`}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>
      </div>
    );
  }
  return <PersonSearchSelect groups={groups} onPick={onChange} placeholder={placeholder} />;
}

function Filters({ f, set, legacy, facets, people, nameOf, searchRef, qInput, setQInput, layout }) {
  const [asSpecific, setAsSpecific] = useState(!!f.as && f.as !== ACTING_AS_ANY);
  useEffect(() => { if (f.as && f.as !== ACTING_AS_ANY) setAsSpecific(true); }, [f.as]);
  const stacked = layout === 'sheet';
  const moduleOptions = legacy ? LEGACY_MODULES.map(m => ({ ...m, count: null })) : (facets?.modules || []);
  const moduleKnown = !f.module || moduleOptions.some(m => m.key === f.module);
  const actorGroups = useMemo(() => {
    const counted = (facets?.actors || []).map(a => ({ email: a.email, name: `${nameOf(a.email, a.name)} (${(a.count || 0).toLocaleString('en-US')})` }));
    const seen = new Set(counted.map(a => (a.email || '').toLowerCase()));
    const rest = (people || []).filter(p => p.email && !seen.has(p.email.toLowerCase())).map(p => ({ email: p.email, name: nameOf(p.email, p.name) }));
    return [{ label: 'Active in This Range', people: counted }, { label: 'Everyone', people: rest }];
  }, [facets, people, nameOf]);
  const everyone = useMemo(() => [{ label: 'People', people: (people || []).map(p => ({ email: p.email, name: nameOf(p.email, p.name) })) }], [people, nameOf]);

  const cell = (label, child, key, grow = 1) => (
    <div key={key} style={{ flex: stacked ? 'none' : `${grow} 1 150px`, minWidth: 0 }}>
      <label style={fieldLabel}>{label}</label>
      {child}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', flexWrap: 'wrap', gap: stacked ? 14 : 10, alignItems: stacked ? 'stretch' : 'flex-end' }}>
      {cell('Module', (
        <select className="form-input" aria-label="Module" value={f.module} onChange={e => set({ module: e.target.value })} style={selectStyle}>
          <option value="">All Modules</option>
          {!moduleKnown && <option value={f.module}>{f.module}</option>}
          {moduleOptions.map(m => (
            <option key={m.key} value={m.key}>{m.label}{typeof m.count === 'number' ? ` (${m.count.toLocaleString('en-US')})` : ''}</option>
          ))}
        </select>
      ), 'module')}
      {cell('Person', (
        <PersonFilter value={f.person} onChange={v => set({ person: v })} groups={actorGroups} nameOf={nameOf} placeholder="All People" ariaLabel="person" />
      ), 'person', 1.3)}
      {!legacy && cell('Acting As', (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <select className="form-input" aria-label="Acting As" style={selectStyle}
            value={f.as === ACTING_AS_ANY ? 'any' : (asSpecific ? 'specific' : '')}
            onChange={e => {
              const v = e.target.value;
              setAsSpecific(v === 'specific');
              set({ as: v === 'any' ? ACTING_AS_ANY : '' });
            }}>
            <option value="">Anyone</option>
            <option value="any">Only Act As Actions</option>
            <option value="specific">A Specific Person...</option>
          </select>
          {asSpecific && (
            <PersonFilter value={f.as !== ACTING_AS_ANY ? f.as : ''} onChange={v => set({ as: v })} groups={everyone} nameOf={nameOf} placeholder="Acting as who?" ariaLabel="acting as person" />
          )}
        </div>
      ), 'as')}
      {!legacy && cell('Action', (
        <select className="form-input" aria-label="Action" value={f.action} onChange={e => set({ action: e.target.value })} style={selectStyle}>
          <option value="">All Actions</option>
          {ACTIONS.map(a => {
            const n = facets?.actions?.find(x => x.key === a.key)?.count;
            return <option key={a.key} value={a.key}>{a.label}{typeof n === 'number' ? ` (${n.toLocaleString('en-US')})` : ''}</option>;
          })}
        </select>
      ), 'action')}
      {!legacy && cell('Date Range', (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <select className="form-input" aria-label="Date Range" value={f.range} onChange={e => {
            const range = e.target.value;
            if (range === 'custom' && !f.from && !f.to) set({ range, ...rangeDates(f) });
            else set({ range });
          }} style={selectStyle}>
            {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          {f.range === 'custom' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="date" className="form-input" aria-label="From" value={f.from} max={f.to || undefined} onChange={e => set({ from: e.target.value })} style={{ ...selectStyle, padding: '0 6px' }} />
              <input type="date" className="form-input" aria-label="To" value={f.to} min={f.from || undefined} onChange={e => set({ to: e.target.value })} style={{ ...selectStyle, padding: '0 6px' }} />
            </div>
          )}
        </div>
      ), 'range')}
      {!legacy && cell('Search', (
        <div className="search-bar" style={{ height: 34, width: '100%' }}>
          <Search size={13} style={{ flexShrink: 0 }} />
          <input ref={searchRef} aria-label="Search the audit log" placeholder="Search titles, records, values..." value={qInput} onChange={e => setQInput(e.target.value)} />
          {qInput ? (
            <button className="search-clear" onClick={() => setQInput('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>
          ) : (
            !stacked && <kbd style={{ fontSize: 10.5, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 4, padding: '0 5px', fontFamily: 'inherit', flexShrink: 0 }} title="Press Ctrl+F or / to search">Ctrl+F</kbd>
          )}
        </div>
      ), 'q', 1.6)}
    </div>
  );
}

// ── Feed ────────────────────────────────────────────────────────────────────

function FeedItem({ ev, selected, onOpen, onOpenTarget, nameOf, index }) {
  const actor = nameOf(ev.actor?.email, ev.actor?.name) || 'System';
  const preview = (ev.preview || ev.changes || []).slice(0, 3);
  const more = Math.max(0, (ev.changesCount || 0) - preview.length);
  const actingAs = ev.actingAs ? nameOf(ev.actingAs.email, ev.actingAs.name) : '';
  return (
    <div role="button" tabIndex={0} className="nx-audit-entry" data-selected={selected ? 'true' : 'false'} data-index={index}
      aria-label={`${actor}: ${ev.title}`}
      onClick={() => onOpen(ev)} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); onOpen(ev); } }}
      style={{
        display: 'grid', gridTemplateColumns: '32px 1fr auto', gap: 12, padding: '12px 16px', cursor: 'pointer',
        borderTop: '1px solid var(--line)', borderLeft: actingAs ? `3px solid ${AMBER}` : '3px solid transparent',
      }}>
      <PersonAvatar email={ev.actor?.email} name={actor} size={32} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{actor}</span>
          {actingAs && <ActAsBadge compact name={actingAs} />}
          <ModuleBadge module={ev.module} label={ev.moduleLabel} />
          {ev.undone && <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Undone</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <ActionIcon action={ev.action} />
          <span style={{ fontSize: 13, color: ev.action === 'denied' ? 'hsl(var(--color-red))' : 'var(--ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{ev.title}</span>
        </div>
        {ev.summary && <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>{ev.summary}</div>}
        {preview.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2, minWidth: 0 }}>
            {preview.map((c, i) => <ChangePreview key={`${c.field}-${i}`} change={c} action={ev.action} />)}
          </div>
        )}
        {(ev.target?.link?.view || more > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
            {ev.target?.link?.view && <TargetLink target={ev.target} onOpenTarget={onOpenTarget} size={12} />}
            {more > 0 && (
              <button type="button" onClick={e => { e.stopPropagation(); onOpen(ev); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted)', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                +{more} more
              </button>
            )}
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }} title={exactDateTime(ev.at)}>
        <div style={{ fontSize: 12, color: 'var(--ink)' }}>{exactTime(ev.at)}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{relativeTime(ev.at)}</div>
      </div>
    </div>
  );
}

function ActivityBars({ buckets, onPickDay }) {
  if (!buckets || buckets.length < 2) return null;
  const max = Math.max(1, ...buckets.map(b => b.count));
  return (
    <div aria-label="Activity by day" style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 30, marginTop: 12 }}>
      {buckets.map(b => (
        <button key={b.date} type="button" className="nx-audit-bar" onClick={() => onPickDay(b.date)}
          title={`${formatDate(b.date)}: ${b.count.toLocaleString('en-US')} events`}
          aria-label={`${formatDate(b.date)}: ${b.count} events`}
          style={{ flex: 1, minWidth: 2, maxWidth: 28, height: `${Math.max(b.count ? 10 : 4, (b.count / max) * 100)}%`, opacity: b.count ? 1 : 0.45 }} />
      ))}
    </div>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function AuditLog() {
  const nameOf = useNameResolver();
  const isMobile = useIsMobile();
  const [f, setF] = useState(() => filtersFromSearch(typeof window !== 'undefined' ? window.location.search : ''));
  const [qInput, setQInput] = useState(f.q);
  const [legacy, setLegacy] = useState(false);
  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [facets, setFacets] = useState(null);
  const [people, setPeople] = useState([]);
  const [open, setOpen] = useState(() => {
    const id = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('event');
    return id ? { id } : null;
  });
  const [sel, setSel] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const sentinelRef = useRef(null);

  const set = useCallback((patch) => setF(prev => ({ ...prev, ...patch })), []);
  const clear = () => { setF({ ...DEFAULT_FILTERS }); setQInput(''); };

  // Debounced search box -> filter.
  useEffect(() => {
    if (qInput === f.q) return undefined;
    const t = setTimeout(() => set({ q: qInput }), 350);
    return () => clearTimeout(t);
  }, [qInput, f.q, set]);

  // Filters (and the open event) -> the address bar, so the view can be shared.
  useEffect(() => {
    try {
      const url = `${window.location.pathname}${searchFromFilters(f, open?.id && !String(open.id).startsWith('legacy-') ? open.id : '')}`;
      if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, '', url);
    } catch { /* not in a browser */ }
  }, [f, open]);

  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory?.().then(r => { if (alive) setPeople(Array.isArray(r) ? r : []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const paramsKey = JSON.stringify(apiParams(f));
  const { from, to } = rangeDates(f);

  // Facets for the range (counts in the dropdowns, the activity bars).
  useEffect(() => {
    if (legacy) return undefined;
    let alive = true;
    api.auditFacets(Object.fromEntries(Object.entries({ from, to }).filter(([, v]) => v)))
      .then(r => { if (alive) setFacets(r || null); })
      .catch(() => { if (alive) setFacets(null); });
    return () => { alive = false; };
  }, [from, to, legacy, tick]);

  const fetchPage = useCallback(async (cursor) => {
    if (legacy) return fetchLegacy(f, cursor);
    const res = await api.auditEvents(apiParams(f, { limit: PAGE, ...(cursor ? { cursor } : {}) }));
    return { events: res?.events || [], nextCursor: res?.nextCursor || null, total: typeof res?.total === 'number' ? res.total : null };
  }, [f, legacy]);

  // First page whenever the filters change.
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true); setError(''); setSel(-1);
    fetchPage(null)
      .then(r => {
        if (my !== seq.current) return;
        setEvents(r.events); setNextCursor(r.nextCursor); setTotal(r.total); setLoading(false);
      })
      .catch(e => {
        if (my !== seq.current) return;
        if (!legacy && (e?.status === 404 || e?.status === 405)) { setLegacy(true); return; }
        setError(e?.message || 'Could not load the audit log.'); setLoading(false);
      });
  }, [paramsKey, legacy, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || loading) return;
    const my = seq.current;
    setLoadingMore(true);
    fetchPage(nextCursor)
      .then(r => {
        if (my !== seq.current) return;
        setEvents(prev => {
          const have = new Set(prev.map(e => e.id));
          return [...prev, ...r.events.filter(e => !have.has(e.id))];
        });
        setNextCursor(r.nextCursor);
      })
      .catch(() => { /* the Load More button stays for a retry */ })
      .finally(() => { if (my === seq.current) setLoadingMore(false); });
  }, [nextCursor, loadingMore, loading, fetchPage]);

  // Infinite scroll; the Load More button covers browsers without the observer.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined' || !nextCursor) return undefined;
    const io = new IntersectionObserver((entries) => { if (entries.some(x => x.isIntersecting)) loadMore(); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, nextCursor]);

  const openEvent = useCallback((ev) => setOpen(ev), []);
  const closeEvent = useCallback(() => setOpen(null), []);

  // The drawer gets the list's copy of an event while its full diff loads.
  const openFull = open ? (events.find(e => e.id === open.id) || open) : null;

  const onOpenTarget = useCallback((link) => {
    if (!link?.view) return;
    setOpen(null);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: link.view, sub: link.sub ?? null } }));
    if (link.params) openNotificationTarget(link.params);
  }, []);

  const copyLink = useCallback((id) => {
    const url = `${window.location.origin}${window.location.pathname}${searchFromFilters(f, id)}`;
    try { navigator.clipboard?.writeText(url); } catch { /* clipboard blocked */ }
  }, [f]);

  // Keyboard: Ctrl+F or "/" focuses the search; j / k move, Enter opens.
  useEffect(() => {
    const onKey = (e) => {
      if (open || sheet) return;
      const searchKey = ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f')
        || (e.key === '/' && !e.ctrlKey && !e.metaKey && !isTypingTarget(e.target));
      if (searchKey && searchRef.current) {
        e.preventDefault(); e.stopPropagation();
        searchRef.current.focus(); searchRef.current.select?.();
        return;
      }
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setSel(s => {
          const n = e.key === 'j' ? Math.min(events.length - 1, s + 1) : Math.max(0, s - 1);
          const node = listRef.current?.querySelector(`[data-index="${n}"]`);
          node?.scrollIntoView?.({ block: 'nearest' });
          node?.focus?.({ preventScroll: true });
          return n;
        });
      } else if (e.key === 'Enter' && sel >= 0 && events[sel] && !e.target.closest?.('button, a, [role="button"]')) {
        e.preventDefault();
        setOpen(events[sel]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, sheet, events, sel]);

  const doExport = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.auditExport(apiParams(f));
      saveBlob(blob, filename || 'nexus-audit-log.csv');
    } catch (e) {
      setError(e?.status === 404 ? 'Export is not available yet.' : (e?.message || 'Could not export the audit log.'));
    } finally {
      setExporting(false);
    }
  };

  const groups = useMemo(() => groupByDay(events), [events]);
  const indexOf = useMemo(() => new Map(events.map((e, i) => [e.id, i])), [events]);
  const count = filterTotal(f, legacy ? null : facets, total);
  const buckets = legacy ? null
    : facets?.days ? dayBuckets(f, facets.days)
      : (!loading && !nextCursor && events.length ? dayBuckets(f, countByDay(events)) : null);
  const nActive = activeFilterCount(f);

  const filtersProps = { f, set, legacy, facets, people, nameOf, searchRef, qInput, setQInput };

  return (
    <div style={{ fontFamily: 'Inter, sans-serif' }}>
      <style>{CSS}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>Audit Log</h3>
          <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Everything done in Nexus - who did it, who they were acting as, and what it was before.
          </p>
          <div aria-live="polite" style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink)', fontWeight: 600 }}>
            {loading ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}>Counting...</span>
              : count !== null ? `${count.toLocaleString('en-US')} event${count === 1 ? '' : 's'} ${legacy ? 'in the log' : rangePhrase(f)}`
                : `${events.length.toLocaleString('en-US')}${nextCursor ? '+' : ''} event${events.length === 1 ? '' : 's'} ${rangePhrase(f)}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isMobile && (
            <button type="button" className="secondary-btn" onClick={() => setSheet(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <SlidersHorizontal size={14} /> Filters{nActive ? ` (${nActive})` : ''}
            </button>
          )}
          {!legacy && (
            <button type="button" className="secondary-btn" onClick={doExport} disabled={exporting} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {exporting ? <Spinner size="inline" /> : <Download size={14} />} Export CSV
            </button>
          )}
        </div>
      </div>

      {legacy && (
        <div role="note" style={{ fontSize: 12.5, color: 'var(--muted)', background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px', marginBottom: 12 }}>
          Showing the older log. Field-by-field changes, Act As filters and more appear once the new audit service is live.
        </div>
      )}

      {/* Filters */}
      {!isMobile && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
          <Filters {...filtersProps} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10, fontSize: 12.5 }}>
            {!legacy && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--ink)' }}>
                <input type="checkbox" checked={f.system} onChange={e => set({ system: e.target.checked })} /> Show System Activity
              </label>
            )}
            {nActive > 0 && (
              <button type="button" onClick={clear} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand, var(--pine))', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit' }}>
                Clear Filters
              </button>
            )}
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5 }}>
              <kbd>j</kbd> / <kbd>k</kbd> to move, <kbd>Enter</kbd> to open
            </span>
          </div>
          <ActivityBars buckets={buckets} onPickDay={(d) => set({ range: 'custom', from: d, to: d })} />
        </div>
      )}

      {isMobile && sheet && (
        <div role="dialog" aria-modal="true" aria-label="Filters"
          style={{ position: 'fixed', inset: 0, zIndex: 3400, background: 'var(--card)', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>Filters</div>
            <button type="button" onClick={() => setSheet(false)} aria-label="Close filters" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            <Filters {...filtersProps} layout="sheet" />
            {!legacy && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 13 }}>
                <input type="checkbox" checked={f.system} onChange={e => set({ system: e.target.checked })} /> Show System Activity
              </label>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, padding: 16, borderTop: '1px solid var(--line)' }}>
            <button type="button" className="secondary-btn" onClick={clear} style={{ flex: 1 }}>Clear Filters</button>
            <button type="button" className="primary-btn" onClick={() => setSheet(false)} style={{ flex: 1 }}>Show Results</button>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div ref={listRef} style={{ marginTop: 14, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'clip' }}>
        {error && !events.length ? (
          <div style={{ padding: 16 }}><ErrorBanner message={error} onRetry={() => setTick(t => t + 1)} /></div>
        ) : loading ? (
          <div style={{ padding: 14 }}><SkeletonBlocks count={6} height={64} borderRadius={10} /></div>
        ) : events.length === 0 ? (
          <div style={{ padding: '56px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            <ScrollText size={26} style={{ opacity: 0.25, display: 'block', margin: '0 auto 10px' }} />
            No activity matches these filters.
            {nActive > 0 && (
              <div style={{ marginTop: 8 }}>
                <button type="button" onClick={clear} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-brand, var(--pine))', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit' }}>Clear Filters</button>
              </div>
            )}
          </div>
        ) : (
          <>
            {groups.map(g => (
              <section key={g.key} aria-label={g.label}>
                <h4 style={{ position: 'sticky', top: 0, zIndex: 1, margin: 0, padding: '8px 16px', background: 'var(--mist)', borderTop: '1px solid var(--line)', fontSize: 12, fontWeight: 700, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {g.label}
                  <span style={{ fontWeight: 500, color: 'var(--muted)' }}>{g.events.length.toLocaleString('en-US')}</span>
                </h4>
                {g.events.map(ev => {
                  const i = indexOf.get(ev.id);
                  return <FeedItem key={ev.id} ev={ev} index={i} selected={i === sel} nameOf={nameOf} onOpen={(x) => { setSel(i); openEvent(x); }} onOpenTarget={onOpenTarget} />;
                })}
              </section>
            ))}
            <div ref={sentinelRef} style={{ padding: '12px 16px', borderTop: '1px solid var(--line)', textAlign: 'center' }}>
              {nextCursor ? (
                <button type="button" className="secondary-btn" onClick={loadMore} disabled={loadingMore} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {loadingMore ? <Spinner size="inline" /> : <ChevronDown size={14} />} Load More
                </button>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>That's everything for these filters.</span>
              )}
            </div>
          </>
        )}
      </div>

      {openFull && (
        <AuditDetailDrawer key={openFull.id} event={openFull} nameOf={nameOf} onClose={closeEvent}
          onOpenEvent={openEvent} onOpenTarget={onOpenTarget} onCopyLink={copyLink} />
      )}
    </div>
  );
}
