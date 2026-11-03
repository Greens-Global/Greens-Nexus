// The money line on a Job's Overview (Neil, 11/03/2026, plan phase 4): Actual
// to Date against the budget on the progress track - orange while within
// it, red once the job is Over Budget (the server's rule, the same as the
// dashboard card) - for managers with Accounting access to the job's entity
// only (the server's Money read says; anyone else sees nothing here). The
// Actual figure opens its ledger lines like the tab's (ActualLines, loaded
// only when opened); Open Money goes to the tab.
import { lazy, Suspense, useState } from 'react';
import ProgressTrack from '../../ui/ProgressTrack';
import { spendTrack, usd } from '../lib/money';

const ActualLines = lazy(() => import('./ActualLines'));

const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem',
  fontWeight: 600, color: 'var(--wk-brand, #2b45e1)',
};
const figureBtn = {
  background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', fontFamily: 'inherit', font: 'inherit',
  color: 'inherit', textDecoration: 'underline', textDecorationColor: 'var(--border-color)', textUnderlineOffset: 3,
};

export default function MoneyLine({ money, onOpen }) {
  const [lines, setLines] = useState(false);
  const m = money?.data;
  if (!m?.allowed) return null;
  const track = spendTrack(m);
  const actual = m.actual ? (
    <button type="button" style={figureBtn} onClick={() => setLines(true)} aria-label="Ledger lines behind Actual to Date"
      title="See the ledger lines behind this amount">{usd(m.actual.amount)}</button>
  ) : null;
  let words;
  if (!m.mapped) words = 'Not linked to the books yet.';
  else if (!m.actual) words = 'The books could not be read just now.';
  else if (!track) words = <>{actual} actual to date. No budget set.</>;
  else words = null;
  return (
    <div data-money-line="" className="acct-module" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.84rem' }}>
        <b style={{ color: 'var(--text-primary)' }}>Money</b>
        {words && <span style={{ color: 'var(--text-secondary)' }}>{words}</span>}
        <button type="button" style={{ ...linkBtn, marginLeft: 'auto' }} onClick={onOpen}>Open Money</button>
      </div>
      {track && (
        <ProgressTrack size="sm" value={track.value} state={track.state} label="Actual against budget"
          start={<>Actual {actual}</>} end={`Budget ${usd(track.budget)}`}
          note={track.over ? <><b>Over Budget</b> by {usd(track.by)} with requests not yet billed</> : <><b>{Math.round(track.value * 100)}% of budget</b> spent</>} />
      )}
      {lines && (
        <Suspense fallback={null}>
          <ActualLines money={m} onClose={() => setLines(false)} />
        </Suspense>
      )}
    </div>
  );
}
