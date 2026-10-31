import { useState } from 'react';
import { ArrowRight, Trash2, RotateCcw, Search, X, Check } from 'lucide-react';
import { assetCompleteness, assetTypeOf, assetRegionOf, categoryOf, cityRegion, searchHaystack, ASSET_CATEGORIES } from '../../lib/assetMetrics.js';
import { baseStage } from '../../lib/stages.js';
import HoldButton, { HOLD_MAJOR_MS } from '../../../ui/HoldButton';

// The panels that used to be the Manage page (Neil, Oct 21 2026: Manage is
// not a destination). Data Gaps and Flagged open from chips on the Needs
// Attention band; Activity Log and Trash from the portfolio's more menu. Each
// renders inline under the band, on the portfolio, and closes with its X.

const CARD = { border: '1px solid var(--border-color)', borderRadius: 14, background: 'var(--bg-card)', padding: '16px 18px', marginBottom: 16, boxShadow: 'var(--shadow-sm)' };

export function PanelHead({ title, subtitle, onClose, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <h3 style={{ fontSize: '1rem', margin: 0 }}>{title}</h3>
        {subtitle && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
      <button type="button" className="secondary-btn" onClick={onClose} aria-label={`Close ${title}`} style={{ padding: 7 }}><X size={15} /></button>
    </div>
  );
}

/** Completeness % -> tone (green / gold / orange), the same buckets the bars use. */
const tone = (pct) => (pct >= 100 ? 'green' : pct >= 60 ? 'gold' : 'orange');

/**
 * Data Gaps: every live asset, least complete first, with its missing fields as
 * chips and a search / filter row; Open goes to the asset, Delete asks inline.
 */
export function DataGapsPanel({ assets, onOpen, onDelete, serverOk, onClose }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [stage, setStage] = useState('');
  const [type, setType] = useState('');
  const [region, setRegion] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const q = query.trim().toLowerCase();
  const scored = assets.map((p) => ({ p, c: assetCompleteness(p) }));
  const stages = [...new Set(scored.map((x) => baseStage(x.p.devStage)).filter(Boolean))].sort();
  const types = [...new Set(scored.map((x) => assetTypeOf(x.p)).filter(Boolean))].sort();
  const regions = [...new Set(scored.map((x) => assetRegionOf(x.p)).filter(Boolean))].sort();
  const rows = scored.filter(({ p }) => (!category || categoryOf(p) === category) && (!stage || baseStage(p.devStage) === stage)
    && (!type || assetTypeOf(p) === type) && (!region || assetRegionOf(p) === region)
    && (!q || (p.name + ' ' + (cityRegion(p) || '') + ' ' + (p.entity || '') + ' ' + searchHaystack(p)).toLowerCase().includes(q)))
    .sort((a, b) => a.c.pct - b.c.pct || a.p.name.localeCompare(b.p.name));
  const filtered = category || stage || type || region || query;
  const clear = () => { setCategory(''); setStage(''); setType(''); setRegion(''); setQuery(''); };
  const selects = [[category, setCategory, 'All Categories', ASSET_CATEGORIES], [stage, setStage, 'All Stages', stages], [type, setType, 'All Types', types], [region, setRegion, 'All Regions', regions]];
  const need = scored.filter((x) => x.c.pct < 100).length;

  return (
    <div style={CARD}>
      <PanelHead title="Data Gaps" subtitle={need ? `${need} of ${assets.length} assets have fields to fill - least complete first.` : 'Every asset has its key fields.'} onClose={onClose} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 300 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input className="form-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search assets…" aria-label="Search assets" style={{ width: '100%', padding: '8px 12px 8px 33px', fontSize: '0.82rem' }} />
        </div>
        {selects.map(([value, set, allLabel, options]) => (
          <select key={allLabel} className="form-input" value={value} onChange={(e) => set(e.target.value)} aria-label={allLabel} style={{ padding: '8px 10px', fontSize: '0.8rem', maxWidth: 175, cursor: 'pointer' }}>
            <option value="">{allLabel}</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
        {filtered && <button type="button" onClick={clear} className="secondary-btn" style={{ fontSize: '0.78rem', padding: '7px 12px' }}>Clear Filters <X size={13} /></button>}
      </div>
      {deleteTarget && (
        <div style={{ marginBottom: 12, padding: '13px 14px', borderRadius: 11, border: '1px solid hsla(var(--color-red), 0.4)', backgroundColor: 'hsla(var(--color-red), 0.07)' }}>
          <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Move "{deleteTarget.name}" to Trash?</div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 11 }}>
            It can be restored from Trash{assets.some((x) => x.parentId === deleteTarget.id) ? '; its linked parcels become standalone.' : '.'}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="secondary-btn" onClick={() => setDeleteTarget(null)} style={{ fontSize: '0.8rem' }}>Keep</button>
            <button type="button" className="primary-btn" onClick={() => { onDelete(deleteTarget.id); setDeleteTarget(null); }} style={{ fontSize: '0.8rem', backgroundColor: 'hsl(var(--color-red))' }}>Move to Trash</button>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
          {q ? 'No assets match your search.' : serverOk === false ? "Couldn't reach the server to load assets - retrying automatically." : 'No assets yet - use Add Asset to register the first one.'}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
          {rows.map(({ p, c }) => (
            <div key={p.id} className="asset-linkrow" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) 130px minmax(0,3fr) auto', gap: 14, alignItems: 'center', padding: '11px 13px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ minWidth: 0 }}>
                <button type="button" onClick={() => onOpen(p.id)} title={'Open ' + p.name}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</strong>
                    {p.parentId && <span style={{ flexShrink: 0, fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'hsl(var(--color-purple))' }}>Linked</span>}
                  </span>
                  <span style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{cityRegion(p) || '-'}{p.devStage ? ' · ' + p.devStage : ''}</span>
                </button>
              </div>
              <div>
                <div style={{ height: 7, borderRadius: 999, background: 'var(--bg-secondary)', overflow: 'hidden' }} role="progressbar" aria-valuenow={c.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.name} ${c.pct}% complete`}>
                  <div style={{ width: c.pct + '%', height: '100%', background: `hsl(var(--color-${tone(c.pct)}))` }} />
                </div>
                <div style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-secondary)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{c.pct}% complete</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {c.missing.length ? c.missing.map((field) => (
                  <span key={field} style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-primary)', border: '1px solid var(--border-color)', padding: '2px 8px', borderRadius: 999 }}>{field}</span>
                )) : (
                  <span style={{ fontSize: '0.76rem', color: 'hsl(var(--color-green))', fontWeight: 600 }}><Check size={13} style={{ verticalAlign: '-2px' }} /> All key fields present</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => onOpen(p.id)} className="secondary-btn" style={{ flexShrink: 0, padding: '6px 11px', fontSize: '0.76rem' }}>Open <ArrowRight size={13} /></button>
                <button type="button" onClick={() => setDeleteTarget(p)} title={'Move ' + p.name + ' to Trash'} aria-label={'Move ' + p.name + ' to Trash'}
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'hsl(var(--color-red))'; e.currentTarget.style.background = 'hsla(var(--color-red), 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = 'transparent'; }}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Trash: restore a deleted asset, or remove it for good (asked inline).
 *  Delete Forever takes the asset and every record under it, so the inline
 *  ask names how many and its confirm is a hold (Neil, Oct 30 2026). */
export function TrashPanel({ deleted, onRecover, onPurge, onClose, recordsOf }) {
  const [purgeTarget, setPurgeTarget] = useState(null);
  // Counted when the ask opens, so the line does not change under the check.
  const records = purgeTarget ? purgeTarget.records : null;
  return (
    <div style={CARD}>
      <PanelHead title="Trash" subtitle="Restore a deleted asset, or remove it permanently." onClose={onClose} />
      {purgeTarget && (
        <div style={{ marginBottom: 12, padding: '13px 14px', borderRadius: 11, border: '1px solid hsla(var(--color-red), 0.4)', backgroundColor: 'hsla(var(--color-red), 0.07)' }}>
          <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Permanently delete "{purgeTarget.name}"?</div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 11 }}>
            This <strong>cannot be undone</strong> - the asset and {!records ? 'its records' : `its ${records} record${records === 1 ? '' : 's'} (warranties, inspections, documents, maintenance and the rest)`} are gone for good.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'flex-start' }}>
            <button type="button" className="secondary-btn" onClick={() => setPurgeTarget(null)} style={{ fontSize: '0.8rem' }}>Keep</button>
            <HoldButton key={purgeTarget.id} label="Delete Forever" doneLabel="Deleted" holdMs={HOLD_MAJOR_MS} clickRuns
              ariaLabel={`Delete ${purgeTarget.name} forever`}
              onConfirm={() => { onPurge(purgeTarget.id); }} onDone={() => setPurgeTarget(null)} />
          </div>
        </div>
      )}
      {deleted.length === 0 ? (
        <div style={{ padding: 14, fontSize: '0.84rem', color: 'var(--text-secondary)', border: '1px dashed var(--border-color)', borderRadius: 10 }}>Nothing in the Trash. Anything you delete appears here and can be restored.</div>
      ) : (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
          {deleted.map((x) => (
            <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{x.name}</strong>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cityRegion(x) || '-'}</div>
              </div>
              <button type="button" onClick={() => onRecover(x.id)} className="secondary-btn" style={{ flexShrink: 0, padding: '6px 11px', fontSize: '0.78rem' }}><RotateCcw size={14} /> Restore</button>
              <button type="button" onClick={() => setPurgeTarget({ ...x, records: recordsOf ? recordsOf(x.id) : null })} title={'Delete ' + x.name + ' permanently'} aria-label={'Delete ' + x.name + ' permanently'}
                style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'hsl(var(--color-red))'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
