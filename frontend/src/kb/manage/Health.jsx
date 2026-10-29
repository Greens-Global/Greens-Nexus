// Manage > Health: reviews waiting on you, pages past review, reader
// flags, page requests, searches with no good answer, drafts, activity,
// and the migration (managers).
import { useEffect, useState } from 'react';
import { ShieldCheck, Pencil, Check, Flag, Search, History, Database, AlertTriangle, Loader2, UserPlus, X, Download } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal } from '../../tasks/components';
import { Chip, SectionHead, Stat, Av, TypeChip, Banner } from '../components/Chips';
import PageRow from '../components/PageCard';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, fmtDateTime, plural } from '../lib';
import { useRole } from '../../contexts/RoleContext';
import HelpSignals from '../../support/HelpSignals';
import { SOURCE_NAMES } from '../../support/helpLog';
import PeoplePick from '../components/PeoplePick';
import ReadingReport from './ReadingReport';
import PhotoReviews from './PhotoReviews';

const KIND_WORDS = { created: 'created', submitted: 'submitted for review', published: 'published', changes_requested: 'asked for changes on', archived: 'archived', restored: 'restored', verified: 'verified', flagged: 'reported a problem with', signed: 'signed', translated: 'translated', revision_opened: 'started a revision of', revision_submitted: 'submitted a revision of', revision_discarded: 'discarded a revision of', task_started: 'started a task from', flag_resolved: 'resolved a report on', withdrawn: 'withdrew',
  request_assigned: 'assigned a page request:', request_closed: 'closed a page request:', sign_sent: 'sent a signing request for', sign_declined: 'declined to sign',
  sign_voided: 'canceled a signing request for', sign_expired: 'let a signing request expire for', course_created: 'created course', course_published: 'published course', course_completed: 'completed course', quiz_unlocked: 'unlocked the quiz on', migrated: 'ran the migration', edited: 'edited' };

// Close a reader report or a page request with a word back to the person
// (WP 4.3, Oct 29 2026) - a 60% popup, never the browser's prompt box.
function NoteModal({ title, about, label, initial = '', confirm, onSave, onClose }) {
  const [note, setNote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave(note.trim()); onClose(); } catch { /* the toast said why */ } finally { setBusy(false); } };
  return (
    <Modal title={title} onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy} onClick={save}><Check />{confirm}</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <div className="kb-title">{about}</div>
        <div className="kb-field nx-fill" style={{ display: 'flex', flexDirection: 'column' }}>
          <label htmlFor="kb-note">{label}</label>
          <textarea id="kb-note" className="kb-textarea" style={{ flex: 1, minHeight: 120 }} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="kb-help">They get it in their notification bell. Optional.</div>
        </div>
      </div>
    </Modal>
  );
}

// Give a page request to someone to write (WP 4.3): a Knowledge Base author
// in the asker's company; they get a bell.
function AssignModal({ request, onSave, onClose }) {
  const [who, setWho] = useState(request.assigned_to || '');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave(who); onClose(); } catch { /* the toast said why */ } finally { setBusy(false); } };
  return (
    <Modal title="Assign Page Request" onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy || !who} onClick={save}><UserPlus />Assign</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="kb-title">"{request.query}"</div>
        {request.note && <div style={{ fontSize: 13.5 }}>{request.note}</div>}
        <div className="kb-meta">Asked by {request.user_name} on {fmtDate(request.created_at)}</div>
        <div className="kb-field"><label>Who Writes It</label><PeoplePick value={who} onChange={setWho} allowClear={false} placeholder="A Knowledge Base author" /></div>
      </div>
    </Modal>
  );
}

