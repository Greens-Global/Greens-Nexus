// Business Intelligence (rebuilt Oct 13 2026, Neil: "fix the look and feel
// and improve it through and through").
//
// What it is: one management board of the real numbers every module already
// computes server-side (GET /dashboards/insights), laid out so the eye goes
// to what needs attention first and to each module's own numbers second.
//
// What it is not, any more: a Power BI imitation. The per-card chart-type
// picker (eleven geometries drawn from the same four numbers), the drag-and-
// resize canvas, the per-browser layout file and the "670 Critical Signals"
// ribbon - a sum of unrelated counts - are gone. A treemap of three values
// and a funnel of a one-candidate pipeline were pictures of nothing; cards
// sized by a grid rather than by their content were two-thirds blank. Every
// number now renders one way, the way a manager reads it: a labeled count,
// colored by its alert level, that opens its breakdown on click.
//
// Kept, because they were the useful parts: the 30-second refresh, CSV
// export (board and per card), the drill-down ("click Open, see who" -
// Pranshu, Sep 14), the link from each card to its module, the alert-level
// filter and the metric search, and hiding cards you do not want.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, Tooltip } from 'recharts';
import {
  RefreshCw, Download, Search, X, ChevronRight, ArrowUpRight, CheckCircle2,
  SlidersHorizontal, AlertTriangle, Check,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, LoadingState } from '../components/AsyncState';
import { navigate } from './widgets.jsx';
import { NAV } from '../components/Sidebar';
import { MoreRow } from './listParts.jsx';
import { formatTime } from '../lib/datetime';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import {
  TONE_COLOR, TONE_LABEL, moduleMeta, attentionRows, worstTone, alertCount,
  visibleModule, csvText, boardCsvRows, cardCsvRows, loadHidden, saveHidden,
} from './biModel';

const C = (color) => `hsl(var(--color-${color}))`;
const toneColor = (tone) => C(TONE_COLOR[tone] || 'blue');
// Counts render in their alert color; a neutral or good count stays in ink,
// so color on this board always means "look here".
const valueColor = (tone) => (tone === 'critical' || tone === 'warning' ? toneColor(tone) : 'var(--ink)');
const REFRESH_MS = 30000;
const ATTENTION_SHOWN = 8;
const TABLE_SHOWN = 12;
// en-US grouping on purpose: a bare toLocaleString() groups by the viewer's
// locale, which reads 1,23,456 for India staff.
const count = (n) => n.toLocaleString('en-US');

