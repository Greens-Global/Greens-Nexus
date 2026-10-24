// Review: a new page (review:<id>) or a revision (revision:<rid>).
// Changes Only / Whole Page / Side by Side, the checklist, Approve or
// Request Changes with a note.
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, X, AlertTriangle, Plus, Minus } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import Blocks from '../components/Blocks';
import { TypeChip, Chip, Banner, Av } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDateTime, PAGE_TYPES } from '../lib';

function ChangesOnly({ diff }) {
  if (!diff) return null;
  if (!diff.added.length && !diff.removed.length) return <div className="kb-empty">Nothing changed in the text. The change may be a photo or formatting; use Whole Page.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {diff.removed.map((t, i) => <div key={`r${i}`} style={{ display: 'flex', gap: 8 }}><Minus size={16} style={{ color: '#dc2626', flex: '0 0 auto', marginTop: 3 }} /><span className="kb-diff-del" style={{ whiteSpace: 'pre-wrap' }}>{t}</span></div>)}
      {diff.added.map((t, i) => <div key={`a${i}`} style={{ display: 'flex', gap: 8 }}><Plus size={16} style={{ color: '#16a34a', flex: '0 0 auto', marginTop: 3 }} /><span className="kb-diff-add" style={{ whiteSpace: 'pre-wrap' }}>{t}</span></div>)}
      <div className="kb-meta">{diff.unchanged} block{diff.unchanged === 1 ? '' : 's'} unchanged.</div>
    </div>
  );
}

