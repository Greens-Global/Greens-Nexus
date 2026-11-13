import { Suspense, lazy, useState } from 'react';
import { mEnd, mStart, shiftKey } from '../../../accounting/dashboard/model/months';
import { inScope } from '../../../accounting/dashboard/model/scope';
import { requestStatement } from '../drill';
import { lineQuery } from '../reportModel';
import { useDash } from './DashContext';

// 11/11/2026 (picture 4; Charmi's call of 10/27, item 17): a posted figure on
// the dashboard's Budget vs Actual opens the ledger lines behind it in the side
// panel, in the dashboard's scope, window and book - Open in Reports takes them
// to the General Ledger. Loaded on the first click, so the dashboard stays light.
const LinesPanel = lazy(() => import('../LinesPanel'));

/**
 * [open(line, opts), panel]: `line` is one dashboard ledger line ({ gl, name }).
 * opts: `yearsAgo` / `monthsAgo` shift the dashboard's window back; `from` / `to`
 * (ISO dates) replace it - `from: ''` is a balance, every line from the start.
 */
export function useLineDrill() {
  const { ix, entities, scope, fromKey, period, book } = useDash();
  const [open, setOpen] = useState(null);
  const show = (line, { yearsAgo = 0, monthsAgo = 0, ...span } = {}) => {
    const back = 12 * yearsAgo + monthsAgo;
    const from = span.from ?? mStart(shiftKey(fromKey, back));
    const to = span.to ?? mEnd(shiftKey(period, back));
    const my = (iso) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
    const ents = scope === 'ALL' ? [] : entities.filter((e) => inScope(ix, e.code, scope)).map((e) => e.code);
    const both = book === 'all' ? 'both' : book;
    setOpen({
      key: `${line.gl}|${from}|${to}|${scope}|${book}`,
      title: `${line.gl} ${line.name}`,
      caption: from ? `${my(from)} - ${my(to)}` : `Balance through ${my(to)}`,
      queries: [lineQuery({ account: line.gl, drill: { from, to, book: both }, entities: ents })],
      report: { account: line.gl, accountName: line.name, from, to, book: both, entities: ents },
    });
  };
  const panel = open ? (
    <Suspense fallback={null}>
      <LinesPanel key={open.key} title={open.title} caption={open.caption} queries={open.queries} report={open.report} widthsKey="dash-bva" onClose={() => setOpen(null)} />
    </Suspense>
  ) : null;
  return [show, panel];
}

/**
 * open(span?): the Income Statement on Reports in the dashboard's scope and book -
 * for this year to the dashboard's month, or for `span` ({ from, to } ISO dates).
 * Safe as an onClick (an event is not a span).
 */
export function useStatementOpen() {
  const { ix, entities, scope, period, book } = useDash();
  return (span) => requestStatement({
    entities: scope === 'ALL' ? [] : entities.filter((e) => inScope(ix, e.code, scope)).map((e) => e.code),
    from: span?.from || `${period.slice(0, 4)}-01-01`, to: span?.to || mEnd(period), book: book === 'all' ? '' : book,
  });
}

/** The dashboard's own window ({ from, to } ISO dates), `monthsAgo` months back. */
export function useWindow() {
  const { fromKey, period } = useDash();
  return (monthsAgo = 0) => ({ from: mStart(shiftKey(fromKey, monthsAgo)), to: mEnd(shiftKey(period, monthsAgo)) });
}

/** A table figure that opens its lines: looks like the figure until hovered. */
export function DrillFigure({ onOpen, children, title = 'See the ledger lines behind this amount' }) {
  return <button type="button" className="acct-drill" title={title} onClick={onOpen}>{children}</button>;
}
