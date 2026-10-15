// Support -> Documentation tab: a plain-English guide to every Nexus module.
//
// Content lives in docsContent.js (one entry per left-nav module); the
// pictures are drawn wireframes from DocShots.jsx, not captured screenshots.
// Layout: a grouped module index on the left (a dropdown on phones), the
// selected module's article on the right. Each article reads top to bottom:
// what it is for, a picture, step-by-step walkthroughs (every step is one
// action, so the count on each card is the click count), every feature, what
// managers/admins get, and tips.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, ArrowUpRight, ChevronLeft, ChevronRight, CheckCircle2, MousePointerClick,
  ShieldCheck, Lightbulb, MapPin, UserCheck, BookOpen, X, Rocket,
  Sparkles, LayoutDashboard, Contact, MonitorDot, CalendarClock, CheckSquare, HardDrive, Ticket,
  FileText, Monitor, HardHat, Store, Package, Home, Calculator, Landmark, Users,
  Megaphone, Gauge, KeyRound, HelpCircle, Settings,
} from 'lucide-react';
import { DOCS, DOC_GROUPS, ROLE_TIERS, ACCESS_LEVELS } from './docsContent';
import DocShot, { shotLegend } from './DocShots';
import { useDocAccess } from './docsAccess';
import { searchDocs, sectionDomId, walkthroughAnchor, featureAnchor, TIPS_ANCHOR, MANAGER_ANCHOR } from './docsSearch';
import { DOCS_OPEN_EVENT, PENDING_DOCS_KIND, decodeDocTarget } from './openDoc';
import { takePendingOpen } from '../lib/pendingOpen';
import { SkeletonBlocks } from '../components/AsyncState';

// The Implementation Guide is part of Documentation (Neil, Oct 13 2026:
// "technically it is all of documentation"). Administrators get a
// Module Guides | Implementation Guide switch in the header (Pranshu, Oct 15
// 2026: a row in the index was too easy to miss), and the guide takes the
// full width. Lazy: only its readers load it.
const ImplementationGuide = lazy(() => import('./ImplementationGuide'));

const ICONS = {
  Sparkles, LayoutDashboard, Contact, MonitorDot, CalendarClock, CheckSquare, HardDrive, Ticket,
  BookOpen, FileText, Monitor, HardHat, Store, Package, Home, Calculator, Landmark,
  Users, Megaphone, Gauge, KeyRound, HelpCircle, Settings,
};

const BRAND = 'var(--wk-brand, #2b45e1)';
const LAST_KEY = 'nexus-support-docs-last';

// Everything searchable about an entry, lowercased once.
const haystack = (d) => [
  d.name, d.tagline, d.purpose, ...(d.gains || []),
  ...(d.walkthroughs || []).flatMap((w) => [w.title, ...w.steps]),
  ...(d.features || []).flatMap((f) => [f.name, f.desc]),
  ...(d.manager?.points || []), ...(d.tips || []),
].join(' ').toLowerCase();
const INDEX = DOCS.map((d) => ({ id: d.id, text: haystack(d) }));

function readLast() {
  try { const v = localStorage.getItem(LAST_KEY); return DOCS.some((d) => d.id === v) ? v : null; } catch { return null; }
}
function writeLast(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* private window - fine */ }
}

function SectionTitle({ children, icon: Icon }) {
  return (
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', fontSize: 15, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
      {Icon && <Icon size={16} style={{ color: BRAND }} />}{children}
    </h3>
  );
}

function StepNumber({ n }) {
  return (
    <span style={{
      flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: BRAND, color: '#fff',
      fontSize: 11.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
    }}>{n}</span>
  );
}