export default function ReviewView({ kind, id, me }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('changes');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState({});
  const load = () => {
    setErr('');
    (kind === 'revision' ? api.kbRevision(id) : api.kbPage(id)).then(setData).catch((e) => setErr(errText(e)));
  };
  useEffect(() => { setData(null); load(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (kind !== 'revision') setMode('whole'); }, [kind]);

  const isRev = kind === 'revision';
  const page = isRev ? data?.page : data;
  const canReview = isRev ? data?.can_review : data?.can_review;
  const decide = async (decision) => {
    if (decision === 'request_changes' && !note.trim()) { toast('Say what needs to change', 'err'); return; }
    setBusy(true);
    try {
      const out = isRev ? await api.kbReviewRevision(id, { decision, note }) : await api.kbReviewPage(id, { decision, note });
      toast(decision === 'approve' ? `Published as v${isRev ? out.page.version : out.version}` : 'Sent back with your note');
      goKb('page', page.id);
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const CHECKS = [
    'The steps are in the right order and nothing is missing',
    'Safety warnings are where they are needed',
    'Photos show what the words say',
    isRev ? `The change kind is right (${data?.change_kind || 'minor'} → v${data?.next_version || ''})` : 'The type and collection are right',
  ];

  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && page && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="kb-meta">
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => goKb('page', page.id)}><ArrowLeft /></button>
            <a href="#h" onClick={(e) => { e.preventDefault(); goKb('health'); }}>Manage</a> / Review / <b style={{ color: 'var(--kb-ink)' }}>{isRev ? data.title : page.title}</b>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <TypeChip type={page.page_type} />
            <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>{isRev ? data.title : page.title}</h1>
            <Chip color="#b45309">{isRev ? `v${page.version} → v${data.next_version} (${data.change_kind})` : 'New page'}</Chip>
            <span className="kb-meta">from {isRev ? data.author_name : page.owner_name}{(isRev ? data.submitted_at : page.updated_at) ? ` · ${fmtDateTime(isRev ? data.submitted_at : page.updated_at)}` : ''}</span>
          </div>
          {isRev && data.change_note && <Banner kind="blue">Author's note: {data.change_note}</Banner>}
          {isRev && data.resign && <Banner kind="amber" icon={AlertTriangle}>A major version of a signed policy: approving it asks everyone in the audience to sign again.</Banner>}
          {!canReview && (isRev ? data.status === 'in_review' : page.status === 'in_review') && <Banner kind="amber" icon={AlertTriangle}>{data.why_not || 'You are not the reviewer for this page.'} You can read it and leave a comment.</Banner>}
          {(isRev ? data.status !== 'in_review' : page.status !== 'in_review') && <Banner kind="blue">This {isRev ? 'revision' : 'page'} is not in review ({(isRev ? data.status : page.status).replace('_', ' ')}).</Banner>}

          <div className="kb-cols">
            <div className="kb-card kb-article" style={{ padding: '20px 28px 28px' }}>
              {isRev && (
                <div className="kb-seg" style={{ marginBottom: 14 }}>
                  {[['changes', 'Changes Only'], ['whole', 'Whole Page'], ['side', 'Side by Side']].map(([k, l]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
                </div>
              )}
              {mode === 'changes' && <ChangesOnly diff={data.diff} />}
              {mode === 'whole' && <Blocks doc={isRev ? data.blocks : page.blocks} embeds={page.embeds} />}
              {mode === 'side' && (
                <div className="kb-diff-row">
                  <div><div className="kb-label" style={{ marginBottom: 8 }}>Live v{page.version}</div><div style={{ fontSize: 14 }}><Blocks doc={data.live_blocks} embeds={page.embeds} /></div></div>
                  <div><div className="kb-label" style={{ marginBottom: 8 }}>Proposed v{data.next_version}</div><div style={{ fontSize: 14 }}><Blocks doc={data.blocks} embeds={page.embeds} /></div></div>
                </div>
              )}
              {(data.comments || page.comments || []).length > 0 && (
                <div style={{ marginTop: 24 }}>
                  <h3 className="kb-h3" style={{ marginBottom: 8 }}>Conversation</h3>
                  {(data.comments || page.comments).map((c) => <div key={c.id} className="kb-cmt"><Av name={c.author_name} email={c.author_email} /><div className="kb-grow"><div><b>{c.author_name}</b> <span className="kb-meta">{fmtDateTime(c.created_at)}</span></div><div style={{ fontSize: 14 }}>{c.text}</div></div></div>)}
                </div>
              )}
            </div>
            <aside className="kb-rail" style={{ flex: '1 1 280px', maxWidth: 340 }}>
              <section className="kb-card">
                <h3 className="kb-h3" style={{ marginBottom: 10 }}>Decision</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                  <label className="kb-check" style={{ fontSize: 13, color: 'var(--kb-dim)' }}><input type="checkbox" checked readOnly />Reviewer is not the author{canReview ? '' : ' (you are, or not the reviewer)'}</label>
                  {CHECKS.map((c) => <label key={c} className="kb-check" style={{ fontSize: 13 }}><input type="checkbox" checked={!!checks[c]} onChange={(e) => setChecks({ ...checks, [c]: e.target.checked })} />{c}</label>)}
                </div>
                <textarea className="kb-textarea" style={{ minHeight: 80 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the author. Required when you request changes." disabled={!canReview} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  <button type="button" className="kb-btn pri" disabled={!canReview || busy} onClick={() => decide('approve')}><Check />Approve and Publish v{isRev ? data.next_version : '1.0'}</button>
                  <button type="button" className="kb-btn" disabled={!canReview || busy} onClick={() => decide('request_changes')}><X />Request Changes</button>
                </div>
                <div className="kb-meta" style={{ marginTop: 10 }}>Who sees it after approval: everyone in the company wall{page.require_ack ? ', and the audience is asked to sign' : ''}.</div>
              </section>
              <section className="kb-card">
                <h3 className="kb-h3" style={{ marginBottom: 8 }}>About This {PAGE_TYPES[page.page_type]?.label || 'Page'}</h3>
                <dl className="kb-kv">
                  <dt>Owner</dt><dd>{page.owner_name}</dd>
                  <dt>Reviewer</dt><dd>{isRev ? (data.reviewer_name || 'Collection owner') : (page.reviewer_name || page.reviewer_email || 'Collection owner')}</dd>
                  <dt>Collection</dt><dd>{page.collection?.map((c) => c.name).join(' / ') || 'None'}</dd>
                  {page.code && <><dt>Code</dt><dd>{page.code}</dd></>}
                </dl>
              </section>
            </aside>
          </div>
        </div>
      )}
    </AsyncSection>
  );
}
