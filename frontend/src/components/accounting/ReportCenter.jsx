import { useEffect, useMemo, useRef, useState } from 'react';
import { FileStack, Hammer, Search, Users } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useNameResolver } from '../../lib/useNameResolver';
import { BarSearchSlot, control } from './reportControls';
import { catalogue, standardEntries } from './reportCatalog';
import { parkSavedReport } from './drill';
import { StatusLabel } from '../StatusLabel';

// Accounting -> Reports -> Report Center (Neil, 10/22 call, item 05: "All
// Reports doesn't actually bring up anything different ... change all reports
// to report center" - a better way to reach every report and see what is
// memorized and what is not, with Packages and the new Report Builder in it).
//
// One list of every report this person can open, grouped the way the Reports
// menu groups them: each standard report and screen (from the menu itself,
// already narrowed to what the person may open), the statements the menu does
// not name (the plain Income Statement), every memorized
// report they can see (theirs and the team's) marked Memorized under its
// statement's group, and every Report Builder report marked Saved (a draft)
// or Published. Sharing says who sees it: only the owner, or everyone with
// Accounting (Share With Everyone - CR-05, Neil, 23 Oct: published reports
// "are not shared by default"). One click opens any of them.
//
// A person limited to certain entities sees a memorized report only when
// every entity it names is one of theirs - anything else would open empty.

// The mark a memorized or Report Builder report carries; a standard report carries none.
const TYPES = {
  memorized: { label: 'Memorized', color: '#2563eb' },
  saved: { label: 'Saved', color: '#64748b' },
  published: { label: 'Published', color: '#16a34a' },
};
const FILTERS = [{ key: 'all', label: 'All Reports' }, { key: 'standard', label: 'Standard' }, { key: 'memorized', label: 'Memorized and Saved' }];

export default function ReportCenter({ groups = [], limited = false, onOpen }) {
  const nameOf = useNameResolver();
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState('');
  const [entities, setEntities] = useState([]);
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  // Ctrl+F finds a report here, not in the ledger: the screen's own find
  // comes first (ModuleSearch takes the key only when no screen did).
  const filterBox = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (!((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'f')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      filterBox.current?.focus();
      filterBox.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    let alive = true;
    api.getAccountingSavedReports()
      .then((list) => { if (alive) setSaved(list || []); })
      .catch((e) => { if (alive) { setSaved([]); setError(e?.message || 'Could not load the memorized reports.'); } });
    api.getAccountingLocations().then((d) => { if (alive) setEntities(d?.entities || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => catalogue(groups, saved || [], { entities, limited }), [groups, saved, entities, limited]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => (show === 'all' || (show === 'standard' ? r.type === 'standard' : r.type !== 'standard'))
      && (!s || [r.label, r.group, r.about, r.saved ? nameOf(r.saved.owner) || r.saved.owner : ''].some((v) => String(v || '').toLowerCase().includes(s))));
  }, [rows, q, show, nameOf]);
  const byGroup = useMemo(() => {
    const m = new Map();
    shown.forEach((r) => { if (!m.has(r.groupKey)) m.set(r.groupKey, { label: r.group, rows: [] }); m.get(r.groupKey).rows.push(r); });
    return [...m.entries()];
  }, [shown]);
  const counts = { standard: rows.filter((r) => r.type === 'standard').length, memorized: rows.filter((r) => r.type !== 'standard').length };

  const open = (r) => {
    if (r.saved) parkSavedReport(r.saved, r.type === 'saved' || r.type === 'published');
    onOpen?.(r.key);
  };
  const leafKeys = new Set(standardEntries(groups).map((e) => e.key));
  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 420 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
          <input ref={filterBox} type="text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search reports" placeholder="Find a report by name, group or owner (Ctrl+F)"
            style={{ ...control, width: '100%', paddingLeft: 28 }} />
        </div>
        <div role="group" aria-label="Show" style={{ display: 'inline-flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={show === f.key} onClick={() => setShow(f.key)}
              style={{ border: 'none', padding: '0 10px', height: 28, font: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: show === f.key ? 600 : 400,
                background: show === f.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: show === f.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)' }}>
              {f.label}{f.key === 'standard' ? ` (${counts.standard})` : f.key === 'memorized' && saved ? ` (${counts.memorized})` : ''}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {leafKeys.has('packages') && (
            <button type="button" className="secondary-btn" onClick={() => onOpen?.('packages')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, height: 30, padding: '0 12px' }}>
              <FileStack size={14} /> Packages
            </button>
          )}
          {leafKeys.has('report-builder') && (
            <button type="button" className="primary-btn" onClick={() => onOpen?.('report-builder')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, height: 30, padding: '0 12px' }}>
              <Hammer size={14} /> New Report
            </button>
          )}
          <BarSearchSlot />
        </div>
      </div>

      {error && <div role="alert" style={{ ...card, padding: 12, color: 'var(--bad-fg, #dc2626)', borderColor: 'var(--bad-fg, #dc2626)', fontSize: 13 }}>{error}</div>}
      {saved === null && <div style={{ ...card, padding: 12 }}><SkeletonBlocks count={4} /></div>}

      {saved !== null && byGroup.map(([key, g]) => {
        // Owner, Sharing and Updated only where a group holds a memorized or Report Builder report.
        const own = g.rows.some((r) => r.saved);
        return (
        <section key={key} aria-label={g.label} style={{ ...card, padding: 10 }}>
          <h3 style={{ fontSize: 15, margin: '0 2px 8px' }}>{g.label}</h3>
          <div className="acct-lines-wrap">
            <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
              <thead>
                <tr><th scope="col">Report</th><th scope="col">Details</th>{own && <><th scope="col">Type</th><th scope="col">Owner</th><th scope="col">Sharing</th><th scope="col">Updated</th></>}</tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={`${r.type}-${r.id}`}>
                    <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                      <button type="button" className="acct-drill" onClick={() => open(r)} title="Open this report">{r.label}</button>
                    </td>
                    <td style={{ color: 'var(--text-secondary)', whiteSpace: 'normal' }}>{r.about || ''}</td>
                    {own && (
                      <>
                        <td>{TYPES[r.type] ? <StatusLabel size="sm" color={TYPES[r.type].color} label={TYPES[r.type].label} /> : ''}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{r.saved ? (r.saved.mine ? 'You' : nameOf(r.saved.owner) || r.saved.owner) : ''}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>
                          {r.saved ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Users size={12} /> {r.saved.shared ? 'Everyone' : 'Only the owner'}</span> : ''}
                        </td>
                        <td style={{ color: 'var(--text-secondary)' }}>{r.saved?.updatedAt ? formatDate(r.saved.updatedAt) : ''}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        );
      })}
      {saved !== null && !byGroup.length && (
        <div style={{ ...card, padding: 22, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>No report matches that search.</div>
      )}
    </div>
  );
}

