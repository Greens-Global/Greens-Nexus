// The ledger lines behind a job's Actual to Date (plan phase 4): the total,
// or one cost code / GL account row, in the Accounting side panel - the same
// searches the figure was added up from (moneyDrill.js: the job's
// Project-Job, its entity, the accrual book, to the day it was read), every
// line opening its journal entry, and a check that the lines add up to the
// figure. One panel for the Money tab and the Overview's money line (which
// loads this file only when the figure is opened).
import LinesPanel from '../../components/accounting/LinesPanel';
import { formatDate } from '../../lib/datetime';
import { actualQueries, actualReport, keepFor } from '../lib/moneyDrill';

export default function ActualLines({ money: m, row = null, onClose }) {
  const link = m?.link || {};
  const title = row ? `${row.label} - Actual to Date` : 'Actual to Date';
  return (
    <LinesPanel key={title} label={title} title={title}
      caption={`Project-Job ${link.project} - ${link.entityName || link.entity} - through ${formatDate(m.asOf, m.asOf)}`}
      queries={actualQueries(m, row)} report={row ? actualReport(m, row) : null} keep={keepFor(m, row)}
      figure={row ? row.amount : m?.actual?.amount ?? null} widthsKey="construction-money" onClose={onClose} />
  );
}
