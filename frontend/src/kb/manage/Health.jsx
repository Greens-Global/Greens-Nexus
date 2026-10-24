// Manage > Health: reviews waiting on you, pages past review, reader
// flags, page requests, searches with no good answer, drafts, activity,
// and the migration (managers).
import { useEffect, useState } from 'react';
import { ShieldCheck, Pencil, Check, Flag, Search, History, Database, AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal } from '../../tasks/components';
import { Chip, SectionHead, Stat, Av, TypeChip, Banner } from '../components/Chips';
import PageRow from '../components/PageCard';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, fmtDateTime, plural } from '../lib';

const KIND_WORDS = { created: 'created', submitted: 'submitted for review', published: 'published', changes_requested: 'asked for changes on', archived: 'archived', restored: 'restored', verified: 'verified', flagged: 'reported a problem with', signed: 'signed', translated: 'translated', revision_opened: 'started a revision of', revision_submitted: 'submitted a revision of', revision_discarded: 'discarded a revision of', task_started: 'started a task from', flag_resolved: 'resolved a report on', withdrawn: 'withdrew', course_created: 'created course', course_published: 'published course', course_completed: 'completed course', quiz_unlocked: 'unlocked the quiz on', migrated: 'ran the migration', edited: 'edited' };

function MigrationModal({ onClose, onApplied }) {
  const toast = useToast();
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => { api.kbMigrationReport().then(setRep).catch((e) => toast(errText(e), 'err')); }, [toast]);
  const apply = async () => {
    if (!window.confirm('Convert every old page and course now? Nothing is deleted or overwritten; the old bodies stay beside the new ones. This can take a few minutes.')) return;
    setApplying(true); setBusy(true);
    try { const r = await api.kbMigrationApply(); setRep(r); toast('Migration finished'); onApplied(); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); setApplying(false); }
  };
  const rows = rep?.rows || [];
  const look = rows.filter((r) => r.action === 'needs a look' || (r.notes || []).length);
  return (
    <Modal title="Bring the Old Library In" onClose={onClose} footer={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="kb-meta kb-grow">{rep ? (rep.dry_run ? 'Dry run: nothing has changed yet.' : 'Applied.') : ''}{rep && !rep.storage ? ' Image storage is not configured here, so inline images stay as they are.' : ''}</span><button type="button" className="kb-btn" onClick={onClose}>Close</button>{rep?.dry_run && <button type="button" className="kb-btn pri" disabled={busy} onClick={apply}>{applying ? <><Loader2 className="kb-spin" />Converting</> : <><Database />Convert Everything</>}</button>}</div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!rep && <div className="kb-empty"><Loader2 className="kb-spin" /> Reading every old record...</div>}
        {rep && (
          <>
            <div className="kb-meta">Every old SOP, Manual and Guide, every version, signature, course and completion carries over. The old form bodies stay untouched beside the converted pages, so nothing can be lost.</div>
            <div className="kb-stats">
              {Object.entries(rep.summary.pages || {}).map(([k, v]) => <Stat key={k} value={v} label={`pages: ${k}`} color={k === 'needs a look' ? '#b45309' : undefined} />)}
              {Object.entries(rep.summary.courses || {}).map(([k, v]) => <Stat key={k} value={v} label={`courses: ${k}`} />)}
              {Object.entries(rep.summary.collections || {}).map(([k, v]) => <Stat key={k} value={v} label={`collections: ${k}`} />)}
            </div>
            {look.length > 0 && (
              <div>
                <div className="kb-title" style={{ marginBottom: 6 }}>{plural(look.length, 'row')} worth a look</div>
                <div style={{ maxHeight: '36vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {look.map((r, i) => <div key={i} className="kb-card soft" style={{ padding: 10, fontSize: 13 }}><b>{r.title || r.name}</b> <span className="kb-meta">({r.kind}{r.code ? `, ${r.code}` : ''}) · {r.action}</span>{(r.notes || []).map((n, j) => <div key={j} className="kb-meta">· {n}</div>)}</div>)}
                </div>
              </div>
            )}
            <details><summary className="kb-meta" style={{ cursor: 'pointer' }}>All {rows.length} rows</summary>
              <table className="kb-table" style={{ marginTop: 8 }}><thead><tr><th>Kind</th><th>Title</th><th>Becomes</th><th>Action</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td>{r.kind}</td><td>{r.title || r.name}</td><td>{r.new_type || r.parent || ''}{r.version ? ` v${r.version}` : ''}</td><td>{r.action}</td></tr>)}</tbody></table></details>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function Health({ me }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [migrate, setMigrate] = useState(false);
  const load = () => { setErr(''); api.kbHealth().then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []);
  const act = (fn, msg) => fn().then(() => { if (msg) toast(msg); load(); }).catch((e) => toast(errText(e), 'err'));

  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>Manage</h1>
        <div className="kb-seg">
          <button type="button" className="on">Health</button>
          <button type="button" onClick={() => goKb('compliance')}>Compliance</button>
          <button type="button" onClick={() => goKb('collections')}>Collections</button>
          <button type="button" onClick={() => goKb('plans')}>Plans and Rules</button>
        </div>
        {me?.can_manage && <button type="button" className="kb-btn" style={{ marginLeft: 'auto' }} onClick={() => setMigrate(true)}><Database />{data?.stats?.unmigrated ? `Bring In ${data.stats.unmigrated} Old Pages` : 'Migration'}</button>}
      </div>
      <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
        {data && (
          <>
            {data.stats.unmigrated > 0 && me?.can_manage && <Banner kind="amber" icon={AlertTriangle}><b>{plural(data.stats.unmigrated, 'page')} from the old Knowledge Base</b> have not been converted yet. Readers still see them; editors cannot edit them until they are. <button type="button" className="kb-btn sm" style={{ marginLeft: 8 }} onClick={() => setMigrate(true)}>See the report</button></Banner>}
            <div className="kb-stats">
              <Stat value={data.stats.published} label="published pages" />
              <Stat value={data.review_queue.length} label="waiting for your review" color={data.review_queue.length ? '#b45309' : undefined} />
              <Stat value={data.stats.stale} label="past review date" color={data.stats.stale ? '#dc2626' : undefined} />
              <Stat value={data.stats.flags} label="reader reports" color={data.stats.flags ? '#dc2626' : undefined} />
              <Stat value={data.stats.requests} label="page requests" />
              {me?.can_manage && <Stat value={data.stats.signatures_outstanding} label="signatures outstanding" />}
            </div>
            <div className="kb-cols">
              <div className="kb-main">
                {data.review_queue.length > 0 && (
                  <section className="kb-card">
                    <SectionHead title="Waiting for Your Review" count={data.review_queue.length} />
                    {data.review_queue.map((r) => (
                      <div key={r.revision_id || r.id} className="kb-row">
                        <TypeChip type={r.page_type} />
                        <div className="kb-grow"><div className="kb-title">{r.title} <span className="kb-meta" style={{ fontWeight: 400 }}>{r.kind === 'revision' ? `v${r.version} → ${r.change_kind} change` : 'new page'}</span></div><div className="kb-meta">{r.author_name} · {fmtDateTime(r.submitted_at)}{r.change_note ? ` · ${r.change_note}` : ''}{r.mine ? '' : ' · in your collection'}</div></div>
                        <button type="button" className="kb-btn sm pri" onClick={() => goKb(r.kind === 'revision' ? 'revision' : 'review', r.kind === 'revision' ? r.revision_id : r.id)}>Review</button>
                      </div>
                    ))}
                  </section>
                )}
                <section className="kb-card">
                  <SectionHead title="Past Review Date" count={data.stale.length} sub="Still true? One click. Changed? Revise it." />
                  {data.stale.length === 0 && <div className="kb-empty">Every page you own is within its review cycle.</div>}
                  {data.stale.map((p) => (
                    <div key={p.id} className="kb-row">
                      <TypeChip type={p.page_type} />
                      <div className="kb-grow"><div className="kb-title">{p.title} <span className="kb-meta" style={{ fontWeight: 400 }}>{p.code}</span></div><div className="kb-meta">Review was due {fmtDate(p.next_review)} · {p.days_overdue} days ago · {p.owner_name}</div></div>
                      <button type="button" className="kb-btn sm" onClick={() => act(() => api.kbVerifyPage(p.id), 'Marked still accurate')}><ShieldCheck />Still Accurate</button>
                      <button type="button" className="kb-btn sm" onClick={() => goKb('editor', p.id)}><Pencil />Revise</button>
                    </div>
                  ))}
                </section>
                {data.flags.length > 0 && (
                  <section className="kb-card">
                    <SectionHead title="Flagged by Readers" count={data.flags.length} />
                    {data.flags.map((f) => (
                      <div key={f.id} className="kb-row" style={{ alignItems: 'flex-start' }}>
                        <Flag size={16} style={{ color: '#dc2626', marginTop: 3 }} />
                        <div className="kb-grow"><div className="kb-title"><a href="#p" onClick={(e) => { e.preventDefault(); goKb('page', f.doc_id); }}>{f.title}</a> <span className="kb-meta" style={{ fontWeight: 400 }}>v{f.version}</span></div><div style={{ fontSize: 13.5 }}>"{f.text}"</div><div className="kb-meta">{f.user_name} · {fmtDateTime(f.created_at)}</div></div>
                        <button type="button" className="kb-btn sm" onClick={() => goKb('editor', f.doc_id)}><Pencil />Fix</button>
                        <button type="button" className="kb-btn sm" onClick={() => { const res = window.prompt('A word back to the reader (optional):', 'Fixed, thank you.'); if (res !== null) act(() => api.kbResolveFlag(f.id, res), 'Resolved'); }}><Check />Resolve</button>
                      </div>
                    ))}
                  </section>
                )}
                {data.requests.length > 0 && (
                  <section className="kb-card">
                    <SectionHead title="Page Requests" count={data.requests.length} />
                    {data.requests.map((r) => (
                      <div key={r.id} className="kb-row" style={{ alignItems: 'flex-start' }}>
                        <Search size={16} style={{ color: 'var(--kb-dim)', marginTop: 3 }} />
                        <div className="kb-grow"><div className="kb-title">"{r.query}"</div>{r.note && <div style={{ fontSize: 13.5 }}>{r.note}</div>}<div className="kb-meta">{r.user_name} · {fmtDateTime(r.created_at)}</div></div>
                        <button type="button" className="kb-btn sm" onClick={() => goKb('editor', `new:${r.collection_id || ''}`)}><Pencil />Write It</button>
                        <button type="button" className="kb-btn sm ghost" onClick={() => act(() => api.kbCloseRequest(r.id, ''), 'Closed')}>Close</button>
                      </div>
                    ))}
                  </section>
                )}
                {(data.drafts.length > 0 || data.in_review.length > 0) && (
                  <section className="kb-card">
                    <SectionHead title="Drafts and Reviews" sub="Pages that are not live yet" />
                    {data.in_review.map((p) => <PageRow key={p.id} page={p} showStatus onOpen={(pg) => goKb('page', pg.id)} />)}
                    {data.drafts.map((p) => <PageRow key={p.id} page={p} showStatus onOpen={(pg) => goKb('editor', pg.id)} />)}
                  </section>
                )}
              </div>
              <aside className="kb-rail">
                {data.misses.length > 0 && (
                  <section className="kb-card">
                    <SectionHead title="Searches With No Good Answer" sub="last 30 days" />
                    {data.misses.map((m) => <div key={m.query} className="kb-row"><div className="kb-grow"><div className="kb-title">"{m.query}"</div><div className="kb-meta">{plural(m.count, 'search', 'searches')} · last {fmtDate(m.last_day)}</div></div><button type="button" className="kb-btn sm ghost" onClick={() => goKb('editor', 'new')}>Write</button></div>)}
                  </section>
                )}
                <section className="kb-card">
                  <SectionHead title="Activity" />
                  {data.activity.length === 0 && <div className="kb-empty">Nothing yet.</div>}
                  {data.activity.slice(0, 25).map((e) => (
                    <div key={e.id} className="kb-row" style={{ alignItems: 'flex-start', padding: '8px 0' }}>
                      <Av name={e.actor_name} email={e.actor_email} size={22} />
                      <div className="kb-grow" style={{ fontSize: 13 }}><b>{e.actor_name || e.actor_email.split('@')[0]}</b> {KIND_WORDS[e.kind] || e.kind} <a href="#x" onClick={(ev) => { ev.preventDefault(); if (e.doc_id) goKb('page', e.doc_id); else if (e.course_id) goKb('course', e.course_id); }}>{e.title}</a>{e.version ? ` v${e.version}` : ''}<div className="kb-meta">{fmtDateTime(e.created_at)}{e.note ? ` · ${e.note.slice(0, 80)}` : ''}</div></div>
                    </div>
                  ))}
                  <div style={{ marginTop: 6 }}><History size={13} style={{ verticalAlign: 'middle', color: 'var(--kb-dim)' }} /> <span className="kb-meta">The full log is kept forever; this shows the latest.</span></div>
                </section>
              </aside>
            </div>
          </>
        )}
      </AsyncSection>
      {migrate && <MigrationModal onClose={() => setMigrate(false)} onApplied={load} />}
      <Chip color="transparent" style={{ display: 'none' }} />
    </div>
  );
}
