// Operations > Reports: the report list (Oct 20, "much better than Cubby").
// Search (Ctrl+F or /), a category dropdown, favorites first, the last few
// opened, and per report: open it on screen, download it, or schedule it.
// A row opens the report. On a phone the table becomes cards.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarClock, Download, Search, Star } from 'lucide-react';

export const SOURCE = {
  cubby: ['Cubby Report', 'pill-info', "Cubby's own report, read from Cubby."],
  nexus: ['Built From Cubby Data', 'pill-ok', 'Built in Nexus from the synced Cubby data.'],
  unavailable: ['Not Available', 'pill-warn', 'Cubby does not share this data yet.'],
};

export function SourceBadge({ source }) {
  const [label, cls, about] = SOURCE[source] || SOURCE.nexus;
  return <span className={`status-badge ${cls}`} title={about}>{label}</span>;
}

export default function ReportLibrary({ reports, categories, favorites, recent, onFavorite, onOpen, onDownload, onSchedule, canSchedule }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [desc, setDesc] = useState(false);
  const search = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
        if (document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = reports.filter((r) => (!cat || r.category === cat)
      && (!needle || `${r.title} ${r.about} ${r.category}`.toLowerCase().includes(needle)));
    const fav = new Set(favorites);
    return hit.sort((a, b) => (fav.has(b.key) - fav.has(a.key)) || (desc ? -1 : 1) * a.title.localeCompare(b.title, 'en-US'));
  }, [reports, q, cat, desc, favorites]);

  const recentReports = recent.map((k) => reports.find((r) => r.key === k)).filter(Boolean);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div className="dash-card">
      <div className="ops-lib-bar">
        <label className="ops-search ops-lib-search">
          <Search size={14} aria-hidden="true" />
          <input ref={search} type="search" value={q} placeholder="Search reports" aria-label="Search Reports" onChange={(e) => setQ(e.target.value)} />
          {!q && <kbd className="ops-kbd" aria-hidden="true">Ctrl+F</kbd>}
        </label>
        <select className="form-input ops-rd-select" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All Categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="ops-lib-count">{shown.length} {shown.length === 1 ? 'report' : 'reports'}</span>
      </div>

      {recentReports.length > 0 && !q && !cat && (
        <div className="ops-lib-recent">
          <span className="ops-lib-recent-h">Recent</span>
          {recentReports.map((r) => (
            <button key={r.key} type="button" className="ops-lib-recent-a" onClick={() => onOpen(r.key)}>{r.title}</button>
          ))}
        </div>
      )}

      {!shown.length ? (
        <div className="ops-empty">No report matches &quot;{q}&quot;{cat ? ` in ${cat}` : ''}.</div>
      ) : (
        <div className="req-table-wrapper">
          <table className="req-table ops-lib">
            <thead>
              <tr>
                <th style={{ width: 34 }}><span className="sr-only">Favorite</span></th>
                <th aria-sort={desc ? 'descending' : 'ascending'} style={{ width: '26%' }}>
                  <button type="button" className="ops-sort" onClick={() => setDesc((d) => !d)}>
                    Name {desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />}
                  </button>
                </th>
                <th>Description</th>
                <th style={{ width: 170 }}>Source</th>
                <th style={{ width: 150 }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const fav = favorites.includes(r.key);
                const off = r.source === 'unavailable';
                return (
                  <tr key={r.key} className="ops-lib-row" onClick={() => onOpen(r.key)}>
                    <td className="ops-lib-star">
                      <button type="button" className="ops-icon-btn" data-on={fav} aria-pressed={fav}
                        aria-label={fav ? `Remove ${r.title} from Favorites` : `Add ${r.title} to Favorites`} onClick={stop(() => onFavorite(r.key))}>
                        <Star size={15} fill={fav ? 'currentColor' : 'none'} />
                      </button>
                    </td>
                    <td className="ops-lib-title">
                      <button type="button" className="ops-lib-name" onClick={stop(() => onOpen(r.key))}>{r.title}</button>
                      <div className="ops-lib-sub">{r.category}{r.period ? '' : ' - As of Today'}</div>
                    </td>
                    <td className="ops-lib-about">{r.about}</td>
                    <td className="ops-lib-src"><SourceBadge source={r.source} /></td>
                    <td className="ops-lib-acts">
                      <button type="button" className="secondary-btn ops-btn-sm" onClick={stop(() => onOpen(r.key))}>Open</button>
                      <button type="button" className="ops-icon-btn" disabled={off} aria-label={`Download ${r.title}`} title={off ? 'Not available from Cubby yet' : 'Download'}
                        onClick={stop(() => onDownload(r.key))}><Download size={15} /></button>
                      <button type="button" className="ops-icon-btn" disabled={off || !canSchedule} aria-label={`Schedule ${r.title}`}
                        title={off ? 'Not available from Cubby yet' : canSchedule ? 'Schedule' : 'Scheduled reports are not switched on yet'}
                        onClick={stop(() => onSchedule(r.key))}><CalendarClock size={15} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="ops-note" style={{ marginTop: 12 }}>Press / or Ctrl+F to search. Star a report to keep it at the top.</p>
    </div>
  );
}
