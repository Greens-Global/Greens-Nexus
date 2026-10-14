import { CornerDownLeft } from 'lucide-react';
import { Spinner } from '../AsyncState';

// The one results list for Nexus search - the header panel and the phone
// sheet render exactly this. Rows are flat for keyboard travel (activeIdx
// counts across groups); a group's "more" line is informational unless it
// has a run.
export default function SearchResults({ query, groups, rows, searching, activeIdx, onActive, onPick, listRef }) {
  const q = (query || '').trim();
  if (!q) return null;
  if (!rows.length) {
    return (
      <div className="gs-empty">
        {searching ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spinner size={14} /> Searching…</span>
        ) : <>No results for “{q}”</>}
      </div>
    );
  }
  // Each group's first row index in the flat list (pure: no counter mutated
  // during render).
  const offsets = groups.reduce((acc, g, k) => { acc.push(k ? acc[k - 1] + groups[k - 1].rows.length : 0); return acc; }, []);
  return (
    <div className="gs-results" ref={listRef}>
      {groups.map((g, k) => (
        <div key={g.key}>
          <div className="gs-section">{g.label}</div>
          {g.rows.map((r, j) => {
            const i = offsets[k] + j;
            return (
              <button key={r.key} className="gs-row" data-active={i === activeIdx}
                onMouseEnter={() => onActive?.(i)} onClick={() => onPick(r)}>
                <r.Icon size={15} style={{ color: r.done ? 'var(--ok, #16a34a)' : 'var(--muted)', flexShrink: 0 }} />
                <span className="gs-row-title" style={r.done ? { textDecoration: 'line-through' } : undefined}>{r.title}</span>
                {r.tag && <span className="gs-row-tag">{r.tag}</span>}
                {r.detail && <span className="gs-row-detail">{r.detail}</span>}
                {i === activeIdx && <CornerDownLeft size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
              </button>
            );
          })}
          {g.more && (g.more.run
            ? <button className="gs-row gs-more" onClick={() => onPick(g.more)}>{g.more.label}</button>
            : <div className="gs-more">{g.more.label}</div>)}
        </div>
      ))}
      {searching && <div className="gs-more" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Spinner size={12} /> Searching…</div>}
    </div>
  );
}
