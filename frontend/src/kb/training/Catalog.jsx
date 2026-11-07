// Training > Catalog (Neil, 11/07/2026: "missing role based paths and
// departmental trainings"): every path and course a person may take, in one
// place. Paths for your role and department lead, then onboarding, role and
// department paths, then the courses shelved by department. One search box,
// chips for department, level and state; everything filters on the client
// from GET /kb/catalog.
import { useEffect, useMemo, useState } from 'react';
import { Search, GraduationCap, Compass, Plus } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { SectionHead } from '../components/Chips';
import { errText } from '../components/Toast';
import { goKb, plural, PATH_KINDS, LEVELS } from '../lib';
import { CourseTile, PathTile, KIND_ICONS } from './cards';
import { filterCourses, filterPaths, pathsForMe, shelveCourses, GENERAL } from './catalogModel';

const SHOW = [['all', 'Everything'], ['todo', 'Assigned to Me'], ['not_started', 'Not Started'], ['done', 'Completed']];

function Pills({ value, onChange, options, label }) {
  return (
    <div className="kb-pills" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={`kb-pill${value === v ? ' on' : ''}`} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export default function Catalog({ me, initialQuery = '' }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState(initialQuery);
  const [dept, setDept] = useState('');
  const [level, setLevel] = useState('');
  const [show, setShow] = useState('all');
  const load = () => { setErr(''); api.kbCatalog().then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []);

  const filters = { q, department: dept, level, show };
  const courses = useMemo(() => filterCourses(data?.courses, filters), [data, q, dept, level, show]); // eslint-disable-line react-hooks/exhaustive-deps
  const paths = useMemo(() => filterPaths(data?.paths, { q }), [data, q]);
  const shelves = useMemo(() => shelveCourses(courses, data?.me?.department), [courses, data]);
  const filtering = !!(q || dept || level || show !== 'all');
  const forMe = pathsForMe(paths);
  const byKind = Object.keys(PATH_KINDS).map((k) => ({ kind: k, paths: paths.filter((p) => p.kind === k && !(forMe.includes(p) && !filtering)) })).filter((g) => g.paths.length);
  // the shelves the courses actually fill (a path's audience is not a shelf)
  const depts = [...new Set((data?.courses || []).flatMap((c) => (c.department_list?.length ? [c.department_list[0]] : [GENERAL])))].sort((a, b) => (a === GENERAL) - (b === GENERAL) || a.localeCompare(b));

  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && (
        <div className="kb-page">
          <div className="kb-home-top">
            <div className="kb-big" style={{ padding: '8px 14px', borderRadius: 12 }}>
              <Search />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search courses and paths" aria-label="Search the catalog" />
              {q && <button type="button" className="kb-btn sm ghost" onClick={() => setQ('')}>Clear</button>}
            </div>
            {me?.can_author && <button type="button" className="kb-btn" onClick={() => goKb('plans')}><Plus />New Path</button>}
            {me?.can_author && <button type="button" className="kb-btn pri" onClick={() => goKb('builder', 'new')}><Plus />New Course</button>}
          </div>
          <div className="kb-filters">
            {depts.length > 1 && <Pills label="Department" value={dept} onChange={setDept} options={[['', 'All Departments'], ...depts.map((d) => [d, d])]} />}
            <Pills label="Level" value={level} onChange={setLevel} options={[['', 'Any Level'], ...Object.values(LEVELS).map((l) => [l.key, l.label])]} />
            <Pills label="Show" value={show} onChange={setShow} options={SHOW} />
          </div>

          {!filtering && forMe.length > 0 && (
            <section>
              <SectionHead title="For You" sub={[data.me.job_title, data.me.department].filter(Boolean).join(' · ') || 'the paths you are on and the ones for your role'} />
              <div className="kb-tiles">{forMe.map((p) => <PathTile key={p.id} p={p} />)}</div>
            </section>
          )}
          {!filtering && !forMe.length && !data.paths.length && !data.courses.length && (
            <div className="kb-card soft kb-empty"><GraduationCap size={26} /><div style={{ marginTop: 6 }}>Nothing is published yet. Courses and paths show up here as soon as an author publishes them.</div></div>
          )}
          {!level && show === 'all' && !dept && byKind.map((g) => {
            const m = PATH_KINDS[g.kind];
            const Icon = KIND_ICONS[g.kind];
            return (
              <section key={g.kind}>
                <SectionHead title={g.kind === 'role' ? 'Paths by Role' : g.kind === 'department' ? 'Department Training' : g.kind === 'onboarding' ? 'Onboarding' : 'More Paths'} sub={m.blurb} right={<span className="kb-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon size={14} />{plural(g.paths.length, 'path')}</span>} />
                <div className="kb-tiles">{g.paths.map((p) => <PathTile key={p.id} p={p} />)}</div>
              </section>
            );
          })}
          {shelves.map((s) => (
            <section key={s.name}>
              <SectionHead title={s.name === GENERAL ? 'For Everyone' : `${s.name}`} sub={s.name === GENERAL ? 'courses with no department of their own' : plural(s.courses.length, 'course')} />
              <div className="kb-tiles">{s.courses.map((c) => <CourseTile key={c.id} c={c} />)}</div>
            </section>
          ))}
          {filtering && !shelves.length && !paths.length && (
            <div className="kb-card soft kb-empty"><Compass size={24} /><div style={{ marginTop: 6 }}>Nothing matches. Try another word, or clear the filters.</div><button type="button" className="kb-btn sm" style={{ marginTop: 10 }} onClick={() => { setQ(''); setDept(''); setLevel(''); setShow('all'); }}>Clear Filters</button></div>
          )}
          {filtering && paths.length > 0 && !dept && (level || show !== 'all') && (
            <section>
              <SectionHead title="Paths" sub="paths that match your search" />
              <div className="kb-tiles">{paths.map((p) => <PathTile key={p.id} p={p} compact />)}</div>
            </section>
          )}
        </div>
      )}
    </AsyncSection>
  );
}
