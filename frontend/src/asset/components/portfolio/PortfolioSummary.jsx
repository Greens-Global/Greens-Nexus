import { useState } from 'react';
import { summarySentence, needsOf } from '../../lib/portfolioQuery.js';
import { formatDate } from '../../lib/format.js';

const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * The register's summary (Neil, 11/17/2026): ONE sentence of counts as words ("23 properties
 * in 8 states - 131 acres and 664,000 rentable square feet."), then a line of what needs you
 * on THIS list - dates passed (red), no asset manager, dates that look mistyped (orange) -
 * each a link that filters to it, and Review / Hide for the dates themselves. A zero is left
 * out; nothing waiting says nothing. On a phone the sentence steps aside for the line alone.
 */
export function PortfolioSummary({ rows, ctx, phone = false, onShow, onFix, onOpenDate, loading = false }) {
  const [open, setOpen] = useState(false);
  if (loading) return <div className="pt-summary"><div className="pt-skel" style={{ width: '52%', height: 22 }} /><div className="pt-skel" style={{ width: '30%', height: 14, marginTop: 10 }} /></div>;
  const needs = needsOf(rows, ctx);
  const parts = [];
  if (needs.passed) parts.push(<button key="p" type="button" className="pt-link is-red" onClick={() => onShow('passed')}>{needs.passed} {needs.passed === 1 ? 'date' : 'dates'} passed</button>);
  if (needs.noManager) parts.push(<button key="m" type="button" className="pt-link is-ink" onClick={() => onShow('no-manager')}>{needs.noManager} with no asset manager</button>);
  if (needs.mistyped) parts.push(<button key="t" type="button" className="pt-link is-live" onClick={() => onShow('mistyped')}>{needs.mistyped} {needs.mistyped === 1 ? 'date that looks' : 'dates that look'} mistyped</button>);
  if (needs.items.length) parts.push(<button key="r" type="button" className="pt-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Review'}</button>);
  return (
    <div className="pt-summary">
      {!phone && <p className="pt-lead">{summarySentence(rows, ctx)}</p>}
      {parts.length > 0 && (
        <div className="pt-needs">
          {parts.map((p, i) => <span key={p.key}>{i > 0 && <span className="pt-sep" aria-hidden="true">·</span>}{p}</span>)}
        </div>
      )}
      {open && needs.items.length > 0 && (
        <div className="pt-attention" role="list" aria-label="Dates to look at">
          {needs.items.slice(0, 40).map((d, i) => (
            <div key={`${d.assetId}:${d.cat}:${d.label}:${d.date}:${i}`} role="listitem" className="pt-att-row">
              <span className={d.suspect ? 'pt-att-when is-live' : 'pt-att-when is-red'}>{d.suspect ? 'Check this date' : `${days(-d.days)} overdue`}</span>
              <button type="button" className="pt-att-what" onClick={() => onOpenDate(d)}>
                <b>{d.name}</b> <span className="pt-dim">- {d.suspect ? `${d.cat} reads ${d.date}` : `${d.cat}${d.detail ? `, ${d.detail}` : ''} ${d.label.replace(d.cat, '').trim().toLowerCase()}`}</span>
              </button>
              {d.suspect
                ? <button type="button" className="pt-link pt-att-side" onClick={() => onFix(d)}>Fix</button>
                : <span className="pt-att-side pt-dim">{formatDate(d.date)}</span>}
            </div>
          ))}
          {needs.items.length > 40 && <div className="pt-fnote">And {needs.items.length - 40} more - the Dates tab lists every one.</div>}
        </div>
      )}
    </div>
  );
}