function Walkthrough({ w, id }) {
  return (
    <div id={id} className="docs-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 90 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, fontWeight: 700, fontSize: 14, color: 'var(--ink)', lineHeight: 1.35 }}>{w.title}</div>
        <span title="Each step is one action" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 700,
          color: BRAND, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 9px',
        }}>
          <MousePointerClick size={12} /> {w.steps.length} {w.steps.length === 1 ? 'Step' : 'Steps'}
        </span>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {w.steps.map((s, i) => (
          <li key={i} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}>
            <StepNumber n={i + 1} /><span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Article({ doc, onPrev, onNext, prev, next }) {
  const Icon = ICONS[doc.icon] || BookOpen;
  const legend = shotLegend(doc.shot);
  const openModule = () => window.dispatchEvent(new CustomEvent('nexus:navigate', {
    detail: doc.sub ? { view: doc.view, sub: doc.sub } : { view: doc.view },
  }));

  return (
    <article id={sectionDomId(doc.id)} style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0, scrollMarginTop: 80 }}>
      {/* Header */}
      <header style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 13, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: BRAND, color: '#fff', boxShadow: '0 6px 18px rgba(43,69,225,.25)',
        }}><Icon size={23} /></div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{doc.group}</div>
          <h2 style={{ margin: '2px 0 4px', fontSize: 24, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>{doc.name}</h2>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>{doc.tagline}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <span className="docs-chip"><MapPin size={12} /> {doc.where}</span>
            <span className="docs-chip"><UserCheck size={12} /> {doc.access}</span>
          </div>
        </div>
        {doc.view && (
          <button type="button" className="primary-btn" onClick={openModule} style={{ flexShrink: 0 }}>
            Open {doc.name} <ArrowUpRight size={14} />
          </button>
        )}
      </header>

      {/* What it is for */}
      <section id={sectionDomId(doc.id, 'sec-purpose')} style={{ scrollMarginTop: 90 }}>
        <SectionTitle icon={BookOpen}>What It Is For</SectionTitle>
        <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.65, color: 'var(--ink)' }}>{doc.purpose}</p>
        {doc.gains?.length > 0 && (
          <div className="docs-card" style={{ background: 'var(--mist)' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>What You Get</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {doc.gains.map((g) => (
                <li key={g} style={{ display: 'flex', gap: 9, fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink)' }}>
                  <CheckCircle2 size={16} style={{ color: 'hsl(var(--color-green))', flexShrink: 0, marginTop: 2 }} />{g}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Picture */}
      {doc.shot && (
        <section id={sectionDomId(doc.id, 'sec-shot')} style={{ scrollMarginTop: 90 }}>
          <SectionTitle>What It Looks Like</SectionTitle>
          <div className="docs-shot">
            <div style={{ minWidth: 0 }}><DocShot shot={doc.shot} /></div>
            {legend.length > 0 && (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 9, alignSelf: 'start' }}>
                {legend.map((l, i) => (
                  <li key={i} style={{ display: 'flex', gap: 9, fontSize: 13, lineHeight: 1.45, color: 'var(--ink)' }}>
                    <StepNumber n={i + 1} /><span>{l}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Simplified illustration. Your screen shows your own data and may have a few more buttons.</div>
        </section>
      )}

      {/* Walkthroughs */}
      {doc.walkthroughs?.length > 0 && (
        <section id={sectionDomId(doc.id, 'sec-steps')} style={{ scrollMarginTop: 90 }}>
          <SectionTitle icon={MousePointerClick}>How To Use It, Step by Step</SectionTitle>
          <div className="docs-grid">
            {doc.walkthroughs.map((w) => <Walkthrough key={w.title} w={w} id={sectionDomId(doc.id, walkthroughAnchor(w.title))} />)}
          </div>
        </section>
      )}

      {/* Features */}
      {doc.features?.length > 0 && (
        <section id={sectionDomId(doc.id, 'sec-features')} style={{ scrollMarginTop: 90 }}>
          <SectionTitle icon={Sparkles}>Every Feature, Explained</SectionTitle>
          <div className="docs-feature-grid">
            {doc.features.map((f) => (
              <div key={f.name} id={sectionDomId(doc.id, featureAnchor(f.name))} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', scrollMarginTop: 90 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>{f.name}</div>
                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>{f.desc}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Roles (Getting Started only) */}
      {doc.id === 'getting-started' && (
        <section id={sectionDomId(doc.id, 'sec-roles')} style={{ scrollMarginTop: 90 }}>
          <SectionTitle icon={Users}>Roles in Nexus</SectionTitle>
          <div className="docs-feature-grid">
            {ROLE_TIERS.map((r, i) => (
              <div key={r.name} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: BRAND, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px' }}>Level {i + 1}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{r.name}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>{r.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '16px 0 8px' }}>Access Levels on a Module</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ACCESS_LEVELS.map((a) => (
              <span key={a.name} className="docs-chip" style={{ fontSize: 12.5 }}><b style={{ color: 'var(--ink)' }}>{a.name}</b> - {a.desc}</span>
            ))}
          </div>
        </section>
      )}

      {/* Managers & admins */}
      {doc.manager?.points?.length > 0 && (
        <section>
          <div id={sectionDomId(doc.id, MANAGER_ANCHOR)} className="docs-card" style={{ borderLeft: `4px solid ${BRAND}`, scrollMarginTop: 90 }}>
            <SectionTitle icon={ShieldCheck}>{doc.manager.title}</SectionTitle>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {doc.manager.points.map((p) => <li key={p} style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink)' }}>{p}</li>)}
            </ul>
          </div>
        </section>
      )}

      {/* Tips */}
      {doc.tips?.length > 0 && (
        <section id={sectionDomId(doc.id, TIPS_ANCHOR)} style={{ scrollMarginTop: 90 }}>
          <SectionTitle icon={Lightbulb}>Good To Know</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {doc.tips.map((t) => (
              <div key={t} style={{ display: 'flex', gap: 10, padding: '10px 14px', borderRadius: 10, background: 'hsla(var(--color-orange),0.08)', border: '1px solid hsla(var(--color-orange),0.2)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}>
                <Lightbulb size={15} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0, marginTop: 2 }} />{t}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Prev / next */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 18, flexWrap: 'wrap' }}>
        {prev ? (
          <button type="button" className="secondary-btn" onClick={onPrev}><ChevronLeft size={14} /> {prev.name}</button>
        ) : <span />}
        {next && (
          <button type="button" className="secondary-btn" onClick={onNext}>{next.name} <ChevronRight size={14} /></button>
        )}
      </nav>
    </article>
  );
}

// ?doc=<id>&section=<anchor> - the "open in a new tab" link from a ticket's
// Suggested Articles (openDoc.js docUrl). Taken once and dropped from the URL
// so a refresh does not keep jumping back to that section.
function takeUrlTarget() {
  try {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get('doc');
    if (!docId) return null;
    const anchor = params.get('section');
    params.delete('doc'); params.delete('section');
    const rest = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    return { docId, anchor };
  } catch { return null; }
}

export default function SupportDocs({ canImplement = false, startOnGuide = false, onBack = null }) {
  // Where to open: a deep link (URL, or a help search that navigated here)
  // wins over the page this person last read.
  const [initialTarget] = useState(() => takeUrlTarget() || decodeDocTarget(takePendingOpen(PENDING_DOCS_KIND)));
  const [activeId, setActiveId] = useState(() => initialTarget?.docId || readLast() || DOCS[0].id);
  // 'modules' | 'guide' - the header switch; /help-center/implementation opens on the guide.
  const [section, setSection] = useState(() => (startOnGuide && canImplement ? 'guide' : 'modules'));
  useEffect(() => { if (startOnGuide && canImplement) setSection('guide'); }, [startOnGuide, canImplement]);
  // Section to scroll to and flash once the page for it has rendered.
  const [flash, setFlash] = useState(() => (initialTarget ? { ...initialTarget, at: Date.now() } : null));

  // Only the modules this person can actually open - the same rule as the
  // left menu (see docsAccess.js). Nobody reads up on a module they cannot see.
  const { allowed } = useDocAccess();
  const [query, setQuery] = useState('');
  const topRef = useRef(null);

  // A help search result picked while this tab is already open.
  useEffect(() => {
    const onOpen = (e) => {
      const { docId, anchor } = e.detail || {};
      if (!docId) return;
      takePendingOpen(PENDING_DOCS_KIND);   // served here; don't replay it on a later mount
      setSection('modules');                // a module page, even if the guide was showing
      setQuery('');
      setActiveId(docId);
      writeLast(docId);
      setFlash({ docId, anchor: anchor || null, at: Date.now() });
    };
    window.addEventListener(DOCS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(DOCS_OPEN_EVENT, onOpen);
  }, []);

  // Scroll to the requested section and outline it briefly, so the eye lands
  // on the answer rather than the top of a long page.
  useEffect(() => {
    if (!flash) return undefined;
    let timer;
    let el = null;
    const raf = requestAnimationFrame(() => {
      el = document.getElementById(sectionDomId(flash.docId, flash.anchor))
        || document.getElementById(sectionDomId(flash.docId));
      if (!el) return;
      el.scrollIntoView?.({ block: flash.anchor ? 'center' : 'start', behavior: 'smooth' });
      if (flash.anchor) {
        el.classList.add('docs-flash');
        timer = setTimeout(() => el.classList.remove('docs-flash'), 2200);
      }
    });
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); el?.classList.remove('docs-flash'); };
  }, [flash]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const words = q.split(/\s+/);
    const hits = new Set(INDEX.filter((e) => words.every((w) => e.text.includes(w))).map((e) => e.id));
    // Plus the help search's matches, so the words people actually use
    // ("pto", "my laptop is broken") find the module whose page answers them.
    for (const r of searchDocs(q, { limit: 12, perDoc: 1 })) hits.add(r.docId);
    return hits;
  }, [q]);
  const visible = matches ? allowed.filter((d) => matches.has(d.id)) : allowed;

  // A remembered page the person can no longer open falls back to the first
  // allowed one; while searching, a page that no longer matches gives way to
  // the first hit.
  const isShown = (id) => (matches && visible.length ? visible : allowed).some((d) => d.id === id);
  const shownId = isShown(activeId) ? activeId : (matches && visible.length ? visible : allowed)[0].id;
  const idx = Math.max(0, allowed.findIndex((d) => d.id === shownId));
  const doc = allowed[idx];
  const onGuide = canImplement && section === 'guide';

  const select = (id) => {
    setActiveId(id);
    writeLast(id);
    topRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };

  // On This Page (Oct 15 2026): the article's own sections, for the right
  // rail on wide screens - the space beside the article used to sit empty.
  const outline = doc ? [
    ['What It Is For', 'sec-purpose'],
    doc.shot && ['What It Looks Like', 'sec-shot'],
    doc.walkthroughs?.length && ['Step by Step', 'sec-steps'],
    doc.features?.length && ['Every Feature', 'sec-features'],
    doc.id === 'getting-started' && ['Roles in Nexus', 'sec-roles'],
    doc.manager?.points?.length && [doc.manager.title, MANAGER_ANCHOR],
    doc.tips?.length && ['Good To Know', TIPS_ANCHOR],
  ].filter(Boolean) : [];
  const jump = (anchor) => document.getElementById(sectionDomId(doc.id, anchor))?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });

  return (
    <div ref={topRef} style={{ display: 'flex', flexDirection: 'column', gap: 16, scrollMarginTop: 80 }}>
      {/* One toolbar (Pranshu, Oct 15 2026: the hero card wasted space): back,
          the title, the Module Guides | Implementation Guide switch for
          administrators, and the module search on the right. */}
      <div className="docs-toolbar">
        {onBack && (
          <button type="button" className="docs-back" onClick={onBack} aria-label="Back to Help Center" title="Back to Help Center">
            <ChevronLeft size={16} />
          </button>
        )}
        <h2 className="docs-title"><BookOpen size={17} style={{ color: BRAND }} /> Documentation</h2>
        {canImplement && (
          <div role="tablist" aria-label="Documentation sections" className="docs-tabs scroll-tabs">
            {[['modules', 'Module Guides', BookOpen], ['guide', 'Implementation Guide', Rocket]].map(([key, label, I]) => {
              const on = section === key;
              return (
                <button key={key} type="button" role="tab" aria-selected={on} onClick={() => setSection(key)} className={`docs-tab${on ? ' active' : ''}`}>
                  <I size={14} /> {label}
                </button>
              );
            })}
          </div>
        )}
        {!onGuide && (
          <div className="docs-search">
            <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
            <input type="text" className="form-input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search e.g. time off, cart, signature…" aria-label="Search the documentation"
              style={{ width: '100%', paddingLeft: 32, paddingRight: 30, fontSize: 13.5 }} />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search"
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {onGuide ? (
        <Suspense fallback={<SkeletonBlocks count={4} height={120} />}>
          <ImplementationGuide />
        </Suspense>
      ) : (
      <div className="docs-layout docs-layout--toc">
        {/* Index - desktop */}
        <aside className="docs-index" aria-label="Modules">
          {visible.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 10px' }}>Nothing matches "{query.trim()}".</div>
          )}
          {DOC_GROUPS.map((g) => {
            const items = visible.filter((d) => d.group === g);
            if (!items.length) return null;
            return (
              <div key={g} style={{ marginBottom: 10 }}>
                <div className="docs-index-group">{g}</div>
                {items.map((d) => {
                  const I = ICONS[d.icon] || BookOpen;
                  const on = d.id === doc.id;
                  return (
                    <button key={d.id} type="button" onClick={() => select(d.id)} className={`docs-index-item${on ? ' active' : ''}`}>
                      <I size={15} style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </aside>

        {/* Index - phones */}
        <select className="form-input docs-index-select" value={doc.id} onChange={(e) => select(e.target.value)} aria-label="Choose a module">
          {DOC_GROUPS.map((g) => {
            const items = visible.filter((d) => d.group === g);
            return items.length ? (
              <optgroup key={g} label={g}>{items.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</optgroup>
            ) : null;
          })}
        </select>

        <div className="docs-article">
          <Article
            doc={doc}
            prev={allowed[idx - 1]}
            next={allowed[idx + 1]}
            onPrev={() => select(allowed[idx - 1].id)}
            onNext={() => select(allowed[idx + 1].id)}
          />
        </div>

        {/* On This Page - wide screens only (style.css hides it below 1280px). */}
        <nav className="docs-toc" aria-label="On this page">
          <div className="docs-index-group" style={{ padding: '0 0 6px' }}>On This Page</div>
          {outline.map(([label, anchor]) => (
            <button key={anchor} type="button" onClick={() => jump(anchor)} className="docs-toc-item">{label}</button>
          ))}
        </nav>
      </div>
      )}
    </div>
  );
}
