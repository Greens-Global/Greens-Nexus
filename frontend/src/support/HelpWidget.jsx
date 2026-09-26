// The Help widget: a messenger-style panel anchored bottom-right (full screen
// on phones), opened by the "?" in the header (HelpMenu.jsx owns the button,
// the "?" shortcut, Esc and the open/close state; this file is the panel).
//
//   Home      greeting, then Search for Help / Ask a Question / What's New,
//             and the guide page for the screen you are on.
//   Messages  your own tickets, newest activity first, and Send Us a Message.
//   Help      one search across the Nexus guide, Knowledge Base documents and
//             Knowledge Base courses (docsSearch.js - deterministic, local).
//             Guide answers open right here; documents and courses open in
//             the Knowledge Base.
//
// Self-service comes first: Ask a Question and Send Us a Message open the
// ticket form, which itself suggests articles before anything is submitted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import {
  X, Search, ChevronRight, ChevronLeft, ArrowUpRight, Home as HomeIcon, MessageSquare, CircleHelp,
  BookOpen, ListChecks, Layers, Lightbulb, ShieldCheck, FileText, GraduationCap, Send, Ticket as TicketIcon,
  Compass,
} from 'lucide-react';
import { api } from '../api';
import { DOCS, DOC_GROUPS } from './docsContent';
import { searchDocs, docForView, walkthroughAnchor, featureAnchor, SOURCE_LABEL } from './docsSearch';
import { useDocAccess } from './docsAccess';
import { useKbCorpus } from './kbCorpus';
import { openDoc } from './openDoc';
import { openKb } from './openKb';
import { setPendingOpen } from '../lib/pendingOpen';
import { formatDate } from '../lib/datetime';
import { TICKET_STATUS_META, ticketNoShort } from '../tickets/ticketMeta';

const HELP_TABS = [
  { key: 'home', label: 'Home', Icon: HomeIcon },
  { key: 'messages', label: 'Messages', Icon: MessageSquare },
  { key: 'help', label: 'Help', Icon: CircleHelp },
];

const KIND_ICON = {
  module: BookOpen, walkthrough: ListChecks, feature: Layers, tip: Lightbulb, manager: ShieldCheck,
  'kb-doc': FileText, course: GraduationCap,
};
const KIND_LABEL = { module: 'Guide', walkthrough: 'How To', feature: 'Feature', tip: 'Tip', manager: 'For Managers' };
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const nav = (view, sub) => window.dispatchEvent(
  new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));

// A guide page as an article the widget can show (same shape as a search result).
const moduleArticle = (d) => ({ source: 'guide', kind: 'module', docId: d.id, docName: d.name, title: d.name, anchor: null, body: [] });

