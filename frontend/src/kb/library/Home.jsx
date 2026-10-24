// Library home: search first, then what waits on you, then the collections.
import { useEffect, useRef, useState } from 'react';
import { Search, Sparkles, Plus, FileText, Upload } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Chip, SectionHead, Av } from '../components/Chips';
import PageRow from '../components/PageCard';
import RequestPageModal from '../components/RequestPageModal';
import { goKb, fmtDate, colorFor, plural, typeMeta } from '../lib';

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

export default function Home({ me }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [request, setRequest] = useState(false);
  const recent = readRecent();
  const load = () => api.kbHome().then(setData).catch((e) => setErr(e.message || 'Could not load the Library'));
  useEffect(() => { load(); }, []);
  const waiting = data ? data.waiting.policies.length + data.waiting.training.length + data.waiting.reviews.length : 0;
  const tops = (data?.collections || []).filter((c) => !c.parent_id);

  return (
    <div className="kb-page">
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 860 }}>
        <h2 className="kb-h2" style={{ fontSize: 24 }}>What do you need to know?</h2>
        <SearchBox autoFocus onSearch={(q) => goKb('search', q)} onAsk={(q) => goKb('search', `?${q}`)} />
        <div className="kb-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {recent.length > 0 ? 'Recent:' : 'Try:'}
          {(recent.length ? recent : ['gate code', 'move in', 'time off']).map((r) => (
            <button key={r} type="button" className="kb-btn sm" style={{ fontWeight: 500 }} onClick={() => goKb('search', r)}>{r}</button>
          ))}
          {me?.can_author && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="kb-btn sm" onClick={() => goKb('editor', 'new')}><Plus />New Page</button>
              <button type="button" className="kb-btn sm" onClick={() => goKb('editor', 'import')}><Upload />Import</button>
            </span>
          )}
        </div>
      </section>

      <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
        {data && (
        <div className="kb-cols">
          <div className="kb-main">
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

            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SectionHead title="Collections" sub="One per department. Owners keep them current." right={me?.can_manage ? <button type="button" className="kb-btn sm" onClick={() => goKb('collections')}>Manage Collections</button> : null} />
              {tops.length === 0 && (
                <div className="kb-card soft kb-empty">
                  No collections yet.{me?.can_manage ? ' Run the migration under Manage to bring the existing library in, or create a collection.' : ''}
                </div>
              )}
              <div className="kb-grid3">
                {tops.map((c) => (
                  <button key={c.id} type="button" className="kb-coll" onClick={() => goKb('collection', c.id)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Av name={c.owner_name} email={c.owner_email} size={24} color={colorFor(c.id)} />
                      <span className="kb-title kb-ellipsis">{c.name}</span>
                      <span className="kb-meta" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{plural(c.pages, 'page')}</span>
                    </div>
                    {c.description && <div className="kb-meta">{c.description}</div>}
                    <div className="kb-meta">
                      {c.stale > 0 ? <Chip color="#dc2626">{c.stale} need review</Chip> : c.pages > 0 ? <Chip color="#1e7b4e">Up to date</Chip> : <Chip color="#64748b">Empty</Chip>}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {data.my_drafts.length > 0 && (
              <section className="kb-card">
                <SectionHead title="Your Drafts" right={<button type="button" className="kb-btn sm" onClick={() => goKb('health')}>All Drafts</button>} />
                {data.my_drafts.map((d) => (
                  <div key={d.revision_id || d.id} className="kb-row link" onClick={() => goKb(d.is_revision ? 'editor' : (d.status === 'in_review' ? 'page' : 'editor'), d.id)}>
                    <FileText size={16} style={{ color: 'var(--kb-dim)' }} />
                    <div className="kb-grow"><div className="kb-title">{d.title}</div><div className="kb-meta">{d.is_revision ? 'Revision' : typeMeta(d.page_type).label} · {d.status.replace('_', ' ')} · {fmtDate(d.updated_at)}</div></div>
                  </div>
                ))}
              </section>
            )}
          </div>

          <aside className="kb-rail">
            {data.pinned.length > 0 && (
              <section className="kb-card">
                <SectionHead title="Pinned" sub="yours" />
                {data.pinned.map((p) => <PageRow key={p.id} page={p} compact />)}
              </section>
            )}
            <section className="kb-card">
              <SectionHead title="Recently Updated" />
              {data.recent.length === 0 && <div className="kb-empty">Nothing published yet</div>}
              {data.recent.map((p) => (
                <div key={p.id} className="kb-row link" onClick={() => goKb('page', p.id)} style={{ alignItems: 'flex-start' }}>
                  <div className="kb-grow"><div className="kb-title">{p.title}</div>
                    <div className="kb-meta">v{p.version}{p.collection?.[0] ? ` · ${p.collection[0].name}` : ''}{p.owner_name ? ` · ${p.owner_name}` : ''} · {fmtDate(p.published_at || p.updated_at)}</div></div>
                </div>
              ))}
            </section>
            <section className="kb-card soft" style={{ background: '#eef7f1', borderColor: '#cfe6d8' }}>
              <div className="kb-title" style={{ marginBottom: 4 }}>Can't find it?</div>
              <div className="kb-meta" style={{ marginBottom: 10 }}>Ask for a page and the collection owner is notified.</div>
              <button type="button" className="kb-btn" onClick={() => setRequest(true)}>Request a Page</button>
            </section>
          </aside>
        </div>
        )}
      </AsyncSection>
      {request && <RequestPageModal collections={data?.collections || []} onClose={() => setRequest(false)} />}
    </div>
  );
}