// A synonym from a real miss (WP 4.4): "people search X, look for Y too".
function SynonymModal({ query, onSave, onClose }) {
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const list = words.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const save = async () => { setBusy(true); try { await onSave([query, ...list]); onClose(); } catch { /* the toast said why */ } finally { setBusy(false); } };
  return (
    <Modal title="Add Synonym" onClose={onClose}
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
             <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
             <button type="button" className="kb-btn pri" disabled={busy || !list.length} onClick={save}><Check />Add Synonym</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="kb-title">When people search "{query}", also look for:</div>
        <div className="kb-field"><label htmlFor="kb-syn">Words Your Pages Use</label>
          <input id="kb-syn" className="kb-input" value={words} onChange={(e) => setWords(e.target.value)} placeholder="gate, entry code" />
          <div className="kb-help">Separate words with commas. Search then finds pages with any of them, for everyone in the organization.</div></div>
      </div>
    </Modal>
  );
}

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
    <Modal title="Bring the Old Library In" onClose={onClose} footer={<div className="kb" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="kb-meta kb-grow">{rep ? (rep.dry_run ? 'Dry run: nothing has changed yet.' : 'Applied.') : ''}{rep && !rep.storage ? ' Image storage is not configured here, so inline images stay as they are.' : ''}</span><button type="button" className="kb-btn" onClick={onClose}>Close</button>{rep?.dry_run && <button type="button" className="kb-btn pri" disabled={busy} onClick={apply}>{applying ? <><Loader2 className="kb-spin" />Converting</> : <><Database />Convert Everything</>}</button>}</div>}>
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
  const { can } = useRole() || {};
  const isAdmin = !!can?.('administrator');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [migrate, setMigrate] = useState(false);
  const [noteFor, setNoteFor] = useState(null);     // {kind: 'flag' | 'request', row}
  const [assignFor, setAssignFor] = useState(null);
  const [synFor, setSynFor] = useState('');
  const load = () => { setErr(''); api.kbHealth().then(setData).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []);
  const act = (fn, msg) => fn().then(() => { if (msg) toast(msg); load(); }).catch((e) => toast(errText(e), 'err'));
  // The popups' saves: throw on error so the popup stays open.
  const run = async (fn, msg) => { try { await fn(); toast(msg); load(); } catch (e) { toast(errText(e), 'err'); throw e; } };

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
        {me?.can_manage && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {/* Export everything (WP 5.11): for audit and backup */}
            {['pdf', 'docx'].map((f) => (
              <button key={f} type="button" className="kb-btn" onClick={() => api.kbExport(f).then((b) => saveBlob(b, `Knowledge Base.${f}`)).catch((e) => toast(errText(e), 'err'))}>
                <Download />{f === 'pdf' ? 'Export PDF' : 'Export Word'}
              </button>
            ))}
          </span>
        )}
        {me?.can_manage && <button type="button" className="kb-btn" onClick={() => setMigrate(true)}><Database />{data?.stats?.unmigrated ? `Bring In ${data.stats.unmigrated} Old Pages` : 'Migration'}</button>}
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
                <PhotoReviews />
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
                        <button type="button" className="kb-btn sm" onClick={() => setNoteFor({ kind: 'flag', row: f })}><Check />Resolve</button>
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
                        <div className="kb-grow"><div className="kb-title">"{r.query}"</div>{r.note && <div style={{ fontSize: 13.5 }}>{r.note}</div>}<div className="kb-meta">{r.user_name} · {fmtDateTime(r.created_at)}{r.assigned_name ? ` · assigned to ${r.assigned_name}` : ''}</div></div>
                        <button type="button" className="kb-btn sm" onClick={() => goKb('editor', `new:${r.collection_id || ''}`)}><Pencil />Write It</button>
                        <button type="button" className="kb-btn sm" onClick={() => setAssignFor(r)}><UserPlus />{r.assigned_to ? 'Reassign' : 'Assign'}</button>
                        <button type="button" className="kb-btn sm ghost" onClick={() => setNoteFor({ kind: 'request', row: r })}><X />Close</button>
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
                    {data.misses.map((m) => <div key={`${m.source || 'kb'}:${m.query}`} className="kb-row" style={{ flexWrap: 'wrap' }}><div className="kb-grow" style={{ flexBasis: '100%' }}><div className="kb-title">"{m.query}"</div><div className="kb-meta">{SOURCE_NAMES[m.source || 'kb'] || m.source} · {plural(m.count, 'search', 'searches')} · last {fmtDate(m.last_day)}</div></div>{me?.can_manage && <button type="button" className="kb-btn sm ghost" onClick={() => setSynFor(m.query)}>Add Synonym</button>}<button type="button" className="kb-btn sm ghost" onClick={() => goKb('editor', 'new')}>Write</button></div>)}
                  </section>
                )}
                {me?.can_manage && (data.synonyms || []).length > 0 && (
                  <section className="kb-card">
                    <SectionHead title="Synonyms Added" sub="search treats each group as the same word" />
                    {data.synonyms.map((g, i) => (
                      <div key={g.join('|')} className="kb-row"><div className="kb-grow" style={{ fontSize: 13.5 }}>{g.join(' = ')}</div>
                        <button type="button" className="kb-ibtn" aria-label={`Remove ${g.join(', ')}`} onClick={() => act(() => api.kbSaveSynonyms(data.synonyms.filter((_, j) => j !== i)), 'Synonym removed')}><X size={14} /></button></div>
                    ))}
                  </section>
                )}
                {/* Help Signals (Help Center, Oct 2026): what the Help panel, Ask
                    Nexus and the ticket form could not answer - administrators. */}
                {isAdmin && <HelpSignals />}
                <ReadingReport />
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
      {noteFor?.kind === 'flag' && <NoteModal title="Resolve Report" about={`"${noteFor.row.text}" on ${noteFor.row.title}`} label="A Word Back to the Reader" initial="Fixed, thank you."
        confirm="Resolve" onSave={(n) => run(() => api.kbResolveFlag(noteFor.row.id, n), 'Resolved')} onClose={() => setNoteFor(null)} />}
      {noteFor?.kind === 'request' && <NoteModal title="Close Page Request" about={`"${noteFor.row.query}"`} label="A Word Back to the Person Who Asked"
        confirm="Close Request" onSave={(n) => run(() => api.kbCloseRequest(noteFor.row.id, n), 'Closed')} onClose={() => setNoteFor(null)} />}
      {synFor && <SynonymModal query={synFor} onSave={(g) => run(() => api.kbSaveSynonyms([...(data?.synonyms || []), g]), 'Synonym added')} onClose={() => setSynFor('')} />}
      {assignFor && <AssignModal request={assignFor} onSave={(who) => run(() => api.kbAssignRequest(assignFor.id, who), 'Assigned')} onClose={() => setAssignFor(null)} />}
      <Chip color="transparent" style={{ display: 'none' }} />
    </div>
  );
}
