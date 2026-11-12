import { useMemo } from 'react';
import { AlertTriangle, ListChecks, History, ArrowRight, Pencil } from 'lucide-react';
import { collectCriticalDates, CRITICAL_ITEM_TAB } from '../../lib/criticalItems.js';
import { assetCompleteness, assetSignals } from '../../lib/assetMetrics.js';
import { formatDate } from '../../lib/format.js';
import { formatDateTime } from '../../../lib/datetime';
import { StatusLabel } from '../../../components/StatusLabel.jsx';

// The first screen of an asset (Neil, Oct 21 2026): what needs attention, what
// data is missing, what changed last - the three cards ARE the asset's health.
// The spec sheet sits under them as Details. Nothing here is a second
// calculation: Needs Attention is the Critical Items engine scoped to this
// asset plus the health signals that warn; Data Gaps is the same completeness
// Manage used; Recent Activity is the log.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: '14px 16px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 };
const head = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' };
const rowBtn = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '7px 8px', border: 'none', borderRadius: 8, background: 'none', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', fontSize: 13 };
const quiet = { fontSize: 13, color: 'var(--text-secondary)', padding: '4px 8px' };

const toneOf = (days) => (days < 0 ? 'hsl(var(--color-red))' : days <= 30 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-gold))');
const dueText = (days) => (days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due Today' : `Due in ${days}d`);
// A Critical Items category -> the health signal (assetSignals) about the same subject.
const SIGNAL_OF_CATEGORY = { Service: 'Service', Insurance: 'Insurance', Registration: 'Registration', Inspection: 'Inspections' };
const hover = (on) => (e) => { e.currentTarget.style.background = on ? 'var(--bg-secondary)' : 'none'; };

/**
 * props: asset, store, onTab(viewKey), onEdit(fieldLabel?), onGoTo(logEntry)
 */
export function AssetOverview({ asset, store, onTab, onEdit, onGoTo }) {
  const due = useMemo(() => collectCriticalDates(store).filter((x) => x.id === asset.id && x.days <= 90).sort((a, b) => a.days - b.days), [store, asset.id]);
  // Counted per subject: a health warning whose subject already has a critical-date row above
  // (Service, Insurance, Registration, Inspections) is that same item - shown and counted once.
  // A Service warning about MILES is its own item (the critical row is the date).
  const warnings = useMemo(() => {
    const covered = new Set(due.map((x) => SIGNAL_OF_CATEGORY[x.cat]).filter(Boolean));
    return assetSignals(asset, store).filter((s) => (s.t === 'warn' || s.t === 'bad') && !(covered.has(s.l) && s.by !== 'miles'));
  }, [asset, store, due]);
  const gaps = useMemo(() => assetCompleteness(asset), [asset]);
  const recent = useMemo(() => (store.logs || []).filter((l) => l.propertyId === asset.id).slice(0, 5), [store.logs, asset.id]);
  const attention = due.length + warnings.length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 16 }}>
      <section style={card} aria-label="Needs attention">
        <div style={head}><AlertTriangle size={16} style={{ color: attention ? 'hsl(var(--color-orange))' : 'var(--text-secondary)' }} /> Needs Attention
          {attention > 0 && <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-orange))' }}>{attention}</span>}
        </div>
        {attention === 0 ? (
          <div style={quiet}>Nothing due in the next 90 days.</div>
        ) : (
          <div>
            {due.slice(0, 6).map((x, i) => (
              <button key={i} type="button" style={rowBtn} onMouseEnter={hover(true)} onMouseLeave={hover(false)} onClick={() => onTab?.(CRITICAL_ITEM_TAB[x.cat] || 'property')}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: toneOf(x.days), flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}{x.detail ? ` - ${x.detail}` : ''}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: toneOf(x.days), whiteSpace: 'nowrap' }}>{dueText(x.days)} · {formatDate(x.date)}</span>
              </button>
            ))}
            {warnings.map((w) => (
              <div key={w.l} style={{ ...rowBtn, cursor: 'default' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: w.t === 'bad' ? 'hsl(var(--color-red))' : 'hsl(var(--color-orange))', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{w.l}: {w.v}</span>
              </div>
            ))}
            {due.length > 6 && <div style={quiet}>and {due.length - 6} more</div>}
          </div>
        )}
      </section>

      <section style={card} aria-label="Data gaps">
        <div style={head}><ListChecks size={16} style={{ color: gaps.pct === 100 ? 'hsl(var(--color-green))' : 'var(--text-secondary)' }} /> Data Gaps
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: gaps.pct === 100 ? 'hsl(var(--color-green))' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{gaps.pct}% complete</span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: 'var(--bg-secondary)', overflow: 'hidden' }} role="progressbar" aria-valuenow={gaps.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Fields filled in">
          <div style={{ width: `${gaps.pct}%`, height: '100%', background: gaps.pct === 100 ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))' }} />
        </div>
        {gaps.missing.length === 0 ? (
          <div style={quiet}>Every key field has a value.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {gaps.missing.slice(0, 12).map((field) => (
              <button key={field} type="button" onClick={() => onEdit?.(field)} title={`Fill in ${field}`}
                style={{ border: '1px solid var(--border-color)', background: 'var(--bg-card)', borderRadius: 999, padding: '3px 10px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit' }}>
                {field}
              </button>
            ))}
            {gaps.missing.length > 12 && <span style={{ ...quiet, padding: '3px 4px' }}>and {gaps.missing.length - 12} more</span>}
          </div>
        )}
        {gaps.missing.length > 0 && (
          <button type="button" className="secondary-btn" onClick={() => onEdit?.()} style={{ alignSelf: 'flex-start' }}><Pencil size={13} /> Fill In the Gaps</button>
        )}
      </section>

      <section style={card} aria-label="Recent activity">
        <div style={head}><History size={16} style={{ color: 'var(--text-secondary)' }} /> Recent Activity</div>
        {recent.length === 0 ? (
          <div style={quiet}>No changes recorded yet.</div>
        ) : (
          <div>
            {recent.map((l) => (
              <button key={l.id} type="button" style={rowBtn} onMouseEnter={hover(true)} onMouseLeave={hover(false)} onClick={() => onGoTo?.(l)} title="Go to this change">
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <StatusLabel label={l.action === 'added' ? 'Added' : l.action === 'removed' ? 'Removed' : 'Edited'} color={l.action === 'removed' ? 'hsl(var(--color-red))' : l.action === 'added' ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))'} size="sm" />
                    {' '}{l.item || l.section}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)' }}>{l.user ? `${l.user} · ` : ''}{formatDateTime(l.ts)}</span>
                </span>
                <ArrowRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
