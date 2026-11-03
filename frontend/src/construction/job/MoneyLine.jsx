// The money line on a Job's Overview (Neil, 11/03/2026, plan phase 4): Actual
// to Date against the budget on the progress track - orange while it is
// within the budget, red once it is over - for managers with Accounting
// access to the job's entity only (the server's Money read says; anyone else
// sees nothing here). Open Money goes to the tab with the ledger lines.
import ProgressTrack from '../../ui/ProgressTrack';
import { spendTrack, usd } from '../lib/money';

const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem',
  fontWeight: 600, color: 'var(--wk-brand, #2b45e1)',
};

export default function MoneyLine({ money, onOpen }) {
  const m = money?.data;
  if (!m?.allowed) return null;
  const track = spendTrack(m);
  let words;
  if (!m.mapped) words = 'Not linked to the books yet.';
  else if (!m.actual) words = 'The books could not be read just now.';
  else if (!track) words = `${usd(m.actual.amount)} actual to date. No budget set.`;
  else words = null;
  return (
    <div data-money-line="" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.84rem' }}>
        <b style={{ color: 'var(--text-primary)' }}>Money</b>
        {words && <span style={{ color: 'var(--text-secondary)' }}>{words}</span>}
        <button type="button" style={{ ...linkBtn, marginLeft: 'auto' }} onClick={onOpen}>Open Money</button>
      </div>
      {track && (
        <ProgressTrack size="sm" value={track.value} state={track.state} label="Actual against budget"
          start={`Actual ${usd(track.actual)}`} end={`Budget ${usd(track.budget)}`}
          note={track.over ? <><b>Over Budget</b> by {usd(track.actual - track.budget)}</> : <><b>{Math.round(track.value * 100)}% of budget</b> spent</>} />
      )}
    </div>
  );
}
