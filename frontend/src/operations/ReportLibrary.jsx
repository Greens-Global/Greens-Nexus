// Operations > Reports Center (Oct 20 "much better than Cubby"; Reports
// Center, Oct 28 2026 call with Neil). Three parts, one page:
//   Monthly Required  - the reports pinned at the top (B12): Management
//                       Summary, Accounts Receivable, Credits Issued,
//                       Exceptions (Coming Soon until its rules are set) and
//                       Occupancy Statistics until the person pins or unpins
//   Memorized Reports - reports saved with their filters and columns, rerun in
//                       one click (B11)
//   All Reports       - search (Ctrl+F or /), a category dropdown, favorites
//                       first, the last few opened; per report open, export,
//                       schedule or pin
// Sections are titled lists with hairline rows - no cards per section, no
// pills (Neil, 11/17/2026).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CalendarClock, Download, Pencil, Pin, Search, Star } from 'lucide-react';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { dialog } from '../ui/dialog';
import { formatDate } from '../lib/datetime';
import { filterWords } from './columnControls';
import { periodName } from './reportPeriod';
import { EXCEPTIONS } from './opsPrefs';

export const SOURCE = {
  cubby: ['Cubby Report', 'pill-info', "Cubby's own report, read from Cubby."],
  nexus: ['Built From Cubby Data', 'pill-ok', 'Built in Nexus from the synced Cubby data.'],
  unavailable: ['Not Available', 'pill-warn', 'Cubby does not share this data yet.'],
};

// The source in words, quietly (no pill - Neil, 11/17/2026).
export function SourceBadge({ source }) {
  const [label, , about] = SOURCE[source] || SOURCE.nexus;
  return <span className="ops-source" data-source={source} title={about}>{label}</span>;
}

const EXCEPTIONS_ROW = {
  key: EXCEPTIONS, title: 'Exceptions', soon: true,
  about: 'Non-standard actions and overrides from Cubby - credits over a set amount, write-offs, deleted units. Coming once the exception rules and thresholds are set.',
};

// "Rent Roll - 3 facilities - This Month - 2 columns added - filtered by Status Rented"
function memorizedWords(m, meta) {
  const parts = [meta?.title || 'Report'];
  const ids = m.choices?.facilityIds;
  parts.push(Array.isArray(ids) && ids.length ? `${ids.length} ${ids.length === 1 ? 'facility' : 'facilities'}` : 'Every facility');
  if (meta?.period && m.choices?.period?.mode) parts.push(periodName(m.choices.period));
  const s = m.shape || {};
  if (s.add?.length) parts.push(`${s.add.length} ${s.add.length === 1 ? 'column' : 'columns'} added`);
  if (s.hidden?.length) parts.push(`${s.hidden.length} hidden`);
  const f = Object.entries(s.filters || {});
  if (f.length) parts.push(`filtered by ${f.map(([k, v]) => filterWords({ key: k, label: k.replace(/^p_/, ''), type: 'text' }, v)).join(', ')}`);
  return parts.join(' - ');
}

function MoveButtons({ label, onMove, first, last }) {
  return (
    <>
      <button type="button" className="ops-icon-btn" aria-label={`Move ${label} up`} disabled={first} onClick={() => onMove(-1)}><ArrowUp size={14} /></button>
      <button type="button" className="ops-icon-btn" aria-label={`Move ${label} down`} disabled={last} onClick={() => onMove(1)}><ArrowDown size={14} /></button>
    </>
  );
}

