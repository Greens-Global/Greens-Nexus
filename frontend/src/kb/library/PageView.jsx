// Reading a page: the clean column, the action bar, On This Page, the rail.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Play, Share2, Pin, Pencil, ThumbsUp, ThumbsDown, Flag, Globe, Printer, Copy, Link2, ShieldCheck, AlertTriangle, PenLine, Check, RotateCcw, Archive, History, Eye, MessageSquare, ClipboardList, MoreHorizontal } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import AnchoredMenu from '../../components/AnchoredMenu';
import { Modal } from '../../tasks/components';
import { useRole } from '../../contexts/RoleContext';
import Blocks from '../components/Blocks';
import { TypeChip, VerifiedChip, StatusChip, Chip, Av, Banner } from '../components/Chips';
import StartTaskModal from '../components/StartTaskModal';
import { useToast, errText } from '../components/Toast';
import { goKb, goView, fmtDate, fmtDateTime, pageUrl, copyText, typeMeta, plural, subFor } from '../lib';

const LANGS = { en: 'English', es: 'Español', hi: 'हिन्दी' };

function Toc({ headings, active }) {
  if (!headings?.length) return null;
  return (
    <nav className="kb-toc" aria-label="On this page">
      <div className="kb-label" style={{ padding: '0 10px 6px' }}>On This Page</div>
      {headings.map((h) => <a key={h.anchor} href={`#${h.anchor}`} className={`${h.level >= 3 ? 'l3 ' : ''}${active === h.anchor ? 'on' : ''}`}
        onClick={(e) => { e.preventDefault(); document.getElementById(h.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{h.text}</a>)}
    </nav>
  );
}

function SignBlock({ page, onSigned }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const so = page.signoff;
  if (!page.require_ack || page.status !== 'approved') return null;
  if (so.signed) {
    return (
      <Banner kind="green" icon={ShieldCheck}>You signed v{so.version_signed || page.version} on {fmtDateTime(so.signed_at)}.</Banner>
    );
  }
  if (!so.required) return null;
  const sign = async () => {
    setBusy(true);
    try { onSigned(await api.kbSign(page.id, name)); toast('Signed. Thank you.'); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div id="sign" className="kb-card soft" style={{ background: 'var(--kb-paper)' }}>
      <div className="kb-title" style={{ marginBottom: 4 }}>Sign v{page.version}</div>
      <div className="kb-meta" style={{ marginBottom: 10 }}>Typing your name confirms you have read and will follow this {typeMeta(page.page_type).label.toLowerCase()}. Nexus stores your name, the time, the version and the exact text you signed.</div>
      {so.version_signed && <div className="kb-meta" style={{ marginBottom: 10 }}>You signed v{so.version_signed} before. This is a new major version, so that signature no longer counts.</div>}
      <label className="kb-label" htmlFor="kb-sig">Your Full Name</label>
      <input id="kb-sig" className="kb-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Type your full name" style={{ margin: '4px 0 10px', fontSize: 16 }} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) sign(); }} />
      <button type="button" className="kb-btn pri lg" style={{ width: '100%' }} disabled={busy || !name.trim()} onClick={sign}><Check />Sign {page.title} v{page.version}</button>
      {so.due && <div className="kb-meta" style={{ marginTop: 8, textAlign: 'center' }}>Due {fmtDate(so.due)}{so.overdue_days ? ` · ${so.overdue_days} days overdue` : ''}</div>}
    </div>
  );
}

function FlagModal({ page, onClose }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await api.kbFlagPage(page.id, text); toast('Thanks. The page owner has been told.'); onClose(); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Report a Problem" onClose={onClose} minHeight="40vh" footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={onClose}>Cancel</button><button type="button" className="kb-btn pri" disabled={busy || !text.trim()} onClick={send}>Send to the Owner</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="kb-meta">About <b>{page.title}</b> v{page.version}. It goes to {page.owner_name || 'the collection owner'} as a flagged item in Manage, and you hear back when it is fixed.</div>
        <textarea className="kb-textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What is wrong, and which step" style={{ minHeight: 140 }} />
      </div>
    </Modal>
  );
}

