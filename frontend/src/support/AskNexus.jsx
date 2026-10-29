// Ask Nexus (Help Center, Oct 2026): one answer to a question, written from
// the Nexus guide and the Knowledge Base, with the sources it used. DOCS ONLY
// - it never reads the person's own records (the full AI Assistant stays
// hidden, Neil Sep 21 2026). When the sources do not cover it, it says so and
// File a Ticket is right there, with the question already in the form.
//
// Used in the Help panel (the "?" in the header) and under the Help Center
// page's search bar. Loaded lazily by both: it brings the guide with it.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Sparkles, BookOpen, FileText, Ticket as TicketIcon, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { guideFor, openSource } from './askNexusSources';
import { logHelpSearch } from './helpLog';
import HelpFeedback from './HelpFeedback';

const BRAND = 'var(--wk-brand, #2b45e1)';

// **bold** and [n] citations inside one line of the answer.
function Inline({ text, cite }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\[\d+\])/g).filter(Boolean);
  return parts.map((p, i) => {
    const b = /^\*\*([^*]+)\*\*$/.exec(p);
    if (b) return <strong key={i}>{b[1]}</strong>;
    const c = /^\[(\d+)\]$/.exec(p);
    if (c) {
      const s = cite(Number(c[1]));
      if (!s) return null;   // a number that is not among the sources it kept
      return (
        <button key={i} type="button" className="nx-ask-cite" onClick={() => openSource(s)} title={s.title}
          aria-label={`Source: ${s.title}`}
          style={{ border: 'none', background: 'rgba(43,69,225,0.10)', color: BRAND, borderRadius: 4, padding: '0 4px', margin: '0 1px',
            fontSize: 10.5, fontWeight: 700, cursor: 'pointer', verticalAlign: 'super', lineHeight: 1.2, fontFamily: 'inherit' }}>
          {s.label}
        </button>
      );
    }
    return <Fragment key={i}>{p}</Fragment>;
  });
}

/** Paragraphs, "1." steps and "-" bullets - what the answer prompt asks for. */
function AnswerText({ text, cite }) {
  const blocks = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { blocks.push({ kind: 'gap' }); continue; }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const kind = ol ? 'ol' : ul ? 'ul' : 'p';
    const body = ol ? ol[1] : ul ? ul[1] : line;
    const last = blocks[blocks.length - 1];
    if ((kind === 'ol' || kind === 'ul') && last?.kind === kind) last.items.push(body);
    else if (kind === 'p') blocks.push({ kind, text: body });
    else blocks.push({ kind, items: [body] });
  }
  const p = { margin: '0 0 8px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink)' };
  return blocks.map((b, i) => {
    if (b.kind === 'gap') return null;
    if (b.kind === 'p') return <p key={i} style={p}><Inline text={b.text} cite={cite} /></p>;
    const List = b.kind === 'ol' ? 'ol' : 'ul';
    return (
      <List key={i} style={{ ...p, paddingLeft: 20, display: 'grid', gap: 4 }}>
        {b.items.map((it, j) => <li key={j}><Inline text={it} cite={cite} /></li>)}
      </List>
    );
  });
}

function SourceChip({ s, onOpened }) {
  const Icon = s.kind === 'kb' ? FileText : BookOpen;
  return (
    <button type="button" onClick={() => { onOpened?.(); openSource(s); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '5px 10px', borderRadius: 8,
        border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 12, cursor: 'pointer',
        fontFamily: 'inherit', textAlign: 'left' }}>
      {s.label && <span style={{ fontWeight: 700, color: BRAND }}>{s.label}</span>}
      <Icon size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{s.kind === 'kb' ? 'Knowledge Base' : 'Guide'}</span>
    </button>
  );
}

/**
 * @param {string} question
 * @param {(docId: string) => boolean} allow  the guide pages this person may read (docsAccess)
 * @param {(question: string) => void} onFileTicket  open the ticket form with the question in it
 * @param {() => void} [onOpened]  a source was opened (the Help panel closes itself)
 */
export default function AskNexus({ question, allow, onFileTicket, onOpened, style }) {
  const [res, setRes] = useState(null);       // null = asking
  const [error, setError] = useState('');
  const [n, setN] = useState(0);              // Try Again
  const seq = useRef(0);
  const q = String(question || '').trim();

  useEffect(() => {
    if (!q) return undefined;
    const mine = ++seq.current;
    setRes(null); setError('');
    let guide;
    try { guide = guideFor(q, allow); } catch { guide = []; }
    api.helpAsk(q, guide)
      .then((r) => { if (seq.current === mine) setRes(r || { answer: '', sources: [] }); })
      .catch((e) => {
        if (seq.current !== mine) return;
        setError(e?.status === 429 ? (e.message || 'You have asked a lot in the last hour. Try again later, or file a ticket.')
          : 'Nexus could not answer right now. Try again in a moment, or file a ticket.');
      });
    return undefined;
  }, [q, allow, n]);

  // Sources labeled by the number the answer cites them by.
  const sources = (res?.sources || []).map((s, i) => ({ ...s, label: res?.offline ? '' : String(s.n || i + 1) }));
  const cite = (num) => sources.find((s) => Number(s.n) === num) || null;
  const answered = !!(res && !res.offline && res.answer);
  const notCovered = !!(res && !res.offline && (!res.grounded || !res.answer));
  // The offline fallback is still a question nobody answered.
  useEffect(() => { if (res?.offline) logHelpSearch(q, (res.sources || []).length, 'ask'); }, [res, q]);

  if (!q) return null;
  return (
    <section aria-label="Ask Nexus" aria-busy={!res && !error}
      style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'rgba(43,69,225,0.10)', color: BRAND, flexShrink: 0 }}>
          <Sparkles size={15} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>Ask Nexus</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q}</div>
        </div>
      </div>

      {!res && !error && (
        <div role="status" style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nexus is reading the guides...</div>
          {[92, 78, 60].map((w) => <div key={w} className="hw-skeleton" style={{ height: 10, width: `${w}%`, margin: 0 }} />)}
        </div>
      )}

      {error && (
        <div role="status" style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          {error}
          <button type="button" onClick={() => setN((x) => x + 1)}
            style={{ marginLeft: 8, border: 'none', background: 'none', color: BRAND, fontWeight: 600, cursor: 'pointer', padding: 0, font: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <RotateCcw size={12} /> Try Again
          </button>
        </div>
      )}

      {res?.offline && (
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          {sources.length ? 'Nexus cannot write an answer right now. These may help:' : 'Nexus cannot write an answer right now, and nothing in the guides matched.'}
        </div>
      )}

      {answered && <div><AnswerText text={res.answer} cite={cite} /></div>}
      {res && !res.offline && !res.answer && (
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>The guides and the Knowledge Base do not cover this yet.</div>
      )}

      {sources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!res?.offline && <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>Sources</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {sources.map((s) => <SourceChip key={`${s.kind}:${s.id}`} s={s} onOpened={onOpened} />)}
          </div>
        </div>
      )}

      {answered && <HelpFeedback kind="answer" question={q} title={q} style={{ paddingTop: 2 }} />}

      {(res || error) && onFileTicket && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1, minWidth: 140 }}>
            {notCovered || error || res?.offline ? 'Our support team can help with this.' : 'Still need help?'}
          </span>
          <button type="button" className={notCovered || error ? 'primary-btn' : 'secondary-btn'} onClick={() => onFileTicket(q)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12.5 }}>
            <TicketIcon size={14} /> File a Ticket
          </button>
        </div>
      )}
    </section>
  );
}

