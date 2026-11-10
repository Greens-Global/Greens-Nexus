// Training > Compliance (Oct 30 2026): the signed-in person's OWN requirements -
// every assigned course and every policy they must sign, with the same
// green / amber / red rule as the team report (GET /kb/compliance?scope=me).
// The team view stays under Manage > Compliance.
import { useEffect, useState } from 'react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { errText } from '../components/Toast';
import { goKb, CELL_COLORS, fmtDate, plural } from '../lib';

const ORDER = { red: 0, amber: 1, green: 2 };

// "62% met · 3 overdue or expired · 5 due soon or in progress · 13 in all"
export function standing(stats, n) {
  if (!n) return '';
  return [`${stats.compliant_pct}% met`, stats.overdue ? `${stats.overdue} overdue or expired` : 'nothing overdue',
    stats.due_soon ? `${stats.due_soon} due soon or in progress` : '', `${n} in all`].filter(Boolean).join(' · ');
}

function whenText(cell) {
  if (cell.signed_at) return `Signed ${fmtDate(cell.signed_at)}`;
  if (cell.days_overdue > 0) return `${plural(cell.days_overdue, 'day')} overdue${cell.due ? ` (due ${fmtDate(cell.due)})` : ''}`;
  if (cell.expires) return `${cell.color === 'red' ? 'Expired' : 'Valid until'} ${fmtDate(cell.expires)}`;
  if (cell.due) return `Due ${fmtDate(cell.due)}`;
  return '';
}

export default function MyCompliance({ me }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); api.kbCompliance({ scope: 'me' }).then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const person = data?.people?.[0];
  const rows = person ? (data.columns || [])
    .filter((c) => person.cells[c.key])
    .map((c) => ({ ...c, cell: person.cells[c.key] }))
    .sort((a, b) => ORDER[a.cell.color] - ORDER[b.cell.color] || a.title.localeCompare(b.title)) : [];

  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && (
        <>
          {/* No stat tiles in Training (house rule, 11/07/2026): a titled list with its figures in one plain line. */}
          <section className="kb-shelf">
            <div className="kb-shelf-head">
              <h3 className="kb-shelf-title">My Requirements</h3>
              <span className="kb-meta">{standing(data.stats, rows.length)}</span>
            </div>
            <div className="kb-shelf-body">
              {rows.length === 0 && <div className="kb-empty-state"><div className="kb-empty-title">Nothing Required Right Now</div><div className="kb-meta">Assigned courses and policies to sign show up here.</div></div>}
              {rows.map((r) => {
                const open = () => goKb(r.kind === 'course' ? 'course' : 'page', r.id);
                return (
                  <div key={r.key} className="kb-todo" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
                    <span className={`kb-todo-kind${r.kind === 'course' ? '' : ' policy'}`}>{r.kind === 'course' ? 'Course' : 'Policy'}</span>
                    <div className="kb-todo-text"><div className="kb-prow-title">{r.title}</div><div className="kb-meta">{whenText(r.cell)}</div></div>
                    <span className="kb-state" style={{ color: CELL_COLORS[r.cell.color] }}>{r.cell.status}</span>
                    <span />
                  </div>
                );
              })}
            </div>
          </section>
          <div className="kb-meta">
            Green: done and current. Amber: in progress, not started, or due within 14 days. Red: overdue or expired.
            {me?.can_manage && <> Your team&apos;s compliance is under <a href="#manage-compliance" onClick={(e) => { e.preventDefault(); goKb('compliance'); }}>Manage &gt; Compliance</a>.</>}
          </div>
        </>
      )}
    </AsyncSection>
  );
}