// ── Home ────────────────────────────────────────────────────────────────────
function HomeTab({ firstName, pageDoc, onSearch, onAsk, onWhatsNew, onOpenArticle, onClose }) {
  return (
    <div className="hw-scroll">
      <div className="hw-hero">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="dk-mark hw-mark" aria-hidden="true">N</div>
          <button type="button" className="hw-close hw-close-light" onClick={onClose} aria-label="Close help"><X size={18} /></button>
        </div>
        <div className="hw-hello">Hi {firstName || 'there'}</div>
        <h2 className="hw-title">How can we help?</h2>
      </div>
      <div className="hw-cards">
        <button type="button" className="hw-card" onClick={onSearch}>
          <span className="hw-card-text"><span className="hw-card-title">Search for Help</span></span>
          <Search size={18} style={{ color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }} />
        </button>
        <button type="button" className="hw-card" onClick={onAsk}>
          <span className="hw-card-text">
            <span className="hw-card-title">Ask a Question</span>
            <span className="hw-card-sub">Our support team can help</span>
          </span>
          <ChevronRight size={18} style={{ color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }} />
        </button>
        {onWhatsNew && (
          <button type="button" className="hw-card" onClick={onWhatsNew}>
            <span className="hw-card-text"><span className="hw-card-title">What's New in Nexus</span></span>
            <ArrowUpRight size={18} style={{ color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }} />
          </button>
        )}
        {pageDoc && (
          <button type="button" className="hw-card hw-card-quiet" onClick={() => onOpenArticle(moduleArticle(pageDoc))}>
            <Compass size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <span className="hw-card-text">
              <span className="hw-card-title" style={{ fontSize: 13 }}>Help for This Page</span>
              <span className="hw-card-sub">{pageDoc.name}: {pageDoc.tagline}</span>
            </span>
            <ChevronRight size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Messages ────────────────────────────────────────────────────────────────
function MessagesTab({ onAsk, onOpenTicket }) {
  const [tickets, setTickets] = useState(null);   // null = loading
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getMyTickets()
      .then((rows) => { if (alive) setTickets(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) { setTickets([]); setFailed(true); } });
    return () => { alive = false; };
  }, []);
  const sorted = useMemo(() => [...(tickets || [])].sort((a, b) =>
    String(b.modifiedAt || b.createdAt || '').localeCompare(String(a.modifiedAt || a.createdAt || ''))), [tickets]);

  return (
    <>
      <div className="hw-scroll hw-pad">
        {tickets === null ? (
          <div aria-busy="true" aria-label="Loading your messages">
            {[0, 1, 2].map((i) => <div key={i} className="hw-skeleton" style={{ height: 58 }} />)}
          </div>
        ) : failed ? (
          <div className="hw-empty">Your messages could not load right now. Try again in a moment.</div>
        ) : sorted.length === 0 ? (
          <div className="hw-empty">
            <MessageSquare size={26} style={{ opacity: 0.45, marginBottom: 8 }} />
            <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>No Messages Yet</div>
            <div>Questions you send to support show up here with their status.</div>
          </div>
        ) : (
          <ul className="hw-list" aria-label="Your tickets">
            {sorted.map((t) => {
              const meta = TICKET_STATUS_META[t.status] || { label: t.status || 'Open', color: 'var(--muted)', tint: 'var(--mist)' };
              return (
                <li key={t.id}>
                  <button type="button" className="hw-row" onClick={() => onOpenTicket(t.id)}>
                    <span className="hw-row-icon"><TicketIcon size={15} /></span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="hw-row-title">{t.subject || 'Untitled ticket'}</span>
                      <span className="hw-row-sub">
                        {[ticketNoShort(t.code), `Updated ${formatDate(t.modifiedAt || t.createdAt, '-')}`].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="hw-status" style={{ color: meta.color, background: meta.tint }}>{meta.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="hw-foot">
        <button type="button" className="primary-btn hw-send" onClick={onAsk}>
          <Send size={15} /> Send Us a Message
        </button>
      </div>
    </>
  );
}

// ── Help: search + browse ───────────────────────────────────────────────────
function ResultRow({ r, onPick }) {
  const Icon = KIND_ICON[r.kind] || BookOpen;
  const where = r.source === 'guide'
    ? (r.kind === 'module' ? (r.snippet || r.group) : `${KIND_LABEL[r.kind] || 'Guide'} in ${r.docName}`)
    : (r.snippet || r.meta);
  return (
    <li>
      <button type="button" className="hw-row" onClick={() => onPick(r)}>
        <span className="hw-row-icon"><Icon size={15} /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="hw-row-title">{r.kind === 'tip' ? r.body[0] : r.title}</span>
          {where && <span className="hw-row-sub">{where}</span>}
        </span>
        <span className={`hw-source hw-source-${r.source}`}>{SOURCE_LABEL[r.source] || 'Guide'}</span>
      </button>
    </li>
  );
}

function HelpTab({ autoFocus, allowed, allow, query, setQuery, onPick, onOpenArticle }) {
  const inputRef = useRef(null);
  const kb = useKbCorpus(true);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const q = query.trim();
  const results = useMemo(
    () => (q ? searchDocs(query, { limit: 12, perDoc: 3, allow, kb: kb.corpus }) : []),
    [q, query, allow, kb.corpus],
  );

  const gettingStarted = allowed.find((d) => d.id === 'getting-started');
  return (
    <div className="hw-scroll hw-pad">
      <div className="hw-search">
        <Search size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <input ref={inputRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search guides, documents and courses" aria-label="Search for help"
          autoComplete="off" spellCheck={false} />
        {query && (
          <button type="button" className="hw-close" style={{ width: 24, height: 24 }} aria-label="Clear search"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={14} /></button>
        )}
      </div>

      {q && kb.status === 'error' && (
        <div className="hw-note" role="status">Knowledge Base results are unavailable right now. Guide results still work.</div>
      )}
      {q && kb.status === 'loading' && <div className="hw-note">Also searching the Knowledge Base...</div>}

      {q ? (
        results.length ? (
          <ul className="hw-list" aria-label="Help results">
            {results.map((r) => <ResultRow key={r.id} r={r} onPick={onPick} />)}
          </ul>
        ) : (
          <div className="hw-empty">No results for "{q}". Try other words, or ask us from the Home tab.</div>
        )
      ) : (
        <>
          {gettingStarted && (
            <button type="button" className="hw-card hw-card-quiet" style={{ marginBottom: 14 }}
              onClick={() => onOpenArticle(moduleArticle(gettingStarted))}>
              <Compass size={16} style={{ color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }} />
              <span className="hw-card-text">
                <span className="hw-card-title" style={{ fontSize: 13.5 }}>Getting Started</span>
                <span className="hw-card-sub">{gettingStarted.tagline}</span>
              </span>
              <ChevronRight size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            </button>
          )}
          {DOC_GROUPS.map((g) => {
            const items = allowed.filter((d) => d.group === g && d.id !== 'getting-started');
            if (!items.length) return null;
            return (
              <div key={g} style={{ marginBottom: 12 }}>
                <div className="hw-group">{g}</div>
                <ul className="hw-list">
                  {items.map((d) => (
                    <li key={d.id}>
                      <button type="button" className="hw-row hw-row-tight" onClick={() => onOpenArticle(moduleArticle(d))}>
                        <span style={{ flex: 1, minWidth: 0 }}><span className="hw-row-title">{d.name}</span></span>
                        <ChevronRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ── A guide answer, read inside the widget ──────────────────────────────────
function Article({ a, onBack, onOpenArticle, onOpenFull }) {
  const doc = DOCS.find((d) => d.id === a.docId);
  if (!doc) return null;
  let heading = a.title;
  let content;
  if (a.kind === 'module') {
    heading = doc.name;
    content = (
      <>
        <p className="hw-p" style={{ color: 'var(--muted)' }}>{doc.tagline}</p>
        {doc.purpose && <p className="hw-p">{doc.purpose}</p>}
        {doc.walkthroughs?.length > 0 && (
          <>
            <div className="hw-group" style={{ marginTop: 6 }}>Step by Step</div>
            <ul className="hw-list">
              {doc.walkthroughs.map((w) => (
                <li key={w.title}>
                  <button type="button" className="hw-row hw-row-tight"
                    onClick={() => onOpenArticle({ source: 'guide', kind: 'walkthrough', docId: doc.id, docName: doc.name, title: w.title, anchor: walkthroughAnchor(w.title), body: w.steps })}>
                    <ListChecks size={15} style={{ color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0 }}><span className="hw-row-title">{w.title}</span></span>
                    <ChevronRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {doc.features?.length > 0 && (
          <>
            <div className="hw-group" style={{ marginTop: 10 }}>Features</div>
            {doc.features.map((f) => (
              <div key={f.name} className="hw-feature">
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>{f.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{f.desc}</div>
              </div>
            ))}
          </>
        )}
      </>
    );
  } else if (a.kind === 'walkthrough') {
    content = (
      <ol className="hw-steps">
        {(a.body || []).map((s, i) => (
          <li key={i}><span className="hw-step-n">{i + 1}</span><span>{s}</span></li>
        ))}
      </ol>
    );
  } else if (a.kind === 'tip') {
    heading = 'Good To Know';
    content = <p className="hw-p">{a.body?.[0]}</p>;
  } else {
    content = (a.body || []).length > 1
      ? <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>{a.body.map((p) => <li key={p} className="hw-p" style={{ margin: 0 }}>{p}</li>)}</ul>
      : <p className="hw-p">{a.body?.[0]}</p>;
  }
  const fullAnchor = a.kind === 'feature' ? featureAnchor(a.title) : a.anchor;
  return (
    <div className="hw-scroll hw-pad">
      <button type="button" className="hw-back" onClick={onBack}><ChevronLeft size={16} /> Back</button>
      <div className="hw-crumb">{a.kind === 'module' ? doc.group : doc.name}</div>
      <h3 className="hw-article-title">{heading}</h3>
      {content}
      <button type="button" className="secondary-btn hw-full" onClick={() => onOpenFull(doc.id, fullAnchor)}>
        Open in Documentation <ArrowUpRight size={14} />
      </button>
    </div>
  );
}

// ── The widget ──────────────────────────────────────────────────────────────
export default function HelpWidget({ activeView, initialTab = 'home', onTabChange, onWhatsNew, onAsk, onClose }) {
  const { accounts } = useMsal();
  const firstName = (accounts?.[0]?.name || '').trim().split(/\s+/)[0] || '';
  const { allowed, allow } = useDocAccess();
  const [tab, setTabState] = useState(initialTab);
  const [focusSearch, setFocusSearch] = useState(initialTab === 'help');
  const [query, setQuery] = useState('');
  const [trail, setTrail] = useState([]);     // guide articles opened inline, newest last
  const panelRef = useRef(null);

  const setTab = (key, { search = false } = {}) => {
    setTabState(key);
    setTrail([]);
    setFocusSearch(search);
    onTabChange?.(key);
  };

  // Focus lands inside the panel on open, so the keyboard is where the eye is.
  useEffect(() => {
    if (initialTab !== 'help') panelRef.current?.querySelector('.hw-card, .hw-row, .hw-tab')?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pageDoc = useMemo(() => {
    const d = docForView(activeView);
    return d && allow(d.id) ? d : null;
  }, [activeView, allow]);

  const openArticle = (a) => { setTabState('help'); onTabChange?.('help'); setTrail((t) => [...t, a]); };
  const pick = (r) => {
    if (r.source === 'kb') { onClose(false); openKb('doc', r.kbId); return; }
    if (r.source === 'course') { onClose(false); openKb('course', r.kbId); return; }
    openArticle(r);
  };
  const openFull = (docId, anchor) => { onClose(false); openDoc(docId, anchor); };
  const openTicket = (id) => {
    onClose(false);
    nav('support');
    setPendingOpen('ticket', id);
    setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } })), 0);
  };

  // Tab stays inside the panel.
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...(panelRef.current?.querySelectorAll(FOCUSABLE) || [])];
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const article = trail[trail.length - 1];
  const title = tab === 'messages' ? 'Messages' : 'Help';

  return (
    <div className="help-widget" role="dialog" aria-label="Help" ref={panelRef} onKeyDown={onKeyDown}>
      {tab !== 'home' && (
        <div className="hw-bar">
          <div className="dk-mark hw-mark-sm" aria-hidden="true">N</div>
          <div className="hw-bar-title">{title}</div>
          <button type="button" className="hw-close" onClick={() => onClose(true)} aria-label="Close help"><X size={18} /></button>
        </div>
      )}

      {tab === 'home' && (
        <HomeTab firstName={firstName} pageDoc={pageDoc}
          onSearch={() => setTab('help', { search: true })}
          onAsk={() => onAsk?.()}
          onWhatsNew={onWhatsNew ? () => { onClose(false); onWhatsNew(); } : null}
          onOpenArticle={openArticle}
          onClose={() => onClose(true)} />
      )}
      {tab === 'messages' && <MessagesTab onAsk={() => onAsk?.()} onOpenTicket={openTicket} />}
      {tab === 'help' && (article ? (
        <Article key={`${article.docId}-${article.title}-${trail.length}`} a={article}
          onBack={() => setTrail((t) => t.slice(0, -1))}
          onOpenArticle={openArticle} onOpenFull={openFull} />
      ) : (
        <HelpTab autoFocus={focusSearch} allowed={allowed} allow={allow}
          query={query} setQuery={setQuery} onPick={pick} onOpenArticle={openArticle} />
      ))}

      <nav className="hw-tabs" role="tablist" aria-label="Help sections">
        {HELP_TABS.map(({ key, label, Icon }) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={`hw-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key, { search: key === 'help' })}>
            <Icon size={19} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