function downloadCsv(name, rows) {
  const blob = new Blob(['\ufeff' + csvText(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The server labels trend days "MM-DD"; show them the US way, "M/D".
const dayLabel = (label) => String(label || '').replace(/^(\d{2})-(\d{2})$/, (_, m, d) => `${Number(m)}/${Number(d)}`);

// A module's icon is the one the left menu draws for it (Neil, 10/28/2026:
// "a matching icon ... so it's consistent"), looked up by the view the card
// opens - never a second icon set. A module the menu does not list (the
// Knowledge Base lives in the Help Center) keeps its own, else the gauge.
function ModuleIcon({ moduleId, nav, size = 16 }) {
  const item = nav ? NAV.find((n) => n.view === nav) : null;
  const style = { width: size, height: size, flexShrink: 0 };
  let glyph;
  if (item?.icon) glyph = <item.icon style={style} />;
  else if (item?.svgPath) glyph = <svg className="material-symbol-svg" viewBox="0 -960 960 960" style={style}><path d={item.svgPath} /></svg>;
  else { const { Icon } = moduleMeta(moduleId); glyph = <Icon style={style} />; }
  return <span className="bi-mod-icon" aria-hidden="true">{glyph}</span>;
}

// ── Needs Attention: every critical/warning count above zero ─────────────────
function AttentionStrip({ rows, onDrill }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ATTENTION_SHOWN);
  const critical = rows.filter((r) => r.tone === 'critical').length;
  return (
    <section className="bi-section">
      <div className="bi-section-head">
        <div>
          <h3 className="bi-section-title">Needs Attention</h3>
          <div className="bi-section-sub">
            {rows.length === 0 ? 'Nothing is past its alert level right now.'
              : `${critical} critical and ${rows.length - critical} warning signal${rows.length - critical === 1 ? '' : 's'} across the company.`}
          </div>
        </div>
        {rows.length > ATTENTION_SHOWN && (
          <button type="button" className="secondary-btn" onClick={() => setAll((v) => !v)}>
            {all ? 'Show Fewer' : `Show All ${rows.length}`}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="bi-calm">
          <CheckCircle2 size={18} />
          <div>
            <div style={{ fontWeight: 600 }}>All Clear</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No module is reporting an overdue, breached, unassigned or expiring item.</div>
          </div>
        </div>
      ) : (
        <div className="bi-attention">
          {shown.map((r) => (
            // No colored edge bar (Neil, 10/28/2026): the module's own icon
            // says where it comes from, the count's color and the dotted
            // level word say how bad it is.
            <button key={`${r.moduleId}:${r.key}`} type="button" className={`bi-alert bi-alert--${r.tone}`}
              onClick={() => onDrill(r)} title={r.drill === false ? `Open ${r.moduleLabel}` : `See the breakdown of ${r.label}`}>
              <span className="bi-alert-top">
                <ModuleIcon moduleId={r.moduleId} nav={r.nav} size={14} />
                <span className="bi-alert-mod">{r.moduleLabel}</span>
                <ArrowUpRight size={14} className="bi-alert-arrow" />
              </span>
              <span className="bi-alert-num">{typeof r.value === 'number' ? count(r.value) : r.value}</span>
              <span className="bi-alert-label">{r.label}</span>
              <span className="bi-alert-tone"><i className="bi-dot" style={{ background: toneColor(r.tone) }} />{TONE_LABEL[r.tone]}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Shapes a module can carry besides its counts ─────────────────────────────
// A breakdown is one segmented bar with a legend: the whole, split by state.
function Breakdown({ rows }) {
  const data = rows.filter((d) => typeof d.value === 'number' && d.value > 0);
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) return null;
  return (
    <div className="bi-shape">
      <div className="bi-split">
        {data.map((d) => (
          <span key={d.label} title={`${d.label}: ${d.value}`}
            style={{ width: `${(d.value / total) * 100}%`, background: toneColor(d.tone) }} />
        ))}
      </div>
      <div className="bi-legend">
        {data.map((d) => (
          <span key={d.label}>
            <i style={{ background: toneColor(d.tone) }} />
            {d.label} <b>{d.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

// A trend is the last seven days as a sparkline - the one place a chart
// earns its space, because the shape (not the numbers) is the point.
function Trend({ rows, label }) {
  if (!rows?.length) return null;
  const data = rows.map((r) => ({ ...r, label: dayLabel(r.label) }));
  const first = data[0], last = data[data.length - 1];
  return (
    <div className="bi-shape">
      <div className="bi-shape-label">{label}</div>
      <div style={{ height: 56 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
            <defs>
              <linearGradient id="bi-spark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C('green')} stopOpacity={0.3} />
                <stop offset="100%" stopColor={C('green')} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <Tooltip cursor={{ stroke: 'var(--line)' }} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)' }}
              labelStyle={{ color: 'var(--muted)' }} formatter={(v) => [v, 'Clocked in']} />
            <Area type="monotone" dataKey="value" stroke={C('green')} strokeWidth={2} fill="url(#bi-spark)" isAnimationActive={false} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="bi-spark-axis"><span>{first.label}</span><span>{last.label}</span></div>
    </div>
  );
}

// A funnel is stages in order, each a bar against the largest stage. The
// numbers stay legible at any size, which a drawn funnel never managed.
function Stages({ rows, label }) {
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  return (
    <div className="bi-shape">
      <div className="bi-shape-label">{label}</div>
      <div className="bi-stages">
        {rows.map((r, i) => (
          <div key={r.label} className="bi-stage">
            <span className="bi-stage-label">{r.label}</span>
            <span className="bi-stage-bar"><i style={{ width: `${((r.value || 0) / max) * 100}%`, opacity: 1 - i * 0.12 }} /></span>
            <span className="bi-stage-num">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SmallTable({ rows, onMore }) {
  return (
    <div className="bi-shape">
      <div className="bi-table">
        {rows.slice(0, TABLE_SHOWN).map((r, i) => (
          <div key={i} className="bi-table-row">
            <span>{r.employee ?? r.label}</span>
            <span>{r.device ?? r.value ?? r.detail}</span>
          </div>
        ))}
      </div>
      <MoreRow count={rows.length - TABLE_SHOWN} onClick={onMore} />
    </div>
  );
}

// ── One module ───────────────────────────────────────────────────────────────
function ModuleCard({ mod, stats, shapes, onDrill }) {
  const tone = worstTone(mod);
  const alerts = alertCount(mod);
  const open = () => mod.nav && navigate(mod.nav);
  return (
    <section className="dash-card bi-card" aria-label={mod.label}>
      <div className="dash-card-head" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <ModuleIcon moduleId={mod.id} nav={mod.nav} size={17} />
          <div style={{ minWidth: 0 }}>
            <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mod.label}</span>
              {alerts > 0 && <span className="bi-dot" style={{ background: toneColor(tone) }} title={`${alerts} signal${alerts === 1 ? '' : 's'} past alert level`} />}
            </div>
            <div className="dash-card-sub">
              {alerts === 0 ? 'Nothing past alert level' : `${alerts} signal${alerts === 1 ? '' : 's'} past alert level`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button type="button" className="bi-icon-btn" title="Download this card as CSV" aria-label={`Download ${mod.label} as CSV`}
            onClick={() => downloadCsv(`bi-${mod.id}.csv`, cardCsvRows(mod))}><Download size={14} /></button>
          {mod.nav && (
            <button type="button" className="bi-icon-btn" title={`Open ${mod.label}`} aria-label={`Open ${mod.label}`} onClick={open}><ArrowUpRight size={15} /></button>
          )}
        </div>
      </div>

      {/* Fixed-size card (style.css .bi-grid): the counts and shapes scroll
          here if a module ever sends more than the card holds. */}
      <div className="bi-card-body">
      {stats.length > 0 && (
        <div className="bi-stats">
          {stats.map((s) => {
            const drillable = s.drill !== false;
            const Row = drillable ? 'button' : 'div';
            return (
              <Row key={s.key} type={drillable ? 'button' : undefined} className={`bi-stat${drillable ? ' bi-stat--drill' : ''}`}
                onClick={drillable ? () => onDrill({ moduleId: mod.id, moduleLabel: mod.label, ...s }) : undefined}
                title={drillable ? `See the breakdown of ${s.label}` : undefined}>
                <span className="bi-stat-label">
                  {(s.tone === 'critical' || s.tone === 'warning') && typeof s.value === 'number' && s.value > 0 && (
                    <i className="bi-dot" style={{ background: toneColor(s.tone) }} />
                  )}
                  <span className="bi-stat-text">{s.label}</span>
                </span>
                <span className="bi-stat-value" style={{ color: typeof s.value === 'number' && s.value > 0 ? valueColor(s.tone) : 'var(--muted)' }}>
                  {typeof s.value === 'number' ? count(s.value) : s.value}
                </span>
                {drillable && <ChevronRight size={14} className="bi-stat-chev" />}
              </Row>
            );
          })}
        </div>
      )}

      {shapes && mod.breakdown?.length > 0 && <Breakdown rows={mod.breakdown} />}
      {shapes && mod.trend?.length > 0 && <Trend rows={mod.trend} label="Clocked in, last 7 days" />}
      {shapes && mod.funnel?.length > 0 && <Stages rows={mod.funnel} label="Hiring pipeline by stage" />}
      {shapes && mod.table?.length > 0 && <SmallTable rows={mod.table} onMore={mod.nav ? open : undefined} />}
      </div>
    </section>
  );
}

// ── Drill-down: "of what?" for one count, from /insights/drilldown ───────────
// "by_person" rows are counts per person, drawn as bars; "list" rows are the
// records themselves. A metric with no breakdown says so in words.
// Mounted with a key per request (see the bottom of BiInsights), so every
// breakdown starts from a fresh loading state without resetting in an effect.
function DrilldownModal({ request, onClose }) {
  const [state, setState] = useState({ loading: true, kind: 'by_person', rows: [], title: '', total: 0, error: '' });
  const closeRef = useRef(null);
  useEffect(() => {
    let alive = true;
    api.dashInsightsDrilldown(request.moduleId, request.key)
      .then((r) => { if (alive) setState({ loading: false, kind: r.kind || 'by_person', rows: r.rows || [], title: r.title || request.label, total: r.total ?? 0, error: '' }); })
      .catch((e) => { if (alive) setState({ loading: false, kind: 'by_person', rows: [], title: request.label, total: 0, error: e?.message || 'No breakdown is available for this metric yet.' }); });
    return () => { alive = false; };
  }, [request.moduleId, request.key, request.label]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Keyboard users land on Close, and go back to the count they clicked.
  useEffect(() => {
    const before = document.activeElement;
    closeRef.current?.focus();
    return () => { if (before && typeof before.focus === 'function') before.focus(); };
  }, []);

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const max = Math.max(1, ...state.rows.map((r) => num(r.value)));
  const go = () => { onClose(); if (request.nav) navigate(request.nav); };
  return (
    <div className="bi-scrim" onClick={onClose} role="presentation">
      <div className="bi-modal nx-popup" role="dialog" aria-modal="true" aria-label={state.title || request.label} onClick={(e) => e.stopPropagation()}>
        <div className="bi-modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="dash-card-title">{state.title || request.label}</div>
            <div className="dash-card-sub">
              {request.moduleLabel}
              {!state.loading && !state.error && state.rows.length > 0 && ` · ${state.total || state.rows.length} in total`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {request.nav && <button type="button" className="secondary-btn" onClick={go}>Open {request.moduleLabel}</button>}
            <button ref={closeRef} type="button" className="bi-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
        </div>
        <div className="bi-modal-body">
          {state.loading ? <LoadingState compact />
            : state.error ? <div className="bi-empty">{state.error}</div>
            : state.rows.length === 0 ? <div className="bi-empty">Nothing currently matches this metric.</div>
            : state.kind === 'list' ? (
              <div className="bi-table">
                {state.rows.map((r, i) => (
                  <div key={i} className="bi-table-row"><span title={r.label}>{r.label}</span><span title={r.detail}>{r.detail}</span></div>
                ))}
              </div>
            ) : (
              <div className="bi-stages">
                {state.rows.map((r, i) => (
                  <div key={i} className="bi-stage bi-stage--wide">
                    <span className="bi-stage-label" title={r.label}>{r.label}</span>
                    <span className="bi-stage-bar"><i style={{ width: `${(num(r.value) / max) * 100}%` }} /></span>
                    <span className="bi-stage-num">{r.value}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// ── Modules menu: hide the cards you do not read ─────────────────────────────
function ModulesMenu({ modules, hidden, onToggle, onShowAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const hiddenCount = hidden.filter((id) => modules.some((m) => m.id === id)).length;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="secondary-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="true" aria-expanded={open}>
        <SlidersHorizontal size={14} /> Modules{hiddenCount > 0 ? ` (${modules.length - hiddenCount} of ${modules.length})` : ''}
      </button>
      {open && (
        <div className="bi-menu" role="menu">
          {modules.map((m) => {
            const on = !hidden.includes(m.id);
            return (
              <button key={m.id} type="button" role="menuitemcheckbox" aria-checked={on} className="bi-menu-row" onClick={() => onToggle(m.id)}>
                <span className={`bi-check${on ? ' bi-check--on' : ''}`}>{on && <Check size={11} />}</span>
                <span style={{ flex: 1, textAlign: 'left' }}>{m.label}</span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button type="button" className="bi-menu-row bi-menu-row--action" onClick={() => { onShowAll(); setOpen(false); }}>Show All Modules</button>
          )}
        </div>
      )}
    </div>
  );
}

const TONE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'good', label: 'Good' },
];

export default function BiInsights() {
  const [state, setState] = useState({ loading: true, modules: [], at: '', error: '' });
  const [tone, setTone] = useState('all');
  const [query, setQuery] = useState('');
  const [hidden, setHiddenState] = useState(loadHidden);
  const [drill, setDrill] = useState(null);
  const closeDrill = useCallback(() => setDrill(null), []);
  const alive = useRef(true);

  const setHidden = (next) => { setHiddenState(next); saveHidden(next); };
  const load = useCallback(async () => {
    try {
      const r = await api.dashInsights();
      if (!alive.current) return;
      setState({ loading: false, modules: r.modules || [], at: r.at || '', error: '' });
    } catch (e) {
      // Keep whatever was on screen; only a first load with nothing to show
      // reports the failure in place of the board.
      if (alive.current) setState((s) => ({ ...s, loading: false, error: s.modules.length ? '' : (e?.message || 'Could not load the board.') }));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    const stop = pollWhileVisible(load, REFRESH_MS);
    return () => { alive.current = false; stop(); };
  }, [load]);

  const attention = useMemo(() => attentionRows(state.modules), [state.modules]);
  // Export is what is on screen: hidden modules and the filters both apply.
  const shownModules = useMemo(() => state.modules.filter((m) => !hidden.includes(m.id)), [state.modules, hidden]);
  const cards = useMemo(() => shownModules
    .map((m) => ({ mod: m, ...visibleModule(m, tone, query) }))
    .filter((c) => c.visible), [shownModules, tone, query]);
  const narrowed = tone !== 'all' || !!query.trim();
  const onDrill = (row) => {
    // A metric with no breakdown opens its module instead of a dead end.
    if (row.drill === false) { if (row.nav) navigate(row.nav); return; }
    setDrill(row);
  };
  const onDrillAttention = (r) => onDrill(r);

  return (
    <div className="bi-root">
      <div className="bi-head">
        <div>
          <h2 className="bi-title">Insights</h2>
          <p className="bi-sub">
            Company-wide numbers from every module, as each module counts them.
            {state.at && formatTime(state.at) && <> Updated {formatTime(state.at)}, refreshes every 30 seconds.</>}
          </p>
        </div>
        <div className="bi-actions">
          <ModulesMenu modules={state.modules} hidden={hidden} onToggle={(id) => setHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id])} onShowAll={() => setHidden([])} />
          <button type="button" className="secondary-btn" title="Download the counts on screen as CSV" onClick={() => downloadCsv('business-intelligence.csv', boardCsvRows(shownModules, tone, query))}><Download size={14} /> Export</button>
          <button type="button" className="secondary-btn" onClick={load}><RefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {state.loading ? (
        <SkeletonBlocks count={4} height={150} />
      ) : state.error ? (
        <div className="bi-calm bi-calm--error">
          <AlertTriangle size={18} />
          <div>
            <div style={{ fontWeight: 600 }}>The Board Could Not Load</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{state.error}</div>
          </div>
          <button type="button" className="secondary-btn" onClick={load} style={{ marginLeft: 'auto' }}>Try Again</button>
        </div>
      ) : (
        <>
          <AttentionStrip rows={attention} onDrill={onDrillAttention} />

          <section className="bi-section">
            <div className="bi-section-head">
              <div>
                <h3 className="bi-section-title">By Module</h3>
                <div className="bi-section-sub">Click a count to see who or what is behind it. The arrow opens the module.</div>
              </div>
              <div className="bi-filters">
                <div className="bi-search">
                  <Search size={13} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a metric" aria-label="Find a metric" />
                  {query && <button type="button" className="bi-icon-btn" onClick={() => setQuery('')} aria-label="Clear search"><X size={13} /></button>}
                </div>
                <div className="bi-tones" role="radiogroup" aria-label="Alert level">
                  {TONE_FILTERS.map((t) => (
                    <button key={t.value} type="button" role="radio" aria-checked={tone === t.value}
                      className={`bi-tone${tone === t.value ? ' bi-tone--on' : ''}`} onClick={() => setTone(t.value)}>
                      {t.value !== 'all' && <i style={{ background: toneColor(t.value) }} />}
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {cards.length === 0 ? (
              <div className="bi-empty">
                {narrowed ? 'No metric matches these filters.' : state.modules.length === 0 ? 'No module is reporting yet.' : 'Every module is hidden. Use Modules to show them again.'}
              </div>
            ) : (
              <div className="bi-grid">
                {cards.map(({ mod, stats, shapes }) => <ModuleCard key={mod.id} mod={mod} stats={stats} shapes={shapes} onDrill={onDrill} />)}
              </div>
            )}
          </section>
        </>
      )}

      {drill && <DrilldownModal key={`${drill.moduleId}:${drill.key}`} request={drill} onClose={closeDrill} />}
    </div>
  );
}
