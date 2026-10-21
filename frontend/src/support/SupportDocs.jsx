// Support -> Documentation tab: a plain-English guide to every Nexus module.
//
// Content lives in docsContent.js (one entry per left-nav module); the
// pictures are drawn wireframes from DocShots.jsx, not captured screenshots.
//
// Layout (Oct 19 2026 redesign - the three-column card grid of long steps read
// as clutter): a reading page, not a dashboard.
//   THESIS      One reading column. How-tos are a list of questions opened one
//               at a time into a vertical stepper; features are a definition
//               table. No card grids.
//   OWN-WORLD   Nexus tokens (--card / --line / --ink / --muted / --wk-brand),
//               hairline dividers instead of boxes, brand only for the current
//               page, the open how-to and step markers.
//   STORY       Find the module, scan "how do I", open one, follow the steps,
//               glance at the feature table, read what managers get.
//   VIEWPORT    Module rail left (sticky), the page in the middle (title,
//               tagline, Where / Who facts, Open), On This Page right with the
//               current section lit as you scroll.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, ArrowUpRight, ArrowLeft, ArrowRight, ChevronLeft, ChevronDown, Check,
  ShieldCheck, Lightbulb, BookOpen, X, Rocket,
  Sparkles, LayoutDashboard, Contact, MonitorDot, CalendarClock, CheckSquare, HardDrive, Ticket,
  FileText, Monitor, HardHat, Store, Package, Home, Calculator, Landmark, Users,
  Megaphone, KeyRound, HelpCircle, Settings, Handshake, Receipt,
} from 'lucide-react';
import InsightsChart from '../components/icons/InsightsChart';
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
  Users, Megaphone, InsightsChart, KeyRound, HelpCircle, Settings, Handshake, Receipt,
};

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

