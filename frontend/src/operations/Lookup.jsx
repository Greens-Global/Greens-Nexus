// Find a unit or a tenant across every facility without opening Cubby: is it
// rented, to whom, paid through when, what is owed, is the lock on.
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { money } from './model';

const STATUS = {
  rented: ['status-approved', 'Rented'],
  vacant: ['status-pending', 'Vacant'],
  'off-market': ['pill-muted', 'Off Market'],
};

function Result({ r }) {
  const [cls, label] = STATUS[r.status] || STATUS['off-market'];
  const facts = r.status === 'rented'
    ? [['Rent', money(r.rent)], ['Paid Through', formatDate(r.paidThrough, '-')],
       ['Balance Due', money(r.balance, { exact: true })], ['Autopay', r.autoPay ? 'On' : 'Off'],
       ['Overlocked', r.overlocked ? 'Yes' : 'No'], ['Moved In', formatDate(r.moveIn, '-')]]
    : [['Street Rate', money(r.street)], ['Overlocked', r.overlocked ? 'Yes' : 'No']];
  return (
    <li className="ops-hit">
      <div className="ops-hit-head">
        <span className="ops-hit-unit">{r.unit}</span>
        <span className={`status-badge ${cls}`}>{label}</span>
        <span className="ops-hit-where">{r.facility} - {r.type}</span>
        {r.url && (
          <a className="ops-link" href={r.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto' }}>
            {r.tenant} <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
      <dl className="ops-hit-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </li>
  );
}

export default function Lookup() {
  const [q, setQ] = useState('');
  const [state, setState] = useState({ status: 'idle', results: [] });
  const latest = useRef(0);
  const term = q.trim();

  useEffect(() => {
    if (term.length < 2) return undefined;
    const mine = ++latest.current;
    // Wait for a pause in typing, and ignore an answer a newer question has overtaken.
    const t = setTimeout(async () => {
      try {
        const out = await api.facilityOpsLookup(term);
        if (mine === latest.current) setState({ status: 'ready', results: out.results || [] });
      } catch (err) {
        console.error('Operations lookup failed', err);
        if (mine === latest.current) setState({ status: 'error', results: [] });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  const open = term.length >= 2;
  return (
    <div className="ops-lookup">
      <label className="ops-search ops-lookup-box">
        <Search size={15} aria-hidden="true" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Find a unit or tenant" aria-label="Find a unit or tenant across every facility" />
        {q && <button type="button" className="ops-x" onClick={() => setQ('')} aria-label="Clear search"><X size={14} aria-hidden="true" /></button>}
      </label>
      {open && (
        <div className="dash-card ops-lookup-panel" role="region" aria-label="Search results" aria-live="polite">
          {state.status === 'error' && <div className="ops-empty">The search could not be run. Try again.</div>}
          {state.status === 'idle' && <div className="ops-empty">Searching...</div>}
          {state.status === 'ready' && !state.results.length && <div className="ops-empty">No unit or tenant matches "{term}".</div>}
          {state.status === 'ready' && state.results.length > 0 && (
            <ul className="ops-hits">{state.results.map((r) => <Result key={`${r.facilityId}-${r.unit}`} r={r} />)}</ul>
          )}
        </div>
      )}
    </div>
  );
}
