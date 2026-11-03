// The optional Job on a purchase request or a reimbursement (Neil, 11/03/2026,
// Construction plan phase 4: spend tagged at the source). Lists the live
// construction jobs the person may read - the company wall and the job's own
// crew and manager lists (/construction/spend-jobs) - their own jobs first.
// Nothing renders for someone who can read no job. The job's Money tab lists
// what was tagged as "Requested, Not Yet Billed"; nothing is keyed into the
// books from here.
import { useEffect, useState } from 'react';
import { api } from '../api';

export default function JobTagSelect({ id = 'job-tag', value = '', onChange, label = 'Job', labelStyle, style, hint = '' }) {
  const [jobs, setJobs] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getSpendJobs?.())
      .then((r) => { if (live) setJobs(r?.jobs || []); })
      .catch(() => { if (live) setJobs([]); });
    return () => { live = false; };
  }, []);
  if (!jobs || (!jobs.length && !value)) return null;
  const known = !value || jobs.some((j) => j.id === value);
  return (
    <div data-job-tag="">
      <label style={labelStyle} htmlFor={id}>{label}</label>
      <select id={id} className="form-select" style={style} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No Job</option>
        {!known && <option value={value}>Linked Job</option>}
        {jobs.map((j) => <option key={j.id} value={j.id}>{j.code ? `${j.name} (${j.code})` : j.name}</option>)}
      </select>
      {hint && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>{hint}</p>}
    </div>
  );
}
