import { useState } from 'react';
import { ArrowLeft, Plus, ArrowRight, Trash2, RotateCcw, Search, Settings } from 'lucide-react';
import { assetCompleteness, assetTypeOf, assetRegionOf, categoryOf, cityRegion, searchHaystack, ASSET_CATEGORIES } from '../../lib/assetMetrics.js';
import { baseStage } from '../../lib/stages.js';
import { ReviewFlagsPanel } from './ReviewFlagsPanel.jsx';
import { ActivityLog } from './ActivityLog.jsx';

const MONO_FONT = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

const CARD_STYLE = {
  border: '1px solid var(--border-color)',
  borderRadius: 14,
  background: 'var(--bg-card)',
  padding: '18px 20px',
  marginBottom: 16,
};

/** Completeness % -> tone name (green/gold/orange), same buckets used for the progress bars. */
function completenessTone(pct) {
  if (pct >= 100) return 'green';
  if (pct >= 60) return 'gold';
  return 'orange';
}

/**
 * The Manage page - admin / data-quality dashboard reachable from the "Manage" button.
 * KPI tiles up top, then 4 tabs: Flagged for Review, Data Completeness, Activity Log, Trash.
 *
 * props:
 *   props           - all live (non-deleted) assets
 *   logs            - full activity log array
 *   deletedProps    - assets currently in Trash
 *   onBack          - return to portfolio view
 *   onAdd           - open the Add Asset flow
 *   onDelete(id)    - soft-delete (moves to Trash)
 *   onRecover(id)   - restore from Trash
 *   onPurge(id)     - permanently delete from Trash
 *   onOpenProperty(id) - navigate to an asset's own page
 *   onGoTo(logEntry)   - "Go to" a specific activity-log change
 *   onUndo(logEntry)   - revert a logged change
 *   canUndo(logEntry)  - whether that entry is still undoable
 *   onClearFlag(id, group, field) - resolve a review flag without changing the value
 *   onPushFix(id, group, field, value) - write a corrected value and auto-clear its flag
 */
