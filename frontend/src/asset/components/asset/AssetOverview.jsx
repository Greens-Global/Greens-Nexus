import { useMemo } from 'react';
import { Check, ArrowRight } from 'lucide-react';
import { collectCriticalDates, CRITICAL_ITEM_TAB } from '../../lib/criticalItems.js';
import { assetSignals, snapMap } from '../../lib/assetMetrics.js';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { formatDate } from '../../lib/format.js';

// Needs Attention, the first thing on an asset's Overview (Neil, Oct 21 2026;
// look 11/17/2026). Sentences on hairline rows, the state as colored words.
// When nothing is due it says WHY it is quiet - "No insurance or property tax
// dates are on file, so none can come due." - so a quiet page is never read as
// a clean one. Nothing here is a second calculation: the rows are the Critical
// Items engine scoped to this asset, plus the health signals that warn.

// A Critical Items category -> the health signal (assetSignals) about the same subject.
const SIGNAL_OF_CATEGORY = { Service: 'Service', Insurance: 'Insurance', Registration: 'Registration', Inspection: 'Inspections' };
const TAB_WORD = { property: 'Details', vservice: 'Service', warranties: 'Warranties', inspections: 'Inspections', vendors: 'Vendors', ahj: 'AHJ', maintenance: 'Maintenance' };
const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
const whenText = (d) => (d < 0 ? `${days(Math.abs(d))} overdue` : d === 0 ? 'Due today' : `In ${days(d)}`);
const whenTone = (d) => (d < 0 ? 'hsl(var(--color-red))' : d <= 30 ? 'hsl(var(--color-orange))' : 'var(--text-secondary)');
// A date a hundred years out (or back) is a typing slip, never a due date.
const sane = (x) => Math.abs(x.days) < 36500;

const link = { border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'hsl(var(--color-green))', cursor: 'pointer' };

/** Why nothing is due: which date kinds are missing (they could never come due), else the
 *  next date on file beyond the 90-day window. `{ text, field }` - field is the one to fill. */
function quietReason(asset, later) {
  const snap = snapMap(asset);
  const vehicle = inferAssetKind(asset) !== 'property';
  const ins = String(asset.insExpiration || snap['policy expiration'] || '').trim();
  const second = vehicle ? String(snap['registration expiration'] || '').trim() : String(asset.taxDue || snap['due dates'] || '').trim();
  const secondWord = vehicle ? 'registration' : 'property tax';
  const missing = [!ins && 'insurance', !second && secondWord].filter(Boolean);
  if (missing.length === 2) return { text: `No insurance or ${secondWord} dates are on file, so none can come due.`, field: 'Policy Expiration', action: 'Add Dates' };
  if (missing.length === 1) {
    const field = missing[0] === 'insurance' ? 'Policy Expiration' : vehicle ? 'Registration Expiration' : 'Due Dates';
    return { text: `No ${missing[0]} date is on file, so it cannot come due.`, field, action: 'Add the Date' };
  }
  if (later) return { text: `The next date on file is ${later.label.toLowerCase()} on ${formatDate(later.date)}.` };
  return null;
}

/**
 * props: asset, store, onTab(viewKey), onEdit(fieldLabel?)
 */
export function NeedsAttention({ asset, store, onTab, onEdit }) {
  const all = useMemo(() => collectCriticalDates(store).filter((x) => x.id === asset.id && sane(x)).sort((a, b) => a.days - b.days), [store, asset.id]);
  const due = useMemo(() => all.filter((x) => x.days <= 90), [all]);
  // Counted per subject: a health warning whose subject already has a critical-date row above
  // (Service, Insurance, Registration, Inspections) is that same item - shown and counted once.
  // A Service warning about MILES is its own item (the critical row is the date).
  const warnings = useMemo(() => {
    const covered = new Set(due.map((x) => SIGNAL_OF_CATEGORY[x.cat]).filter(Boolean));
    return assetSignals(asset, store).filter((s) => (s.t === 'warn' || s.t === 'bad') && !(covered.has(s.l) && s.by !== 'miles'));
  }, [asset, store, due]);
  const count = due.length + warnings.length;
  const reason = count ? null : quietReason(asset, all.find((x) => x.days > 90));

  return (
    <section aria-label="Needs Attention" style={{ paddingBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Needs Attention</h3>
        {count > 0 && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>{count} {count === 1 ? 'item' : 'items'}</span>}
      </div>
      {count === 0 ? (
        <>
          <p style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: 13, color: 'var(--text-primary)' }}>
            <Check size={16} aria-hidden="true" style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} /> Nothing due in the next 90 days.
          </p>
          {reason && (
            <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {reason.text}{' '}
              {reason.field && onEdit && <button type="button" onClick={() => onEdit(reason.field)} style={link}>{reason.action}</button>}
            </p>
          )}
        </>
      ) : (
        <div>
          {due.slice(0, 8).map((x, i) => {
            const tab = CRITICAL_ITEM_TAB[x.cat] || 'property';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '9px 0', borderTop: i ? '1px solid var(--border-color)' : 'none', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)' }}>{x.label}{x.detail ? ` - ${x.detail}` : ''}<span style={{ color: 'var(--text-secondary)' }}>, {formatDate(x.date)}</span></span>
                <span style={{ fontWeight: 600, color: whenTone(x.days), whiteSpace: 'nowrap' }}>{whenText(x.days)}</span>
                {onTab && (
                  <button type="button" onClick={() => onTab(tab)} aria-label={`Open ${TAB_WORD[tab] || 'it'} for ${x.label}`}
                    style={{ ...link, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                    {TAB_WORD[tab] || 'Open'} <ArrowRight size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
          {warnings.map((w, i) => (
            <div key={w.l} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '9px 0', borderTop: due.length || i ? '1px solid var(--border-color)' : 'none', fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)' }}>{w.l}: {w.v}</span>
              <span style={{ fontWeight: 600, color: w.t === 'bad' ? 'hsl(var(--color-red))' : 'hsl(var(--color-orange))', whiteSpace: 'nowrap' }}>{w.t === 'bad' ? 'Needs action' : 'Coming up'}</span>
            </div>
          ))}
          {due.length > 8 && <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>and {due.length - 8} more</p>}
        </div>
      )}
    </section>
  );
}

/** The pre-11/17/2026 name the module shell mounted; the Overview is AssetOverviewPage now. */
export function AssetOverview({ asset, store, onTab, onEdit }) {
  return <NeedsAttention asset={asset} store={store} onTab={onTab} onEdit={onEdit} />;
}