export default function ReportLibrary({ reports, categories, favorites, recent, onFavorite, onOpen, onDownload, onSchedule, canSchedule, center, onOpenMemorized }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [desc, setDesc] = useState(false);
  const search = useRef(null);
  const pinned = center?.pinned || [];
  const memorized = center?.memorized || [];
  const byKey = (k) => reports.find((r) => r.key === k);

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

  // A pin is a report key, `m:<memorized id>`, or Exceptions.
  const pinRows = pinned.map((k) => {
    if (k === EXCEPTIONS) return { pin: k, ...EXCEPTIONS_ROW };
    if (k.startsWith('m:')) {
      const m = memorized.find((x) => `m:${x.id}` === k);
      return m ? { pin: k, key: m.report, title: m.name, about: memorizedWords(m, byKey(m.report)), memorized: m } : null;
    }
    const r = byKey(k);
    return r ? { pin: k, ...r } : null;
  }).filter(Boolean);

  const recentReports = recent.map((k) => byKey(k)).filter(Boolean);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const rename = async (m) => {
    const name = await dialog.prompt('Rename this memorized report.', { title: 'Rename', defaultValue: m.name, required: true, confirmText: 'Rename' });
    if (name) center.update(m.id, { name: name.trim().slice(0, 80) });
  };

  return (
    <div className="dash-card ops-center">
      <section className="ops-rc" aria-labelledby="ops-rc-monthly">
        <div className="ops-rc-head">
          <h2 id="ops-rc-monthly" className="ops-rc-title">Monthly Required</h2>
          <span className="ops-rc-hint">Pin any report or memorized report with its pin to keep it here.</span>
        </div>
        {!pinRows.length ? <p className="ops-rc-empty">Nothing is pinned. Pin a report below to keep it at the top.</p> : (
          <ul className="ops-rc-list">
            {pinRows.map((r, i) => (
              <li key={r.pin} className="ops-rc-row">
                <div className="ops-rc-main">
                  {r.soon ? <span className="ops-rc-name is-soon">{r.title}</span> : (
                    <button type="button" className="ops-rc-name" onClick={() => (r.memorized ? onOpenMemorized(r.memorized) : onOpen(r.key))}>{r.title}</button>
                  )}
                  {r.soon && <span className="ops-rc-soon">Coming Soon</span>}
                  <div className="ops-rc-about">{r.about}</div>
                </div>
                <div className="ops-rc-acts">
                  {!r.soon && <button type="button" className="secondary-btn ops-btn-sm" onClick={() => (r.memorized ? onOpenMemorized(r.memorized) : onOpen(r.key))}>Open</button>}
                  <MoveButtons label={r.title} first={i === 0} last={i === pinRows.length - 1} onMove={(by) => center.movePin(r.pin, by)} />
                  <button type="button" className="ops-icon-btn" data-on="true" aria-label={`Unpin ${r.title}`} title="Unpin" onClick={() => center.togglePin(r.pin)}>
                    <Pin size={14} fill="currentColor" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!pinned.includes(EXCEPTIONS) && (
          <button type="button" className="ops-linkbtn" style={{ marginTop: 6 }} onClick={() => center.togglePin(EXCEPTIONS)}>Pin Exceptions (Coming Soon)</button>
        )}
      </section>

      <section className="ops-rc" aria-labelledby="ops-rc-memorized">
        <div className="ops-rc-head">
          <h2 id="ops-rc-memorized" className="ops-rc-title">Memorized Reports</h2>
          <span className="ops-rc-hint">Open a report, set it up, then Memorize - it reruns with the same settings and columns.</span>
        </div>
        {!memorized.length ? <p className="ops-rc-empty">No memorized reports yet.</p> : (
          <ul className="ops-rc-list">
            {memorized.map((m) => {
              const meta = byKey(m.report);
              const pin = `m:${m.id}`;
              const on = pinned.includes(pin);
              return (
                <li key={m.id} className="ops-rc-row">
                  <div className="ops-rc-main">
                    <button type="button" className="ops-rc-name" onClick={() => onOpenMemorized(m)} disabled={!meta}>{m.name}</button>
                    <div className="ops-rc-about">{meta ? memorizedWords(m, meta) : 'This report is no longer in the list.'} - saved {formatDate(m.savedAt)}</div>
                  </div>
                  <div className="ops-rc-acts">
                    <button type="button" className="secondary-btn ops-btn-sm" onClick={() => onOpenMemorized(m)} disabled={!meta}>Open</button>
                    <button type="button" className="ops-icon-btn" aria-label={`Rename ${m.name}`} title="Rename" onClick={() => rename(m)}><Pencil size={14} /></button>
                    <button type="button" className="ops-icon-btn" data-on={on} aria-pressed={on} aria-label={on ? `Unpin ${m.name}` : `Pin ${m.name} to Monthly Required`}
                      title={on ? 'Unpin' : 'Pin to Monthly Required'} onClick={() => center.togglePin(pin)}>
                      <Pin size={14} fill={on ? 'currentColor' : 'none'} />
                    </button>
                    <HoldButton label="Delete" size="sm" holdMs={HOLD_RECORD_MS} ariaLabel={`Delete ${m.name}`}
                      onConfirm={() => center.forget(m.id)} doneLabel="Deleted" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="ops-rc" aria-labelledby="ops-rc-all">
        <div className="ops-rc-head">
          <h2 id="ops-rc-all" className="ops-rc-title">All Reports</h2>
        </div>
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
          <div className="req-table-wrapper ops-scroll">
            <table className="req-table ops-lib ops-sticky">
              <thead>
                <tr>
                  <th style={{ width: 34 }}><span className="sr-only">Favorite</span></th>
                  <th aria-sort={desc ? 'descending' : 'ascending'} style={{ width: '26%' }}>
                    <button type="button" className="ops-sort" onClick={() => setDesc((d) => !d)}>
                      Name {desc ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />}
                    </button>
                  </th>
                  <th>Description</th>
                  <th style={{ width: 160 }}>Source</th>
                  <th style={{ width: 180 }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const fav = favorites.includes(r.key);
                  const pin = pinned.includes(r.key);
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
                        <button type="button" className="ops-icon-btn" data-on={pin} aria-pressed={pin}
                          aria-label={pin ? `Unpin ${r.title}` : `Pin ${r.title} to Monthly Required`} title={pin ? 'Unpin' : 'Pin to Monthly Required'}
                          onClick={stop(() => center?.togglePin(r.key))}><Pin size={15} fill={pin ? 'currentColor' : 'none'} /></button>
                        <button type="button" className="ops-icon-btn" disabled={off} aria-label={`Export ${r.title}`} title={off ? 'Not available from Cubby yet' : 'Export'}
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
        <p className="ops-note" style={{ marginTop: 10 }}>Press / or Ctrl+F to search. Star a report to keep it at the top of this list; pin it to keep it under Monthly Required.</p>
      </section>
    </div>
  );
}
