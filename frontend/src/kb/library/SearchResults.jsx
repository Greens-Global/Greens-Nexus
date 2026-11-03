// Search and Ask Nexus. The sub is "search:<q>"; "search:?<q>" asks.
import { useEffect, useState } from 'react';
import { Sparkles, ThumbsUp, ThumbsDown, ShieldCheck } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import PageRow from '../components/PageCard';
import RequestPageModal from '../components/RequestPageModal';
import { SearchBox } from './Home';
import { PAGE_TYPES, goKb, fmtDate } from '../lib';
import { detectCrisis, showCrisisSupport } from '../../lib/crisisSupport';

export default function SearchResults({ query, me }) {
  const asking = query.startsWith('?');
  const q = asking ? query.slice(1) : query;
  const [type, setType] = useState('');
  const [department, setDepartment] = useState('');   // Applies To filter (Neil, 11/02/2026)
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
    api.kbSearch(q, { type, department }).then((r) => { if (live) setRes(r); }).catch((e) => { if (live) setErr(e.message || 'Search failed'); });
    return () => { live = false; };
  }, [q, type, department]);
  useEffect(() => { api.kbCollections().then(setCollections).catch(() => {}); }, []);
  useEffect(() => {
    if (!asking) { setAnswer(null); return undefined; }
    let live = true;
    // Crisis support (11/02/2026): no answer for a question that expresses
    // suicidal intent or self-harm - the resources card instead. The server
    // makes the same check (crisis_support.py).
    if (detectCrisis(q)) {
      setAskBusy(false); setAnswer({ answer: '', sources: [], crisis: true });
      showCrisisSupport();
      return () => { live = false; };
    }
    setAskBusy(true); setAnswer(null); setVote('');
    api.kbAsk(q).then((a) => {
      if (!live) return;
      if (a?.crisis) showCrisisSupport({ resources: a.crisis.resources });
      setAnswer(a?.crisis ? { answer: '', sources: [], crisis: true } : a);
    }).catch((e) => { if (live) setAnswer({ answer: '', sources: [], offline: true, error: e.message }); }).finally(() => { if (live) setAskBusy(false); });
    return () => { live = false; };
  }, [asking, q]);

  const results = res?.results || [];
  const departments = [...new Set(collections.map((c) => c.department).filter(Boolean))].sort();
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
        {departments.length > 0 && (
          <select className="kb-select" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department" style={{ width: 'auto', minHeight: 32, padding: '4px 28px 4px 10px', fontSize: 13 }}>
            <option value="">Every department</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
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
                  <button key={s.id} type="button" className="kb-btn sm" onClick={() => goKb('page', s.id)} title={[s.verified_at ? `Verified ${fmtDate(s.verified_at)}` : '', s.why].filter(Boolean).join(' · ')}>
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
          {!askBusy && answer?.crisis && (
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>If you are thinking about suicide or hurting yourself, you are not alone. In the US call or text 988; in India call Tele-MANAS at 14416. In an emergency call 911 (US) or 112 (India).</div>
          )}
          {!askBusy && answer && !answer.crisis && !answer.answer && (
            <div className="kb-meta">{answer.offline ? (answer.error || 'Nexus is not available right now. The search results below still work.') : 'The published pages do not answer this.'}
              {' '}<a href="#req" onClick={(e) => { e.preventDefault(); setRequest(true); }}>Request a page for it</a>.</div>
          )}
          {!askBusy && answer && !answer.answer && answer.sources?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <span className="kb-meta">Start with:</span>
              {answer.sources.map((s) => (
                <button key={s.id} type="button" className="kb-btn sm" onClick={() => goKb('page', s.id)} title={s.why || ''}>{s.code || s.title}{s.why ? <span className="kb-meta" style={{ fontWeight: 400 }}> · {s.why}</span> : null}</button>
              ))}
            </div>
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
      {res?.linked?.length > 0 && (
        <section className="kb-card">
          <div className="kb-title" style={{ fontSize: 14, marginBottom: 2 }}>Linked to These Results</div>
          <div className="kb-meta" style={{ marginBottom: 8 }}>Pages the best matches point to, embed, are taught with or share a department with. They did not match your words.</div>
          {res.linked.map((p) => <PageRow key={p.id} page={p} compact right={<span className="kb-meta" style={{ fontSize: 12, maxWidth: 260, textAlign: 'right' }}>{p.why}</span>} />)}
        </section>
      )}
      {res && results.length > 0 && (
        <div className="kb-meta">Not what you needed? <a href="#req" onClick={(e) => { e.preventDefault(); setRequest(true); }}>Request a page</a>.</div>
      )}
      {request && <RequestPageModal collections={collections} initialQuery={q} onClose={() => setRequest(false)} />}
    </div>
  );
}
