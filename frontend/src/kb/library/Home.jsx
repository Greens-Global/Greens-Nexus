// Library home (Neil, 11/02/2026: organized by department): one search row,
// then the departments - one card each with its shelves, page count and
// health - then what waits on you; drafts, pins and recent pages in the rail.
import { useEffect, useRef, useState } from 'react';
import { Search, Sparkles, Plus, FileText, Upload, FolderOpen, ChevronRight } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Chip, SectionHead, Av } from '../components/Chips';
import PageRow from '../components/PageCard';
import RequestPageModal from '../components/RequestPageModal';
import { goKb, fmtDate, colorFor, plural, typeMeta, initials } from '../lib';

const RECENT_KEY = 'kb.recentSearches';
function readRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
export function rememberSearch(q) {
  try {
    const list = [q, ...readRecent().filter((x) => x !== q)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* private window */ }
}

export function SearchBox({ initial = '', autoFocus = false, onSearch, onAsk, large = true }) {
  const [q, setQ] = useState(initial);
  const ref = useRef(null);
  useEffect(() => { setQ(initial); }, [initial]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const submit = (ask) => {
    const v = q.trim();
    if (!v) return;
    rememberSearch(v);
    (ask ? onAsk : onSearch)(v);
  };
  return (
    <div className="kb-big" style={large ? {} : { padding: '8px 12px', borderRadius: 10 }}>
      <Search />
      <input ref={ref} type="search" value={q} onChange={(e) => setQ(e.target.value)} data-slash-search=""
             placeholder="Search how-tos, SOPs, policies and references" aria-label="Search the Knowledge Base"
             onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(e.shiftKey); } }} />
      {large && <span className="kb-meta" style={{ whiteSpace: 'nowrap' }}>Enter to search <span className="kb-kbd">⇧ Enter</span> asks Nexus</span>}
      {!large && <button type="button" className="kb-btn sm" onClick={() => submit(false)}>Search</button>}
      {onAsk && <button type="button" className="kb-btn sm" title="Ask Nexus (Shift+Enter)" onClick={() => submit(true)}><Sparkles />Ask</button>}
    </div>
  );
}

