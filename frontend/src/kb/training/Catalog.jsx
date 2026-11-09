// Training > Catalog (Neil, 11/07/2026: "missing role based paths and
// departmental trainings"): every path and course a person may take, in one
// place, as a catalog - not a grid of cards. The paths for your role and
// department lead, each with its ladder; then the other paths by kind; then
// the courses shelved by department, each shelf a list. One search box and
// one row of filters; everything filters on the client from GET /kb/catalog.
import { useEffect, useMemo, useState } from 'react';
import { Search, GraduationCap, Compass, Plus } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { errText } from '../components/Toast';
import { goKb, plural, PATH_KINDS, LEVELS } from '../lib';
import { CatalogCourseRow, PathRow } from './cards';
import { filterCourses, filterPaths, pathsForMe, shelveCourses, pathOrder, GENERAL } from './catalogModel';

const SHOW = [['all', 'Everything'], ['todo', 'Assigned to Me'], ['not_started', 'Not Started'], ['done', 'Completed']];
const KIND_TITLES = { onboarding: 'Onboarding', role: 'Paths by Role', department: 'Department Training', custom: 'More Paths' };


function Shelf({ title, sub, count, children }) {
  return (
    <section className="kb-shelf">
      <div className="kb-shelf-head">
        <h3 className="kb-shelf-title">{title}</h3>
        {sub && <span className="kb-meta">{sub}</span>}
        {count != null && <span className="kb-meta kb-shelf-count">{count}</span>}
      </div>
      <div className="kb-shelf-body">{children}</div>
    </section>
  );
}

export default function Catalog({ me, initialQuery = '' }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState(initialQuery);
  // One filter row (11/08/2026): the search, Show as a segment, and ONE select for a department or a level.
  const [narrow, setNarrow] = useState('');   // '' | 'd:<department>' | 'l:<level>'
  const [show, setShow] = useState('all');
  const dept = narrow.startsWith('d:') ? narrow.slice(2) : '';
  const level = narrow.startsWith('l:') ? narrow.slice(2) : '';
  const load = () => { setErr(''); api.kbCatalog().then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []);

  const courses = useMemo(() => filterCourses(data?.courses, { q, department: dept, level, show }), [data, q, dept, level, show]);
  const paths = useMemo(() => filterPaths(data?.paths, { q }), [data, q]);
  const shelves = useMemo(() => shelveCourses(courses, data?.me?.department, pathOrder(data?.paths)), [courses, data]);
  const filtering = !!(q || narrow || show !== 'all');
  const pathsShown = !dept && !level && show === 'all';
  const forMe = pathsShown ? pathsForMe(paths) : [];
  const byKind = pathsShown ? Object.keys(PATH_KINDS).map((k) => ({ kind: k, paths: paths.filter((p) => p.kind === k && !forMe.includes(p)) })).filter((g) => g.paths.length) : [];
  // the shelves the courses actually fill (a path's audience is not a shelf)
  const depts = [...new Set((data?.courses || []).flatMap((c) => (c.department_list?.length ? [c.department_list[0]] : [GENERAL])))].sort((a, b) => (a === GENERAL) - (b === GENERAL) || a.localeCompare(b));
  const nothing = data && !forMe.length && !byKind.length && !shelves.length;

  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && (
        <div className="kb-page kb-catalog">
          <div className="kb-catalog-top">
            <div className="kb-big" style={{ padding: '8px 14px', borderRadius: 10 }}>
              <Search />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search courses and paths" aria-label="Search the catalog" />
              {q && <button type="button" className="kb-btn sm ghost" onClick={() => setQ('')}>Clear</button>}
            </div>
            <div className="kb-filters">
              <div className="kb-seg" role="group" aria-label="Show">
                {SHOW.map(([v, l]) => <button key={v} type="button" aria-pressed={show === v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>{l}</button>)}
              </div>
              <select className="kb-select kb-filter-one" value={narrow} onChange={(e) => setNarrow(e.target.value)} aria-label="Department or level">
                <option value="">Every Department and Level</option>
                {depts.length > 1 && <optgroup label="Department">{depts.map((d) => <option key={d} value={`d:${d}`}>{d === GENERAL ? 'For Everyone' : d}</option>)}</optgroup>}
                <optgroup label="Level">{Object.values(LEVELS).map((l) => <option key={l.key} value={`l:${l.key}`}>{l.label}</option>)}</optgroup>
              </select>
            </div>
            {me?.can_author && <span className="kb-catalog-actions"><button type="button" className="kb-btn" onClick={() => goKb('plans')}>Learning Paths</button><button type="button" className="kb-btn pri" onClick={() => goKb('builder', 'new')}><Plus />New Course</button></span>}
          </div>

          {forMe.length > 0 && (
            <Shelf title="For You" sub={[data.me.job_title, data.me.department].filter(Boolean).join(' · ') || 'the paths you are on and the ones for your role'}>
              {forMe.map((p) => <PathRow key={p.id} p={p} />)}
            </Shelf>
          )}
          {byKind.map((g) => (
            <Shelf key={g.kind} title={KIND_TITLES[g.kind]} sub={PATH_KINDS[g.kind].blurb} count={plural(g.paths.length, 'path')}>
              {g.paths.map((p) => <PathRow key={p.id} p={p} />)}
            </Shelf>
          ))}
          {shelves.map((s) => (
            <Shelf key={s.name} title={s.name === GENERAL ? 'For Everyone' : s.name} sub={s.name === GENERAL ? 'courses with no department of their own' : ''} count={plural(s.courses.length, 'course')}>
              {s.courses.map((c) => <CatalogCourseRow key={c.id} c={c} />)}
            </Shelf>
          ))}
          {nothing && !filtering && (
            <div className="kb-empty-state"><GraduationCap size={26} /><div className="kb-empty-title">Nothing Is Published Yet</div><div className="kb-meta">Courses and paths show up here as soon as an author publishes them.</div></div>
          )}
          {nothing && filtering && (
            <div className="kb-empty-state"><Compass size={24} /><div className="kb-empty-title">Nothing Matches</div><div className="kb-meta">Try another word, or clear the filters.</div><button type="button" className="kb-btn sm" style={{ marginTop: 10 }} onClick={() => { setQ(''); setNarrow(''); setShow('all'); }}>Clear Filters</button></div>
          )}
        </div>
      )}
    </AsyncSection>
  );
}
