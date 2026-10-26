// Search and Ask Nexus. The sub is "search:<q>"; "search:?<q>" asks.
import { useEffect, useState } from 'react';
import { Sparkles, ThumbsUp, ThumbsDown, ShieldCheck } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import PageRow from '../components/PageCard';
import RequestPageModal from '../components/RequestPageModal';
import { SearchBox } from './Home';
import { PAGE_TYPES, goKb, fmtDate } from '../lib';

export default function SearchResults({ query, me }) {
  const asking = query.startsWith('?');
  const q = asking ? query.slice(1) : query;
  const [type, setType] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [answer, setAnswer] = useState(null);
  const [askBusy, setAskBusy] = useState(false);
  const [vote, setVote] = useState('');
  const [request, setRequest] = useState(false);
  const [collections, setCollections] = useState([]);

  useEffect(() => {
    let live = true;
    setRes(null); setErr('');
    api.kbSearch(q, { type }).then((r) => { if (live) setRes(r); }).catch((e) => { if (live) setErr(e.message || 'Search failed'); });
    return () => { live = false; };
  }, [q, type]);
  useEffect(() => { api.kbCollections().then(setCollections).catch(() => {}); }, []);
  useEffect(() => {
    if (!asking) { setAnswer(null); return undefined; }
    let live = true;
    setAskBusy(true); setAnswer(null); setVote('');
    api.kbAsk(q).then((a) => { if (live) setAnswer(a); }).catch((e) => { if (live) setAnswer({ answer: '', sources: [], offline: true, error: e.message }); }).finally(() => { if (live) setAskBusy(false); });
    return () => { live = false; };
  }, [asking, q]);

  const results = res?.results || [];
  return (
    <div className="kb-page">
      <div style={{ maxWidth: 860 }}>
        <SearchBox initial={q} onSearch={(v) => goKb('search', v)} onAsk={(v) => goKb('search', `?${v}`)} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div className="kb-pills">
          <button type="button" className={`kb-pill${type === '' ? ' on' : ''}`} onClick={() => setType('')}>All</button>
          {Object.values(PAGE_TYPES).map((t) => <button key={t.key} type="button" className={`kb-pill${type === t.key ? ' on' : ''}`} onClick={() => setType(t.key)}>{t.label}</button>)}
        </div>
        {res && <span className="kb-meta" style={{ marginLeft: 'auto' }}>{res.total} result{res.total === 1 ? '' : 's'} for "{q}"</span>}
      </div>
      {res?.also_matched?.length > 0 && <div className="kb-meta">Also matched: {res.also_matched.join(', ')}</div>}
      {res?.did_you_mean && <div className="kb-meta">Did you mean <a href="#dym" onClick={(e) => { e.preventDefault(); goKb('search', res.did_you_mean); }}><b>{res.did_you_mean}</b></a>?</div>}

      {(asking || answer) && (
        <section className="kb-card" style={{ borderLeft: '3px solid var(--kb-green)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><Sparkles size={16} style={{ color: 'var(--kb-green)' }} /><span className="kb-title">Nexus</span><span className="kb-meta">answers only from published pages</span></div>
          {askBusy && <div className="kb-meta">Reading the pages that match...</div>}
          {!askBusy && answer && answer.answer && (
            <>
              <div style={{ fontSize: 15, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{answer.answer}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 }}>
                <span className="kb-meta">Sources:</span>
                {answer.sources.map((s, i) => (
                  <button key={s.id} type="button" className="kb-btn sm" onClick={() => goKb('page', s.id)} title={s.verified_at ? `Verified ${fmtDate(s.verified_at)}` : ''}>
                    [{i + 1}] {s.verified_at && <ShieldCheck size={13} style={{ color: 'var(--kb-green)' }} />}{s.code || s.title}
                  </button>
                ))}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }} className="kb-meta">Helpful?
                  <button type="button" className={`kb-ibtn${vote === 'up' ? ' on' : ''}`} style={{ width: 28, height: 28 }} aria-label="Helpful" onClick={() => setVote('up')}><ThumbsUp size={14} /></button>
                  <button type="button" className={`kb-ibtn${vote === 'down' ? ' on' : ''}`} style={{ width: 28, height: 28 }} aria-label="Not helpful" onClick={() => setVote('down')}><ThumbsDown size={14} /></button>
                </span>
              </div>
              {!answer.grounded && <div className="kb-meta" style={{ marginTop: 8 }}>Nexus was not sure the pages cover this. Read the sources before you act on it.</div>}
            </>
          )}
          {!askBusy && answer && !answer.answer && (
            <div className="kb-meta">{answer.offline ? (answer.error || 'Nexus is not available right now. The search results below still work.') : 'The published pages do not answer this.'}
              {' '}<a href="#req" onClick={(e) => { e.preventDefault(); setRequest(true); }}>Request a page for it</a>.</div>
          )}
        </section>
      )}

      <AsyncSection loading={!res && !err} error={err ? new Error(err) : null} errorMessage={err} isEmpty={!!res && results.length === 0}
        emptyContent={(
          <div className="kb-card soft kb-empty">
            <div style={{ fontWeight: 600, color: 'var(--kb-ink)', marginBottom: 6 }}>Nothing matches "{q}"</div>
            <div style={{ marginBottom: 12 }}>Try other words, or ask Nexus, which reads every published page.</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {!asking && <button type="button" className="kb-btn pri" onClick={() => goKb('search', `?${q}`)}><Sparkles />Ask Nexus</button>}
              <button type="button" className="kb-btn" onClick={() => setRequest(true)}>Request a Page</button>
            </div>
          </div>
        )}>
        <section className="kb-card">
          {results.map((p) => <PageRow key={p.id} page={p} snippet={p.snippet} />)}
        </section>
      </AsyncSection>
      {res && results.length > 0 && (
        <div className="kb-meta">Not what you needed? <a href="#req" onClick={(e) => { e.preventDefault(); setRequest(true); }}>Request a page</a>.</div>
      )}
      {request && <RequestPageModal collections={collections} initialQuery={q} onClose={() => setRequest(false)} />}
    </div>
  );
}
