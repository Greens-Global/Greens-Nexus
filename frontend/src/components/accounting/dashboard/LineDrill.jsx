import { Suspense, lazy, useState } from 'react';
import { mEnd, mStart, shiftKey } from '../../../accounting/dashboard/model/months';
import { inScope } from '../../../accounting/dashboard/model/scope';
import { lineQuery } from '../reportModel';
import { useDash } from './DashContext';

// 11/11/2026 (picture 4; Charmi's call of 10/27, item 17): a posted figure on
// the dashboard's Budget vs Actual opens the ledger lines behind it in the side
// panel, in the dashboard's scope, window and book - Open in Reports takes them
// to the General Ledger. Loaded on the first click, so the dashboard stays light.
const LinesPanel = lazy(() => import('../LinesPanel'));

/** [open(line, { yearsAgo }), panel]: `line` is one dashboard ledger line ({ gl, name }). */
export function useLineDrill() {
  const { ix, entities, scope, fromKey, period, book } = useDash();
  const [open, setOpen] = useState(null);
  const show = (line, { yearsAgo = 0 } = {}) => {
    const from = mStart(shiftKey(fromKey, 12 * yearsAgo));
    const to = mEnd(shiftKey(period, 12 * yearsAgo));
    const ents = scope === 'ALL' ? [] : entities.filter((e) => inScope(ix, e.code, scope)).map((e) => e.code);
    const both = book === 'all' ? 'both' : book;
    setOpen({
      key: `${line.gl}|${from}|${to}|${scope}|${book}`,
      title: `${line.gl} ${line.name}`,
      caption: `${from.slice(5, 7)}/${from.slice(0, 4)} - ${to.slice(5, 7)}/${to.slice(0, 4)}`,
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

/** A table figure that opens its lines: looks like the figure until hovered. */
export function DrillFigure({ onOpen, children }) {
  return <button type="button" className="acct-drill" title="See the ledger lines behind this amount" onClick={onOpen}>{children}</button>;
}