function DepartmentCard({ c, subs }) {
  const shown = subs.slice(0, 3);
  return (
    <button type="button" className="kb-coll kb-dept" onClick={() => goKb('collection', c.id)} aria-label={`${c.name}, ${plural(c.pages, 'page')}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span className="kb-ico" style={{ background: colorFor(c.id) }} aria-hidden="true">{initials(c.name).slice(0, 1)}</span>
        <span className="kb-grow" style={{ minWidth: 0 }}>
          <span className="kb-title kb-ellipsis" style={{ display: 'block', fontSize: 15 }}>{c.name}</span>
          <span className="kb-meta">{c.pages ? plural(c.pages, 'page') : 'No pages yet'}{c.owner_name ? ` · ${c.owner_name}` : ''}</span>
        </span>
        <ChevronRight size={16} style={{ color: 'var(--kb-dim)', flex: '0 0 auto' }} aria-hidden="true" />
      </div>
      {shown.length > 0 && (
        <div className="kb-meta kb-ellipsis" style={{ fontSize: 13 }}>
          {shown.map((x) => x.name).join(' · ')}{subs.length > shown.length ? ` · +${subs.length - shown.length} more` : ''}
        </div>
      )}
      <div>
        {c.stale > 0 ? <Chip color="#dc2626">{c.stale} need review</Chip> : c.pages > 0 ? <Chip color="#1e7b4e">Up to date</Chip> : <Chip color="#64748b">Empty</Chip>}
      </div>
    </button>
  );
}

function NoDepartments({ me }) {
  return (
    <div className="kb-card soft" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, padding: '36px 24px' }}>
      <span className="kb-ico" style={{ background: 'var(--kb-green-soft)', color: 'var(--kb-green)', width: 44, height: 44 }} aria-hidden="true"><FolderOpen size={22} /></span>
      <div className="kb-title" style={{ fontSize: 15 }}>No departments yet</div>
      <div className="kb-meta" style={{ maxWidth: 440 }}>Each department gets a collection that holds its how-tos, SOPs, policies and references. {me?.can_manage ? 'Create the first one, or bring the old library in and the departments come with it.' : 'A Knowledge Base manager sets them up.'}</div>
      {me?.can_manage && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
          <button type="button" className="kb-btn pri" onClick={() => goKb('collections')}><Plus />Create a Collection</button>
          <button type="button" className="kb-btn" onClick={() => goKb('health')}>Bring the Old Library In</button>
        </div>
      )}
    </div>
  );
}

export default function Home({ me }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [request, setRequest] = useState(false);
  const recent = readRecent();
  const load = () => api.kbHome().then(setData).catch((e) => setErr(e.message || 'Could not load the Library'));
  useEffect(() => { load(); }, []);
  const waiting = data ? data.waiting.policies.length + data.waiting.training.length + data.waiting.reviews.length : 0;
  const cols = data?.collections || [];
  const tops = cols.filter((c) => !c.parent_id);
  const subsOf = (id) => cols.filter((c) => c.parent_id === id);

  return (
    <div className="kb-page">
      <section className="kb-home-top">
        <SearchBox autoFocus large={false} onSearch={(q) => goKb('search', q)} onAsk={(q) => goKb('search', `?${q}`)} />
        {me?.can_author && (
          <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
            <button type="button" className="kb-btn pri" onClick={() => goKb('editor', 'new')}><Plus />New Page</button>
            <button type="button" className="kb-btn" onClick={() => goKb('editor', 'import')}><Upload />Import</button>
          </div>
        )}
      </section>
      {recent.length > 0 && (
        <div className="kb-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: -12 }}>
          Recent:
          {recent.map((r) => <button key={r} type="button" className="kb-pill" onClick={() => goKb('search', r)}>{r}</button>)}
        </div>
      )}

      <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
        {data && (
        <div className="kb-cols">
          <div className="kb-main">
            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SectionHead title="Departments" sub={tops.length ? `${plural(tops.length, 'collection')} · ${plural(data.counts.published, 'published page')}` : ''} right={me?.can_manage && tops.length > 0 ? <button type="button" className="kb-btn sm" onClick={() => goKb('collections')}>Manage Collections</button> : null} />
              {tops.length === 0 ? <NoDepartments me={me} /> : (
                <div className="kb-grid3">
                  {tops.map((c) => <DepartmentCard key={c.id} c={c} subs={subsOf(c.id)} />)}
                </div>
              )}
            </section>

            {waiting > 0 && (
              <section className="kb-card">
                <SectionHead title="Waiting on You" count={waiting} right={<a href="#training" onClick={(e) => { e.preventDefault(); goKb('training'); }} style={{ fontSize: 13, fontWeight: 600 }}>My Training</a>} />
                {data.waiting.policies.map((p) => (
                  <div key={p.id} className="kb-row">
                    <Chip color={typeMeta(p.page_type).color}>{typeMeta(p.page_type).label}</Chip>
                    <div className="kb-grow">
                      <div className="kb-title">{p.title} <span className="kb-meta" style={{ fontWeight: 400 }}>v{p.version}{p.code ? ` · ${p.code}` : ''}</span></div>
                      <div className="kb-meta">{p.overdue_days ? `${p.overdue_days} days overdue` : p.due ? `Sign by ${fmtDate(p.due)}` : 'Needs your signature'}</div>
                    </div>
                    <button type="button" className={`kb-btn${p.overdue_days ? ' pri' : ''}`} onClick={() => goKb('page', p.id)}>Read and Sign</button>
                  </div>
                ))}
                {data.waiting.training.map((c) => (
                  <div key={c.id} className="kb-row">
                    <Chip color="#1e7b4e">Course</Chip>
                    <div className="kb-grow">
                      <div className="kb-title">{c.title} <span className="kb-meta" style={{ fontWeight: 400 }}>· {c.my_pct}% done</span></div>
                      <div className="kb-meta">{c.days_overdue ? `${c.days_overdue} days overdue` : c.due_date ? `Due ${fmtDate(c.due_date)}` : ''}{c.est_minutes ? ` · about ${c.est_minutes} minutes` : ''}</div>
                    </div>
                    <button type="button" className={`kb-btn${c.days_overdue ? ' pri' : ''}`} onClick={() => goKb('course', c.id)}>{c.my_status === 'Not Started' ? 'Start' : 'Continue'}</button>
                  </div>
                ))}
                {data.waiting.reviews.map((r) => (
                  <div key={r.revision_id || r.id} className="kb-row">
                    <Chip color="#b45309">Review</Chip>
                    <div className="kb-grow">
                      <div className="kb-title">{r.title} <span className="kb-meta" style={{ fontWeight: 400 }}>{r.kind === 'revision' ? `${r.change_kind} change` : 'new page'} from {r.author_name}</span></div>
                      <div className="kb-meta">{r.change_note || (r.mine ? 'You are the named reviewer' : 'In your collection')}</div>
                    </div>
                    <button type="button" className="kb-btn" onClick={() => goKb(r.kind === 'revision' ? 'revision' : 'review', r.kind === 'revision' ? r.revision_id : r.id)}>Review</button>
                  </div>
                ))}
              </section>
            )}
          </div>

          <aside className="kb-rail">
            {data.my_drafts.length > 0 && (
              <section className="kb-card">
                <SectionHead title="Your Drafts" right={<button type="button" className="kb-btn sm" onClick={() => goKb('health')}>All Drafts</button>} />
                {data.my_drafts.map((d) => (
                  <div key={d.revision_id || d.id} className="kb-row link" onClick={() => goKb(d.is_revision ? 'editor' : (d.status === 'in_review' ? 'page' : 'editor'), d.id)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') goKb(d.is_revision ? 'editor' : (d.status === 'in_review' ? 'page' : 'editor'), d.id); }}>
                    <FileText size={16} style={{ color: 'var(--kb-dim)', flex: '0 0 auto' }} />
                    <div className="kb-grow"><div className="kb-title kb-ellipsis">{d.title}</div><div className="kb-meta">{d.is_revision ? 'Revision' : typeMeta(d.page_type).label} · {d.status.replace('_', ' ')} · {fmtDate(d.updated_at)}</div></div>
                  </div>
                ))}
              </section>
            )}
            {data.pinned.length > 0 && (
              <section className="kb-card">
                <SectionHead title="Pinned" sub="yours" />
                {data.pinned.map((p) => <PageRow key={p.id} page={p} compact />)}
              </section>
            )}
            <section className="kb-card">
              <SectionHead title="Recently Updated" />
              {data.recent.length === 0 && <div className="kb-meta" style={{ padding: '4px 0 2px' }}>Published pages show up here, newest first.</div>}
              {data.recent.map((p) => (
                <div key={p.id} className="kb-row link" onClick={() => goKb('page', p.id)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') goKb('page', p.id); }} style={{ alignItems: 'flex-start' }}>
                  <div className="kb-grow"><div className="kb-title">{p.title}</div>
                    <div className="kb-meta">v{p.version}{p.collection?.[0] ? ` · ${p.collection[0].name}` : ''}{p.owner_name ? ` · ${p.owner_name}` : ''} · {fmtDate(p.published_at || p.updated_at)}</div></div>
                </div>
              ))}
              <div className="kb-meta" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--kb-line)' }}>
                Can&apos;t find a page? <a href="#req" onClick={(e) => { e.preventDefault(); setRequest(true); }}>Request it</a> and the collection owner hears.
              </div>
            </section>
          </aside>
        </div>
        )}
      </AsyncSection>
      {request && <RequestPageModal collections={cols} onClose={() => setRequest(false)} />}
    </div>
  );
}