// A step reads as an instruction plus detail: its first sentence (or the part
// before a colon) is the action, the rest is the explanation. Short steps are
// all action.
const LEAD = /^(.{8,150}?[.:!?])\s+(?=["'(A-Z0-9])/;
function splitStep(s) {
  const m = LEAD.exec(s);
  return m ? [m[1], s.slice(m[0].length)] : [s, ''];
}

function SectionHeading({ id, children, aside }) {
  return (
    <div className="docs-h3-row">
      <h3 id={id} className="docs-h3">{children}</h3>
      {aside}
    </div>
  );
}

function Steps({ steps }) {
  return (
    <ol className="docs-steps">
      {steps.map((s, i) => {
        const [lead, rest] = splitStep(s);
        return (
          <li key={i} className="docs-step">
            <span className="docs-step-n" aria-hidden="true">{i + 1}</span>
            <div className="docs-step-body">
              <span className="docs-step-lead">{lead}</span>
              {rest && <span className="docs-step-rest"> {rest}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function HowTo({ w, id, open, onToggle }) {
  const panel = `${id}-steps`;
  return (
    <div id={id} className={`docs-howto${open ? ' open' : ''}`}>
      <button type="button" className="docs-howto-head" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <ChevronDown size={16} className="docs-howto-chev" aria-hidden="true" />
        <span className="docs-howto-title">{w.title}</span>
        <span className="docs-howto-count">{w.steps.length} {w.steps.length === 1 ? 'Step' : 'Steps'}</span>
      </button>
      {open && <div id={panel} className="docs-howto-panel"><Steps steps={w.steps} /></div>}
    </div>
  );
}

function Article({ doc, prev, next, onPrev, onNext, isOpen, onToggle, onSetAll }) {
  const Icon = ICONS[doc.icon] || BookOpen;
  const legend = shotLegend(doc.shot);
  const openModule = () => window.dispatchEvent(new CustomEvent('nexus:navigate', {
    detail: doc.sub ? { view: doc.view, sub: doc.sub } : { view: doc.view },
  }));
  const anchors = (doc.walkthroughs || []).map((w) => walkthroughAnchor(w.title));
  const allOpen = anchors.length > 0 && anchors.every(isOpen);

  return (
    <article id={sectionDomId(doc.id)} className="docs-page">
      <header className="docs-page-head">
        <div className="docs-crumb">Documentation <span aria-hidden="true">/</span> {doc.group}</div>
        <div className="docs-title-row">
          <span className="docs-mod-icon" aria-hidden="true"><Icon size={20} /></span>
          <h2 className="docs-h2">{doc.name}</h2>
          {doc.view && (
            <button type="button" className="primary-btn docs-open" onClick={openModule}>
              Open {doc.name} <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        <p className="docs-lede">{doc.tagline}</p>
        <dl className="docs-facts">
          <div><dt>Where</dt><dd>{doc.where}</dd></div>
          <div><dt>Who Can Use It</dt><dd>{doc.access}</dd></div>
        </dl>
      </header>

      <section className="docs-sec">
        <SectionHeading id={sectionDomId(doc.id, 'sec-purpose')}>Overview</SectionHeading>
        <div className={doc.gains?.length ? 'docs-overview' : undefined}>
          <p className="docs-prose">{doc.purpose}</p>
          {doc.gains?.length > 0 && (
            <ul className="docs-gains" aria-label="What you get">
              <li className="docs-gains-title" aria-hidden="true">What You Get</li>
              {doc.gains.map((g) => (
                <li key={g}><Check size={15} aria-hidden="true" />{g}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {doc.shot && (
        <section className="docs-sec">
          <SectionHeading id={sectionDomId(doc.id, 'sec-shot')}>What It Looks Like</SectionHeading>
          <figure className="docs-figure">
            <div className="docs-figure-art"><DocShot shot={doc.shot} /></div>
            {legend.length > 0 && (
              <ol className="docs-legend">
                {legend.map((l, i) => (
                  <li key={i}><span className="docs-step-n" aria-hidden="true">{i + 1}</span><span>{l}</span></li>
                ))}
              </ol>
            )}
            <figcaption>Simplified illustration. Your screen shows your own data and may have a few more buttons.</figcaption>
          </figure>
        </section>
      )}

      {doc.walkthroughs?.length > 0 && (
        <section className="docs-sec">
          <SectionHeading
            id={sectionDomId(doc.id, 'sec-steps')}
            aside={anchors.length > 1 && (
              <button type="button" className="docs-textbtn" onClick={() => onSetAll(allOpen ? [] : anchors)}>
                {allOpen ? 'Collapse All' : 'Expand All'}
              </button>
            )}
          >
            How-To Guides <span className="docs-count">{doc.walkthroughs.length}</span>
          </SectionHeading>
          <div className="docs-howtos">
            {doc.walkthroughs.map((w) => {
              const a = walkthroughAnchor(w.title);
              return <HowTo key={w.title} w={w} id={sectionDomId(doc.id, a)} open={isOpen(a)} onToggle={() => onToggle(a)} />;
            })}
          </div>
        </section>
      )}

      {doc.features?.length > 0 && (
        <section className="docs-sec">
          <SectionHeading id={sectionDomId(doc.id, 'sec-features')}>
            Features <span className="docs-count">{doc.features.length}</span>
          </SectionHeading>
          <dl className="docs-deflist">
            {doc.features.map((f) => (
              <div key={f.name} id={sectionDomId(doc.id, featureAnchor(f.name))} className="docs-defrow">
                <dt>{f.name}</dt>
                <dd>{f.desc}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {doc.id === 'getting-started' && (
        <section className="docs-sec">
          <SectionHeading id={sectionDomId(doc.id, 'sec-roles')}>Roles in Nexus</SectionHeading>
          <dl className="docs-deflist">
            {ROLE_TIERS.map((r, i) => (
              <div key={r.name} className="docs-defrow">
                <dt><span className="docs-level">Level {i + 1}</span>{r.name}</dt>
                <dd>{r.desc}</dd>
              </div>
            ))}
          </dl>
          <h4 className="docs-h4">Access Levels on a Module</h4>
          <dl className="docs-deflist docs-deflist--compact">
            {ACCESS_LEVELS.map((a) => (
              <div key={a.name} className="docs-defrow"><dt>{a.name}</dt><dd>{a.desc}</dd></div>
            ))}
          </dl>
        </section>
      )}

      {doc.manager?.points?.length > 0 && (
        <section className="docs-sec">
          <div id={sectionDomId(doc.id, MANAGER_ANCHOR)} className="docs-callout">
            <div className="docs-callout-head"><ShieldCheck size={16} aria-hidden="true" /><h3 className="docs-h3">{doc.manager.title}</h3></div>
            <ul>
              {doc.manager.points.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        </section>
      )}

      {doc.tips?.length > 0 && (
        <section className="docs-sec">
          <SectionHeading id={sectionDomId(doc.id, TIPS_ANCHOR)}>Good To Know</SectionHeading>
          <ul className="docs-tips">
            {doc.tips.map((t) => (
              <li key={t}><Lightbulb size={15} aria-hidden="true" /><span>{t}</span></li>
            ))}
          </ul>
        </section>
      )}

      <nav className="docs-pager" aria-label="More modules">
        {prev ? (
          <button type="button" className="docs-pager-link" onClick={onPrev}>
            <span className="docs-pager-dir"><ArrowLeft size={13} /> Previous</span>
            <span className="docs-pager-name">{prev.name}</span>
          </button>
        ) : <span />}
        {next && (
          <button type="button" className="docs-pager-link docs-pager-link--next" onClick={onNext}>
            <span className="docs-pager-dir">Next <ArrowRight size={13} /></span>
            <span className="docs-pager-name">{next.name}</span>
          </button>
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

// Which how-tos are open, per page: the first one, plus a how-to a link or a
// help search pointed at. Kept by doc id so a new page starts fresh.
const firstOpen = (docId, anchor) => {
  const d = DOCS.find((x) => x.id === docId);
  const first = d?.walkthroughs?.[0] ? walkthroughAnchor(d.walkthroughs[0].title) : null;
  return { docId, set: new Set([first, anchor].filter(Boolean)), closed: new Set() };
};

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
  const [opened, setOpened] = useState(() => (initialTarget ? firstOpen(initialTarget.docId, initialTarget.anchor) : firstOpen(null)));

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
      setOpened(firstOpen(docId, anchor));
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
  const words = useMemo(() => (q ? q.split(/\s+/) : []), [q]);
  const matches = useMemo(() => {
    if (!words.length) return null;
    const hits = new Set(INDEX.filter((e) => words.every((w) => e.text.includes(w))).map((e) => e.id));
    // Plus the help search's matches, so the words people actually use
    // ("pto", "my laptop is broken") find the module whose page answers them.
    for (const r of searchDocs(q, { limit: 12, perDoc: 1 })) hits.add(r.docId);
    return hits;
  }, [q, words]);
  const visible = matches ? allowed.filter((d) => matches.has(d.id)) : allowed;

  // A remembered page the person can no longer open falls back to the first
  // allowed one; while searching, a page that no longer matches gives way to
  // the first hit.
  const isShown = (id) => (matches && visible.length ? visible : allowed).some((d) => d.id === id);
  const shownId = isShown(activeId) ? activeId : (matches && visible.length ? visible : allowed)[0].id;
  const idx = Math.max(0, allowed.findIndex((d) => d.id === shownId));
  const doc = allowed[idx];
  const onGuide = canImplement && section === 'guide';

  const { set: openSet, closed } = opened.docId === doc.id ? opened : firstOpen(doc.id);
  // While searching, a how-to whose words match opens by itself.
  const searchOpen = (a) => {
    if (!words.length) return false;
    const w = doc.walkthroughs?.find((x) => walkthroughAnchor(x.title) === a);
    const text = w ? [w.title, ...w.steps].join(' ').toLowerCase() : '';
    return words.every((x) => text.includes(x));
  };
  // `closed` remembers a how-to the reader shut, so a search match stays shut.
  const isOpen = (a) => !closed.has(a) && (openSet.has(a) || searchOpen(a));
  const toggle = (a) => {
    const set = new Set(openSet);
    const shut = new Set(closed);
    if (isOpen(a)) { set.delete(a); shut.add(a); } else { set.add(a); shut.delete(a); }
    setOpened({ docId: doc.id, set, closed: shut });
  };
  const setAll = (list) => {
    const all = (doc.walkthroughs || []).map((w) => walkthroughAnchor(w.title));
    setOpened({ docId: doc.id, set: new Set(list), closed: new Set(all.filter((a) => !list.includes(a))) });
  };

  const select = (id) => {
    setActiveId(id);
    writeLast(id);
    topRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };

  // On This Page: the article's own sections, lit as they scroll past.
  const outline = doc ? [
    ['Overview', 'sec-purpose'],
    doc.shot && ['What It Looks Like', 'sec-shot'],
    doc.walkthroughs?.length && ['How-To Guides', 'sec-steps'],
    doc.features?.length && ['Features', 'sec-features'],
    doc.id === 'getting-started' && ['Roles in Nexus', 'sec-roles'],
    doc.manager?.points?.length && [doc.manager.title, MANAGER_ANCHOR],
    doc.tips?.length && ['Good To Know', TIPS_ANCHOR],
  ].filter(Boolean) : [];
  const outlineKey = outline.map((o) => o[1]).join('|');
  // Lit section, kept with its page so a new page starts on its first section.
  const [lit, setLit] = useState({ docId: null, anchor: null });
  const current = lit.docId === doc.id ? lit.anchor : outline[0]?.[1];
  useEffect(() => {
    if (onGuide) return undefined;
    // The last section whose heading has passed under the header is the one
    // being read. Captured, so it hears whichever element is scrolling.
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const anchors = outlineKey.split('|');
        let at = anchors[0];
        for (const a of anchors) {
          const el = document.getElementById(sectionDomId(doc.id, a));
          if (el && el.getBoundingClientRect().top < 140) at = a;
        }
        setLit({ docId: doc.id, anchor: at });
      });
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { cancelAnimationFrame(raf); document.removeEventListener('scroll', onScroll, { capture: true }); };
  }, [doc.id, outlineKey, onGuide]);
  const jump = (anchor) => document.getElementById(sectionDomId(doc.id, anchor))?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });

  return (
    <div ref={topRef} className="docs-root">
      {/* One toolbar: back, the title, the Module Guides | Implementation Guide
          switch for administrators, and the module search on the right. */}
      <div className="docs-toolbar">
        {onBack && (
          <button type="button" className="docs-back" onClick={onBack} aria-label="Back to Help Center" title="Back to Help Center">
            <ChevronLeft size={16} />
          </button>
        )}
        <h2 className="docs-title">Documentation</h2>
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
            <Search size={15} className="docs-search-icon" aria-hidden="true" />
            <input type="text" className="form-input" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search e.g. time off, cart, signature…" aria-label="Search the documentation" />
            {query && (
              <button type="button" className="docs-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
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
              <div className="docs-index-empty">Nothing matches "{query.trim()}".</div>
            )}
            {DOC_GROUPS.map((g) => {
              const items = visible.filter((d) => d.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="docs-index-sec">
                  <div className="docs-index-group">{g}</div>
                  {items.map((d) => {
                    const I = ICONS[d.icon] || BookOpen;
                    const on = d.id === doc.id;
                    return (
                      <button key={d.id} type="button" onClick={() => select(d.id)} className={`docs-index-item${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined}>
                        <I size={15} aria-hidden="true" />
                        <span className="docs-index-name">{d.name}</span>
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
              isOpen={isOpen}
              onToggle={toggle}
              onSetAll={setAll}
            />
          </div>

          {/* On This Page - wide screens only (style.css hides it below 1280px). */}
          <nav className="docs-toc" aria-label="On this page">
            <div className="docs-toc-title">On This Page</div>
            {outline.map(([label, anchor]) => (
              <button key={anchor} type="button" onClick={() => jump(anchor)}
                className={`docs-toc-item${current === anchor ? ' active' : ''}`} aria-current={current === anchor ? 'location' : undefined}>
                {label}
              </button>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}
