// Page view reports (WP 5.4, Oct 29 2026): Manage > Health's Reading card.
// Most read, never opened and reading by team over the pages you look after,
// last 30 days. Counts only - never who read what. Backend: GET /kb/reports/reading.
import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api } from '../../api';
import { SectionHead } from '../components/Chips';
import { goKb, fmtDate, plural } from '../lib';

export default function ReadingReport() {
  const [rep, setRep] = useState(null);
  const [allUnread, setAllUnread] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.kbReadingReport(30)).then((r) => { if (live && r && r.totals) setRep(r); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!rep) return null;
  const unread = allUnread ? rep.never_opened : rep.never_opened.slice(0, 5);
  return (
    <section className="kb-card">
      <SectionHead title="Reading" sub={`last ${rep.days} days`} />
      <div className="kb-meta" style={{ marginBottom: 8 }}><BarChart3 size={13} style={{ verticalAlign: 'middle' }} /> {plural(rep.totals.views, 'view')} by {plural(rep.totals.readers, 'person', 'people')} across {plural(rep.totals.pages, 'page')}</div>
      {rep.most_read.length > 0 && <div className="kb-label" style={{ marginTop: 4 }}>Most Read</div>}
      {rep.most_read.slice(0, 5).map((p) => (
        <div key={p.id} className="kb-row" style={{ padding: '6px 0' }}>
          <div className="kb-grow"><a href="#p" className="kb-title" onClick={(e) => { e.preventDefault(); goKb('page', p.id); }}>{p.title}</a>
            <div className="kb-meta">{plural(p.views, 'view')} · {plural(p.readers, 'reader')} · last {fmtDate(p.last_day)}</div></div>
        </div>
      ))}
      {rep.never_opened.length > 0 && (
        <>
          <div className="kb-label" style={{ marginTop: 8 }}>Never Opened ({rep.totals.never_opened})</div>
          {unread.map((p) => (
            <div key={p.id} className="kb-row" style={{ padding: '6px 0' }}>
              <div className="kb-grow"><a href="#p" className="kb-title" onClick={(e) => { e.preventDefault(); goKb('page', p.id); }}>{p.title}</a>
                {p.published_at && <div className="kb-meta">published {fmtDate(p.published_at)}</div>}</div>
            </div>
          ))}
          {rep.never_opened.length > 5 && <button type="button" className="kb-btn sm ghost" onClick={() => setAllUnread((v) => !v)}>{allUnread ? 'Show Fewer' : `Show All ${rep.never_opened.length}`}</button>}
        </>
      )}
      {rep.by_team.length > 0 && (
        <>
          <div className="kb-label" style={{ marginTop: 8 }}>By Team</div>
          {rep.by_team.slice(0, 6).map((t) => (
            <div key={t.department} className="kb-row" style={{ padding: '4px 0' }}>
              <div className="kb-grow" style={{ fontSize: 13.5 }}>{t.department}</div>
              <span className="kb-meta">{plural(t.views, 'view')} · {plural(t.readers, 'reader')}</span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