export function ManagePage({
  props: assets,
  logs,
  deletedProps,
  onBack,
  onAdd,
  onDelete,
  onRecover,
  onPurge,
  onOpenProperty,
  onGoTo,
  onUndo,
  canUndo,
  onClearFlag,
  onPushFix,
  serverOk,
}) {
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('data');

  // Data Completeness filters: category, stage, asset type, region.
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStage, setFilterStage] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterRegion, setFilterRegion] = useState('');

  const q = query.trim().toLowerCase();

  // Completeness is computed once per asset up front; everything below (KPIs, filters, sort)
  // derives from this.
  const completeness = assets.map((p) => ({ p, c: assetCompleteness(p) }));

  const avgCompleteness = completeness.length
    ? Math.round(completeness.reduce((sum, x) => sum + x.c.pct, 0) / completeness.length)
    : 100;
  const fullyComplete = completeness.filter((x) => x.c.pct === 100).length;
  const needData = completeness.length - fullyComplete;
  const flagCount = assets.reduce((sum, p) => sum + (p.reviewFlags || []).length, 0);

  // Filter dropdown option lists, derived from what's actually present in the portfolio.
  const stageOptions = [...new Set(completeness.map((x) => baseStage(x.p.devStage)).filter(Boolean))].sort();
  const typeOptions = [...new Set(completeness.map((x) => assetTypeOf(x.p)).filter(Boolean))].sort();
  const regionOptions = [...new Set(completeness.map((x) => assetRegionOf(x.p)).filter(Boolean))].sort();

  const clearFilters = () => {
    setFilterCategory('');
    setFilterStage('');
    setFilterType('');
    setFilterRegion('');
    setQuery('');
  };

  const rows = completeness
    .filter((x) => {
      const p = x.p;
      if (filterCategory && categoryOf(p) !== filterCategory) return false;
      if (filterStage && baseStage(p.devStage) !== filterStage) return false;
      if (filterType && assetTypeOf(p) !== filterType) return false;
      if (filterRegion && assetRegionOf(p) !== filterRegion) return false;
      if (q) {
        const haystack = (p.name + ' ' + (cityRegion(p) || '') + ' ' + (p.entity || '') + ' ' + searchHaystack(p)).toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    // Least-complete first, so the worst gaps surface at the top.
    .sort((a, b) => a.c.pct - b.c.pct || a.p.name.localeCompare(b.p.name));

  const kpi = (label, value, sub, color) => (
    <div style={{ flex: '1 1 150px', border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-card)', padding: '14px 16px' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: MONO_FONT, color: color ? `hsl(var(--color-${color}))` : 'var(--text-primary)' }}>
        {value}
      </div>
      <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 1 }}>{sub}</div>}
    </div>
  );

  const TABS = [
    ['flags', 'Flagged for Review', flagCount],
    ['data', 'Data Completeness', needData],
    ['activity', 'Activity Log', 0],
    ['trash', 'Trash', deletedProps.length],
  ];

  const filterSelects = [
    [filterCategory, setFilterCategory, 'All Categories', ASSET_CATEGORIES],
    [filterStage, setFilterStage, 'All Stages', stageOptions],
    [filterType, setFilterType, 'All Types', typeOptions],
    [filterRegion, setFilterRegion, 'All Regions', regionOptions],
  ];

  return (
    <div>
      <button
        onClick={onBack}
        title="Back to portfolio"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 14, padding: '7px 13px',
          borderRadius: 999, border: '1px solid var(--border-color)', background: 'var(--bg-card)',
          color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer',
        }}
      >
        <ArrowLeft size={14} /> Portfolio
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <span style={{
              flexShrink: 0, width: 34, height: 34, borderRadius: 10, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', color: 'var(--pine)',
              backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            }}>
              <Settings size={18} />
            </span>
            <h1 style={{ fontSize: '1.5rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.02em', margin: 0 }}>
              Manage
            </h1>
          </div>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: 6, maxWidth: 660 }}>
            Add or remove assets, track data quality across the portfolio, and review every change. Open any asset to edit it on its own page.
          </div>
        </div>
        <button className="primary-btn" onClick={onAdd} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Asset
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {kpi('Total Assets', assets.length, null, null)}
        {kpi('Avg. Completeness', avgCompleteness + '%', null, completenessTone(avgCompleteness))}
        {kpi('Fully Complete', fullyComplete, 'of ' + assets.length, fullyComplete ? 'green' : null)}
        {kpi('Need Data', needData, needData ? 'open to fill gaps' : 'all set', needData ? 'orange' : 'green')}
        {kpi('Flagged for Review', flagCount, flagCount ? 'needs resolution' : 'all clear', flagCount ? 'orange' : 'green')}
      </div>

      {/* Mobile bug fix: without `.manage-tabs` (horizontal-scroll CSS in styles.css), this row had
          no wrap/scroll and Trash was completely unreachable below 640px. */}
      <div className="manage-tabs" style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
        {TABS.map(([key, label, badge]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', border: 'none',
              background: 'transparent', cursor: 'pointer', fontSize: '0.86rem',
              fontWeight: tab === key ? 700 : 600, color: tab === key ? 'var(--pine)' : 'var(--text-secondary)',
              borderBottom: tab === key ? '2px solid var(--pine)' : '2px solid transparent', marginBottom: -1,
            }}
          >
            {label}
            {badge > 0 && (
              <span style={{
                fontSize: '0.68rem', fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                color: 'hsl(var(--color-orange))', backgroundColor: 'hsla(var(--color-orange), 0.14)',
              }}>
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'flags' && (
        <ReviewFlagsPanel props={assets} onClearFlag={onClearFlag} onOpen={onOpenProperty} onPushFix={onPushFix} />
      )}

      {tab === 'data' && (
        <div style={CARD_STYLE}>
          <h3 style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: '0 0 2px' }}>Data Completeness</h3>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 13 }}>
            Sorted by least complete first - open an asset to fill the gaps.
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 300 }}>
              <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input
                className="form-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search assets…"
                style={{ width: '100%', padding: '8px 12px 8px 33px', fontSize: '0.82rem' }}
              />
            </div>
            {filterSelects.map(([value, setValue, allLabel, options], i) => (
              <select
                key={i}
                className="form-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={{ padding: '8px 10px', fontSize: '0.8rem', maxWidth: 175, cursor: 'pointer' }}
              >
                <option value="">{allLabel}</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ))}
            {(filterCategory || filterStage || filterType || filterRegion || query) && (
              <button onClick={clearFilters} className="secondary-btn" style={{ fontSize: '0.78rem', padding: '7px 12px' }}>
                Clear Filters ✕
              </button>
            )}
          </div>

          {deleteTarget && (
            <div style={{
              marginBottom: 12, padding: '13px 14px', borderRadius: 11,
              border: '1px solid hsl(var(--color-red) / 0.4)', backgroundColor: 'hsl(var(--color-red) / 0.07)',
            }}>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
                Delete “{deleteTarget.name}”?
              </div>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 11 }}>
                It moves to Recover Deleted below and can be restored
                {assets.some((x) => x.parentId === deleteTarget.id) ? '. Its linked secondaries become standalone.' : '.'}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="secondary-btn" onClick={() => setDeleteTarget(null)} style={{ fontSize: '0.8rem' }}>Cancel</button>
                <button
                  className="primary-btn"
                  onClick={() => { onDelete(deleteTarget.id); setDeleteTarget(null); }}
                  style={{ fontSize: '0.8rem', backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
                >
                  Delete
                </button>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
              {q ? 'No assets match your search.'
                : serverOk === false ? "Couldn't reach the server to load assets - retrying automatically. Nothing has been deleted."
                : 'No assets yet - use Add Asset to register the first one.'}
            </div>
          ) : (
            <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
              {rows.map(({ p, c }) => {
                const tone = completenessTone(c.pct);
                return (
                  <div
                    key={p.id}
                    className="asset-linkrow"
                    style={{
                      display: 'grid', gridTemplateColumns: 'minmax(0,2fr) 130px minmax(0,3fr) auto',
                      gap: 14, alignItems: 'center', padding: '11px 13px', borderBottom: '1px solid var(--border-color)',
                    }}
                  >
                    <div onClick={() => onOpenProperty(p.id)} title={'Open ' + p.name} style={{ minWidth: 0, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.name}
                        </strong>
                        {p.parentId && (
                          <span style={{ flexShrink: 0, fontSize: '0.56rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'hsl(var(--color-purple))' }}>
                            Linked
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                        {cityRegion(p) || '-'}{p.devStage ? ' · ' + p.devStage : ''}
                      </div>
                    </div>

                    <div>
                      <div style={{ height: 7, borderRadius: 999, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                        <div style={{ width: c.pct + '%', height: '100%', background: `hsl(var(--color-${tone}))` }} />
                      </div>
                      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: `hsl(var(--color-${tone}))`, marginTop: 3 }}>
                        {c.pct}% complete
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {c.missing.length ? (
                        c.missing.map((field, i) => (
                          <span key={i} style={{
                            fontSize: '0.66rem', fontWeight: 600, color: 'hsl(var(--color-orange))',
                            backgroundColor: 'hsla(var(--color-orange), 0.12)', padding: '2px 8px', borderRadius: 999,
                          }}>
                            {field}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: '0.74rem', color: 'hsl(var(--color-green))', fontWeight: 600 }}>
                          ✓ All key fields present
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => onOpenProperty(p.id)}
                        className="secondary-btn"
                        style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', fontSize: '0.76rem' }}
                      >
                        Open <ArrowRight size={13} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(p)}
                        title={'Delete ' + p.name}
                        style={{
                          flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-color)',
                          background: 'transparent', color: 'hsl(var(--color-red))', cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div style={CARD_STYLE}>
          <ActivityLog
            logs={logs}
            query=""
            onOpenProperty={onOpenProperty}
            activeId={null}
            activeName=""
            onGoTo={onGoTo}
            onUndo={onUndo}
            canUndo={canUndo}
            assetsForKind={assets}
          />
        </div>
      )}

      {tab === 'trash' && (
        <div style={CARD_STYLE}>
          <h3 style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: '0 0 2px' }}>Trash</h3>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 13 }}>
            Restore a deleted asset, or remove it permanently.
          </div>

          {purgeTarget && (
            <div style={{
              marginBottom: 12, padding: '13px 14px', borderRadius: 11,
              border: '1px solid hsl(var(--color-red) / 0.4)', backgroundColor: 'hsl(var(--color-red) / 0.07)',
            }}>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
                Permanently delete “{purgeTarget.name}”?
              </div>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 11 }}>
                This <strong>cannot be undone</strong> - the asset is gone for good.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="secondary-btn" onClick={() => setPurgeTarget(null)} style={{ fontSize: '0.8rem' }}>Cancel</button>
                <button
                  className="primary-btn"
                  onClick={() => { onPurge(purgeTarget.id); setPurgeTarget(null); }}
                  style={{ fontSize: '0.8rem', backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}
                >
                  Delete Forever
                </button>
              </div>
            </div>
          )}

          {deletedProps.length === 0 ? (
            <div style={{ padding: '14px', fontSize: '0.84rem', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
              No deleted assets. Anything you delete appears here.
            </div>
          ) : (
            <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
              {deletedProps.map((x) => (
                <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border-color)' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{x.name}</strong>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cityRegion(x) || '-'}
                    </div>
                  </div>
                  <button
                    onClick={() => onRecover(x.id)}
                    className="secondary-btn"
                    style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', fontSize: '0.78rem', color: 'var(--pine)', borderColor: 'var(--pine)' }}
                  >
                    <RotateCcw size={14} /> Recover
                  </button>
                  <button
                    onClick={() => setPurgeTarget(x)}
                    title={'Delete ' + x.name + ' permanently'}
                    style={{
                      flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-color)',
                      background: 'transparent', color: 'hsl(var(--color-red))', cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