function Comments({ page, me }) {
  const toast = useToast();
  const [rows, setRows] = useState(page.comments || []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { setRows(await api.kbAddComment(page.id, text.trim())); setText(''); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <section id="comments" style={{ marginTop: 28 }}>
      <h2 style={{ fontFamily: "'Figtree','Inter',sans-serif", fontSize: 20, margin: '0 0 8px' }}>Comments <span className="kb-meta" style={{ fontWeight: 400 }}>{rows.length || ''}</span></h2>
      {rows.map((c) => (
        <div key={c.id} className="kb-cmt">
          <Av name={c.author_name} email={c.author_email} />
          <div className="kb-grow"><div><b>{c.author_name}</b> <span className="kb-meta">{fmtDateTime(c.created_at)}</span></div><div style={{ fontSize: 14, margin: '2px 0 4px', whiteSpace: 'pre-wrap' }}>{c.text}</div></div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <Av name={me?.name} email={me?.email} />
        <input className="kb-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" aria-label="Add a comment" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button type="button" className="kb-btn" disabled={busy || !text.trim()} onClick={add}>Post</button>
      </div>
    </section>
  );
}

export default function PageView({ id, me }) {
  const toast = useToast();
  const { myGrantedModules, can } = useRole();
  const [page, setPage] = useState(null);
  const [err, setErr] = useState('');
  const [lang, setLang] = useState('en');
  const [trans, setTrans] = useState(null);
  const [active, setActive] = useState('');
  const [task, setTask] = useState(false);
  const [flag, setFlag] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [versionView, setVersionView] = useState(null);
  const [original, setOriginal] = useState(null);
  const shareRef = useRef(null);
  const moreRef = useRef(null);
  const canTasks = !!(can?.('administrator') || myGrantedModules?.has?.('tasks'));

  const load = () => { setErr(''); api.kbPage(id).then(setPage).catch((e) => setErr(e.status === 404 ? 'This page does not exist, or you do not have access to it.' : errText(e))); };
  useEffect(() => { setPage(null); setLang('en'); setTrans(null); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!page?.headings?.length) return undefined;
    const els = page.headings.map((h) => document.getElementById(h.anchor)).filter(Boolean);
    if (!els.length) return undefined;
    const obs = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: '-80px 0px -70% 0px' });
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [page, lang]);

  const switchLang = async (l) => {
    if (l === 'en') { setLang('en'); setTrans(null); return; }
    try { setTrans(await api.kbTranslation(page.id, l)); setLang(l); } catch (e) { toast(errText(e, 'No translation yet'), 'err'); }
  };
  const act = async (fn, okMsg) => { try { const out = await fn(); if (out && out.id) setPage(out); else load(); if (okMsg) toast(okMsg); } catch (e) { toast(errText(e), 'err'); } };
  const vote = async (helpful) => { try { const fb = await api.kbFeedback(page.id, helpful); setPage((p) => ({ ...p, feedback: fb })); } catch (e) { toast(errText(e), 'err'); } };

  const doc = useMemo(() => (lang !== 'en' && trans ? trans.blocks : page?.blocks), [page, lang, trans]);
  const headings = lang !== 'en' && trans ? trans.headings : page?.headings;
  const title = lang !== 'en' && trans ? trans.title : page?.title;

  return (
    <AsyncSection loading={!page && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {page && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="kb-meta">
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back to the Library" onClick={() => (page.collection?.[0] ? goKb('collection', page.collection[page.collection.length - 1].id) : goKb('home'))}><ArrowLeft /></button>
            <a href="#home" onClick={(e) => { e.preventDefault(); goKb('home'); }}>Knowledge Base</a>
            {(page.collection || []).map((c) => <span key={c.id}> / <a href="#c" onClick={(e) => { e.preventDefault(); goKb('collection', c.id); }}>{c.name}</a></span>)}
            <span> / <b style={{ color: 'var(--kb-ink)' }}>{page.title}</b></span>
          </div>

          {page.status !== 'approved' && (
            <Banner kind={page.status === 'archived' ? 'red' : 'amber'} icon={Eye}>
              <b>{page.status === 'in_review' ? 'In review.' : page.status === 'changes_requested' ? 'Changes requested.' : page.status === 'archived' ? 'Archived.' : 'Draft.'}</b>{' '}
              {page.status === 'archived' ? 'Readers cannot see this page. Restore it to edit it again.' : 'Readers cannot see this page yet.'}
              {page.status === 'changes_requested' && page.review_note ? ` Reviewer: "${page.review_note}"` : ''}
              {page.status === 'in_review' && page.can_review && <span> <a href="#rev" onClick={(e) => { e.preventDefault(); goKb('review', page.id); }}>Review it</a>.</span>}
            </Banner>
          )}
          {page.status === 'approved' && page.review?.banner && (
            <Banner kind="amber" icon={AlertTriangle}>This page was due for review on {fmtDate(page.review.next_review)} and has not been checked since. Treat it with care.{page.can_edit && <> <a href="#v" onClick={(e) => { e.preventDefault(); act(() => api.kbVerifyPage(page.id), 'Marked still accurate'); }}>Still accurate</a></>}</Banner>
          )}
          {lang !== 'en' && trans && (
            <Banner kind={trans.outdated ? 'amber' : 'blue'} icon={Globe}>Machine-translated to {LANGS[lang]}. The English version is authoritative.{trans.outdated ? ` This translation is from v${trans.version}; the page is now v${page.version}.` : ''}</Banner>
          )}

          <div className="kb-cols" style={{ gap: 28 }}>
            <div style={{ flex: '0 1 190px', minWidth: 0, paddingTop: 100 }} className="kb-toc-col"><Toc headings={headings} active={active} /></div>

            <article className="kb-card kb-article">
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <TypeChip type={page.page_type} />
                {page.code && <span className="kb-meta">{page.code}</span>}
                <span className="kb-meta">· Version {page.version}</span>
                {page.status === 'approved' ? <VerifiedChip page={page} /> : <StatusChip status={page.status} />}
                {page.verified_by_name && page.status === 'approved' && <span className="kb-meta">by {page.verified_by_name}</span>}
              </div>
              <h1 className="kb-h1">{title}</h1>
              {page.summary && <p style={{ color: 'var(--kb-dim)', fontSize: 15, margin: '0 0 10px' }}>{page.summary}</p>}

              <div className="kb-page-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '12px 0 4px', borderTop: '1px solid var(--kb-line)', borderBottom: '1px solid var(--kb-line)', marginBottom: 8 }}>
                {page.can_start_task && canTasks && <button type="button" className="kb-btn pri" onClick={() => setTask(true)}><Play />Start as Task</button>}
                {page.require_ack && page.status === 'approved' && page.signoff.required && !page.signoff.signed && <a className="kb-btn pri" href="#sign" onClick={(e) => { e.preventDefault(); document.getElementById('sign')?.scrollIntoView({ behavior: 'smooth' }); }}><PenLine />Read, Then Sign Below</a>}
                <button ref={shareRef} type="button" className="kb-btn" onClick={() => setShareOpen(true)}><Share2 />Share</button>
                <AnchoredMenu anchorRef={shareRef} open={shareOpen} onClose={() => setShareOpen(false)} minWidth={220}>
                  <div className="kb" style={{ padding: 6, display: 'flex', flexDirection: 'column' }}>
                    <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { copyText(pageUrl(page.id)); toast('Link copied'); setShareOpen(false); }}><Link2 />Copy Link</button>
                    <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { copyText(`${page.title}\n\n${(page.steps || []).map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`); toast('Copied as text'); setShareOpen(false); }}><Copy />Copy as Text</button>
                    <a className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} href={api.kbPrintUrl(page.id)} target="_blank" rel="noopener noreferrer" onClick={() => setShareOpen(false)}><Printer />Print</a>
                  </div>
                </AnchoredMenu>
                <button type="button" className={`kb-btn${page.pinned ? ' on' : ''}`} onClick={() => act(async () => { const r = await api.kbPinPage(page.id); setPage((p) => ({ ...p, pinned: r.pinned })); }, null)}><Pin style={page.pinned ? { fill: 'currentColor', color: 'var(--kb-green)' } : {}} />{page.pinned ? 'Pinned' : 'Pin'}</button>
                {(page.translations?.length > 0 || page.can_edit) && (
                  <div className="kb-seg" style={{ padding: 3 }}>
                    {Object.entries(LANGS).map(([k, l]) => {
                      const has = k === 'en' || page.translations?.some((t) => t.lang === k);
                      if (!has && !page.can_edit) return null;
                      return <button key={k} type="button" className={lang === k ? 'on' : ''} style={!has ? { borderBottom: '1px dashed var(--kb-dim)' } : {}}
                        onClick={() => (has ? switchLang(k) : act(async () => { await api.kbTranslate(page.id, k); toast(`Translating to ${l}. It takes a minute or two.`); }, null))}
                        title={!has ? `Translate to ${l}` : ''}>{l}</button>;
                    })}
                  </div>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  {page.can_edit && page.status === 'approved' && <button type="button" className="kb-btn" onClick={() => goKb('editor', page.id)}><Pencil />{page.open_revision ? 'Continue Revision' : 'Edit'}</button>}
                  {page.can_edit && page.status !== 'approved' && page.status !== 'archived' && page.status !== 'in_review' && <button type="button" className="kb-btn pri" onClick={() => goKb('editor', page.id)}><Pencil />Edit Draft</button>}
                  {page.can_review && page.status === 'in_review' && <button type="button" className="kb-btn pri" onClick={() => goKb('review', page.id)}>Review</button>}
                  {page.can_edit && (
                    <>
                      <button ref={moreRef} type="button" className="kb-ibtn" aria-label="More" onClick={() => setMoreOpen(true)}><MoreHorizontal /></button>
                      <AnchoredMenu anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} align="end" minWidth={240}>
                        <div className="kb" style={{ padding: 6, display: 'flex', flexDirection: 'column' }}>
                          {page.status === 'approved' && <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setMoreOpen(false); act(() => api.kbVerifyPage(page.id), 'Marked still accurate. The review clock restarted.'); }}><ShieldCheck />Still Accurate</button>}
                          {page.status === 'in_review' && <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setMoreOpen(false); act(() => api.kbWithdrawPage(page.id), 'Back to draft'); }}><RotateCcw />Withdraw From Review</button>}
                          {page.require_ack && <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setMoreOpen(false); goKb('signatures', page.id); }}><ClipboardList />Who Has Signed</button>}
                          {page.has_original && <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setMoreOpen(false); api.kbPageOriginal(page.id).then(setOriginal).catch((e) => toast(errText(e), 'err')); }}><History />View Original Source</button>}
                          {page.status !== 'archived' && (me?.can_manage || me?.owned_collections?.includes(page.collection_id)) && <button type="button" className="kb-btn ghost danger" style={{ justifyContent: 'flex-start' }} onClick={() => { setMoreOpen(false); if (window.confirm('Archive this page? Readers will no longer see it. It can be restored as a draft.')) act(() => api.kbArchivePage(page.id), 'Archived'); }}><Archive />Archive</button>}
                          {page.status === 'archived' && <button type="button" className="kb-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setMoreOpen(false); act(() => api.kbRestorePage(page.id), 'Restored as a draft'); }}><RotateCcw />Restore as Draft</button>}
                        </div>
                      </AnchoredMenu>
                    </>
                  )}
                </span>
              </div>

              <Blocks doc={doc} embeds={page.embeds} />

              {page.related.length > 0 && (
                <>
                  <h2 id="related" style={{ fontFamily: "'Figtree','Inter',sans-serif", fontSize: 20, margin: '28px 0 10px' }}>Related Pages</h2>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {page.related.map((r) => <button key={r.id} type="button" className="kb-btn" onClick={() => goKb('page', r.id)}><TypeChip type={r.page_type} />{r.title}</button>)}
                  </div>
                </>
              )}

              {page.status === 'approved' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 28, padding: '14px 16px', borderRadius: 12, background: 'var(--kb-paper)' }}>
                  <span style={{ fontWeight: 600 }}>Was this page helpful?</span>
                  <button type="button" className={`kb-btn sm${page.feedback.mine === true ? ' on' : ''}`} onClick={() => vote(true)} style={page.feedback.mine === true ? { borderColor: 'var(--kb-green)', color: 'var(--kb-green)' } : {}}><ThumbsUp />Yes</button>
                  <button type="button" className={`kb-btn sm`} onClick={() => vote(false)} style={page.feedback.mine === false ? { borderColor: '#dc2626', color: '#dc2626' } : {}}><ThumbsDown />No</button>
                  {(page.feedback.helpful + page.feedback.not_helpful) > 0 && <span className="kb-meta">{page.feedback.helpful} of {page.feedback.helpful + page.feedback.not_helpful} said yes</span>}
                  <button type="button" className="kb-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setFlag(true)}><Flag />Report a Problem</button>
                </div>
              )}
              <div style={{ marginTop: 20 }}><SignBlock page={page} onSigned={(so) => setPage((p) => ({ ...p, signoff: so }))} /></div>
              <Comments page={page} me={me} />
            </article>

            <aside className="kb-rail" style={{ flex: '1 1 240px', maxWidth: 300 }}>
              <section className="kb-card">
                <h3 className="kb-h3" style={{ marginBottom: 10 }}>Details</h3>
                <dl className="kb-kv">
                  <dt>Owner</dt><dd>{page.owner_name || '-'}</dd>
                  {page.reviewer_email && <><dt>Reviewer</dt><dd>{page.reviewer_name || page.reviewer_email}</dd></>}
                  <dt>Collection</dt><dd>{page.collection?.map((c) => c.name).join(' / ') || 'None'}</dd>
                  {page.published_at && <><dt>Published</dt><dd>{fmtDate(page.published_at)}</dd></>}
                  {page.review?.next_review && <><dt>Review due</dt><dd style={{ color: page.review.stale ? '#dc2626' : 'inherit' }}>{fmtDate(page.review.next_review)}</dd></>}
                  {page.tags.length > 0 && <><dt>Tags</dt><dd>{page.tags.join(', ')}</dd></>}
                  {page.require_ack && <><dt>Signing</dt><dd>{page.audience_text}{page.signing === 'nexus_sign' ? ' · Nexus Sign' : ''}</dd></>}
                  <dt>Reading</dt><dd>about {plural(page.reading_minutes, 'minute')}</dd>
                </dl>
                {page.open_revision && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Chip color="#b45309">Revision {page.open_revision.status.replace('_', ' ')} · {page.open_revision.author_name}</Chip>
                    <a href="#rev" style={{ fontSize: 13 }} onClick={(e) => { e.preventDefault(); goKb(page.open_revision.status === 'in_review' ? 'revision' : 'editor', page.open_revision.status === 'in_review' ? page.open_revision.id : page.id); }}>{page.open_revision.status === 'in_review' ? 'See what is changing' : 'Open the revision'}</a>
                  </div>
                )}
              </section>
              {page.versions.length > 0 && (
                <section className="kb-card">
                  <h3 className="kb-h3" style={{ marginBottom: 8 }}>Version History</h3>
                  <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {page.versions.slice(0, 6).map((v) => (
                      <div key={v.id}><a href="#v" onClick={(e) => { e.preventDefault(); api.kbPageVersion(page.id, v.id).then(setVersionView).catch((er) => toast(errText(er), 'err')); }}><b>{v.version}</b></a> <span className="kb-meta">{fmtDate(v.published_at)} · {v.author_name}</span>
                        {v.change_note && <div className="kb-meta">{v.change_note}</div>}</div>
                    ))}
                  </div>
                </section>
              )}
              {page.used_in_courses.length > 0 && (
                <section className="kb-card">
                  <h3 className="kb-h3" style={{ marginBottom: 8 }}>Used in Training</h3>
                  {page.used_in_courses.map((c) => <a key={c.id} href="#c" onClick={(e) => { e.preventDefault(); goKb('course', c.id); }} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, color: 'var(--kb-ink)', fontWeight: 500 }}><Chip color="#1e7b4e">Course</Chip>{c.title}</a>)}
                </section>
              )}
              {page.page_type === 'sop' && page.status === 'approved' && (
                <section className="kb-card">
                  <h3 className="kb-h3" style={{ marginBottom: 8 }}>Done as a Task</h3>
                  <div style={{ fontSize: 13 }}>{page.task_runs ? `${plural(page.task_runs, 'time')} so far` : 'Not yet started as a task'}</div>
                  {page.task_runs > 0 && <a href="#t" style={{ display: 'inline-block', marginTop: 6, fontSize: 13 }} onClick={(e) => { e.preventDefault(); goKb('tasks', page.id); }}>See the tasks</a>}
                </section>
              )}
              {page.legacy_only && me?.can_manage && <Banner kind="blue">This page is shown from its old form fields. Run the migration under Manage to convert it for editing.</Banner>}
            </aside>
          </div>

          {task && <StartTaskModal page={page} onClose={() => setTask(false)} />}
          {flag && <FlagModal page={page} onClose={() => setFlag(false)} />}
          {versionView && (
            <Modal title={`${page.title} · Version ${versionView.version}`} onClose={() => setVersionView(null)}>
              <div className="kb">
                <div className="kb-meta" style={{ marginBottom: 10 }}>Published {fmtDate(versionView.published_at)} by {versionView.author_name}{versionView.change_note ? ` · ${versionView.change_note}` : ''}. Compared with the current page: {versionView.diff.added.length} added, {versionView.diff.removed.length} removed since.</div>
                <Blocks doc={versionView.blocks} embeds={page.embeds} />
              </div>
            </Modal>
          )}
          {original && (
            <Modal title="Original Source" onClose={() => setOriginal(null)}>
              <div className="kb">
                <div className="kb-meta" style={{ marginBottom: 10 }}>{original.original_title ? `Imported as "${original.original_title}". ` : ''}The raw text as it was first brought in, kept forever and never edited.</div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13.5, background: 'var(--kb-paper)', padding: 14, borderRadius: 10 }}>{original.original_content || '(no original text was stored)'}</pre>
              </div>
            </Modal>
          )}
        </div>
      )}
    </AsyncSection>
  );
}

export { subFor };
