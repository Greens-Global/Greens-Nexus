// Training > Compliance (Oct 30 2026): the signed-in person's OWN requirements -
// every assigned course and every policy they must sign, with the same
// green / amber / red rule as the team report (GET /kb/compliance?scope=me).
// The team view stays under Manage > Compliance.
import { useEffect, useState } from 'react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Chip, SectionHead, Stat } from '../components/Chips';
import { errText } from '../components/Toast';
import { goKb, CELL_COLORS, fmtDate, plural } from '../lib';

const ORDER = { red: 0, amber: 1, green: 2 };

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
          <div className="kb-stats">
            <Stat value={`${data.stats.compliant_pct}%`} label="of your requirements met" color={data.stats.compliant_pct >= 90 ? '#1e7b4e' : '#b45309'} />
            <Stat value={data.stats.overdue} label="overdue or expired" color={data.stats.overdue ? '#dc2626' : undefined} />
            <Stat value={data.stats.due_soon} label="due soon or in progress" color={data.stats.due_soon ? '#d97706' : undefined} />
            <Stat value={rows.length} label="requirements" />
          </div>
          <section className="kb-card">
            <SectionHead title="My Requirements" count={rows.length} sub="the courses and policies you are responsible for" />
            {rows.length === 0 && <div className="kb-empty">Nothing is required of you right now. Assigned courses and policies to sign show up here.</div>}
            {rows.map((r) => (
              <div key={r.key} className="kb-row link" onClick={() => goKb(r.kind === 'course' ? 'course' : 'page', r.id)}>
                <Chip color={r.kind === 'course' ? '#1e7b4e' : '#7c3aed'}>{r.kind === 'course' ? 'Course' : 'Policy'}</Chip>
                <div className="kb-grow">
                  <div className="kb-title">{r.title}</div>
                  <div className="kb-meta">{whenText(r.cell)}</div>
                </div>
                <Chip color={CELL_COLORS[r.cell.color]}>{r.cell.status}</Chip>
              </div>
            ))}
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
