// Support -> Implementation Guide (Neil, 10/06): how to set Nexus up for an
// organization, phase by phase. Content is support/implementationContent.js;
// the done-checks are ONE shared list for every administrator
// (routers/implementation.py), so the team implementing sees the same
// progress and who ticked what.
//
// Layout (Oct 19 2026 redesign, the same reading page as Documentation): a
// rail on the left with overall progress and the phases as a timeline (a
// dropdown on phones); one page at a time in the middle - the phase's why,
// decisions and steps in one column, with its Done When checklist pinned
// beside them so progress is always in view.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Bell, BookOpen, Building2, CalendarClock, Check, CheckSquare, ChevronRight,
  Clock, ClipboardList, Cloud, Compass, HelpCircle, ListChecks, Package, Palette,
  RefreshCw, Rocket, ShieldCheck, Target, TriangleAlert, Users, Waypoints,
} from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { useNameResolver } from '../lib/useNameResolver';
import { IMPL_INTRO, IMPL_CONCEPTS, IMPL_DISCOVERY, IMPL_PHASES, IMPL_CHECK_IDS } from './implementationContent';

const ICONS = { ClipboardList, Cloud, Palette, Building2, ShieldCheck, Users, Clock, CalendarClock, ListChecks, CheckSquare, Package, Bell, BadgeCheck, Rocket, RefreshCw };
const LAST_KEY = 'nexus-impl-guide-last';

const PAGES = [
  { id: 'overview', group: 'Start Here', name: 'Overview', Icon: Compass },
  { id: 'concepts', group: 'Start Here', name: 'How Nexus Is Organized', Icon: Waypoints },
  { id: 'discovery', group: 'Start Here', name: 'Discovery Questions', Icon: HelpCircle },
  ...IMPL_PHASES.map((p) => ({ id: p.id, group: 'Phases', name: p.title, Icon: ICONS[p.icon] || BookOpen, phase: p })),
];

function readLast() {
  try { const v = localStorage.getItem(LAST_KEY); return PAGES.some((p) => p.id === v) ? v : 'overview'; } catch { return 'overview'; }
}
function writeLast(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* private window */ }
}
const go = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));

// Same instruction-plus-detail split as Documentation's steps.
const LEAD = /^(.{8,150}?[.:!?])\s+(?=["'(A-Z0-9])/;
function splitStep(s) {
  const m = LEAD.exec(s);
  return m ? [m[1], s.slice(m[0].length)] : [s, ''];
}

function SectionHeading({ children, aside }) {
  return (
    <div className="docs-h3-row">
      <h3 className="docs-h3">{children}</h3>
      {aside}
    </div>
  );
}

function Bar({ done, total, height = 6 }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${done} of ${total} done`}
      className="impl-bar" style={{ height }}>
      <div className={pct === 100 ? 'complete' : ''} style={{ width: `${pct}%` }} />
    </div>
  );
}

function CheckRow({ check, state, busy, onToggle, nameOf }) {
  const on = !!state;
  return (
    <label className={`impl-check${on ? ' done' : ''}${busy ? ' busy' : ''}`}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onToggle(check.id, e.target.checked)} />
      <span className="impl-check-body">
        <span className="impl-check-text">{check.text}</span>
        {on && <span className="impl-check-by">Done by {nameOf(state.by) || state.by} on {formatDate(state.at)}</span>}
      </span>
    </label>
  );
}

function PageHead({ crumb, title, lede, children }) {
  return (
    <header className="docs-page-head">
      <div className="docs-crumb">Implementation Guide <span aria-hidden="true">/</span> {crumb}</div>
      <h2 className="docs-h2">{title}</h2>
      {lede && <p className="docs-lede">{lede}</p>}
      {children}
    </header>
  );
}

function PhasePage({ p, done, busyId, onToggle, nameOf }) {
  const total = p.checks.length;
  const n = p.checks.filter((c) => done[c.id]).length;
  return (
    <div className="docs-page">
      <PageHead crumb={`Phase ${p.n}`} title={p.title} lede={p.summary}>
        <dl className="docs-facts docs-facts--3">
          <div><dt>Owner</dt><dd>{p.owner}</dd></div>
          <div><dt>Effort</dt><dd>{p.time}</dd></div>
          <div>
            <dt>Progress</dt>
            <dd className="impl-progress-fact">
              <Bar done={n} total={total} height={5} />
              <span>{n === total ? <><BadgeCheck size={13} aria-hidden="true" /> Complete</> : `${n} of ${total} done`}</span>
            </dd>
          </div>
        </dl>
      </PageHead>

      <div className="impl-split">
        <div className="impl-main">
          <section className="docs-sec">
            <SectionHeading>Why This Matters</SectionHeading>
            <p className="docs-prose">{p.why}</p>
            {p.needs?.length > 0 && (
              <p className="impl-needs"><strong>Needs first:</strong> {p.needs.join(' ')}</p>
            )}
          </section>

          {p.decisions?.length > 0 && (
            <section className="docs-sec">
              <SectionHeading>Decide With the Client First</SectionHeading>
              <ul className="impl-decisions">
                {p.decisions.map((d) => <li key={d}><Target size={14} aria-hidden="true" /><span>{d}</span></li>)}
              </ul>
            </section>
          )}

          <section className="docs-sec">
            <SectionHeading>Steps <span className="docs-count">{p.steps.length}</span></SectionHeading>
            <ol className="docs-steps impl-steps">
              {p.steps.map((s, i) => (
                <li key={s.title} className="docs-step">
                  <span className="docs-step-n" aria-hidden="true">{i + 1}</span>
                  <div className="docs-step-body">
                    <div className="impl-step-head">
                      <div className="impl-step-titles">
                        <span className="docs-step-lead">{s.title}</span>
                        {s.where && <span className="impl-step-where">{s.where}</span>}
                      </div>
                      {s.view && (
                        <button type="button" className="secondary-btn impl-open" onClick={() => go(s.view, s.sub)}>
                          Open <ArrowUpRight size={12} />
                        </button>
                      )}
                    </div>
                    <ul className="impl-step-items">
                      {s.items.map((it) => <li key={it}>{it}</li>)}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {p.pitfalls?.length > 0 && (
            <section className="docs-sec">
              <SectionHeading>Watch Out For</SectionHeading>
              <ul className="docs-tips docs-tips--warn">
                {p.pitfalls.map((t) => <li key={t}><TriangleAlert size={15} aria-hidden="true" /><span>{t}</span></li>)}
              </ul>
            </section>
          )}
        </div>

        <aside className="impl-done" aria-label="Done when">
          <div className="impl-done-head">
            <ListChecks size={16} aria-hidden="true" />
            <h3 className="docs-h3">Done When</h3>
            <span className="impl-done-count">{n}/{total}</span>
          </div>
          <Bar done={n} total={total} height={4} />
          <p className="impl-done-hint">Shared with every administrator - tick a check only when it is really true.</p>
          <div className="impl-checks">
            {p.checks.map((c) => <CheckRow key={c.id} check={c} state={done[c.id]} busy={busyId === c.id} onToggle={onToggle} nameOf={nameOf} />)}
          </div>
        </aside>
      </div>
    </div>
  );
}

function OverviewPage({ done, onOpen }) {
  const total = IMPL_CHECK_IDS.length;
  const n = IMPL_CHECK_IDS.filter((id) => done[id]).length;
  return (
    <div className="docs-page">
      <PageHead crumb="Start Here" title="Set Nexus Up the Way the Organization Runs" lede={IMPL_INTRO.lead}>
        <p className="impl-audience">{IMPL_INTRO.audience}</p>
      </PageHead>

      <section className="docs-sec">
        <SectionHeading>How to Use This Guide</SectionHeading>
        <ol className="docs-steps">
          {IMPL_INTRO.howTo.map((t, i) => {
            const [lead, rest] = splitStep(t);
            return (
              <li key={t} className="docs-step">
                <span className="docs-step-n" aria-hidden="true">{i + 1}</span>
                <div className="docs-step-body"><span className="docs-step-lead">{lead}</span>{rest && <span className="docs-step-rest"> {rest}</span>}</div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="docs-sec">
        <SectionHeading aside={<span className="impl-total">{n} of {total} checks done</span>}>Phases</SectionHeading>
        <Bar done={n} total={total} height={6} />
        <div className="impl-phase-table">
          {IMPL_PHASES.map((p) => {
            const pn = p.checks.filter((c) => done[c.id]).length;
            const complete = pn === p.checks.length;
            return (
              <button key={p.id} type="button" className={`impl-phase-row${complete ? ' complete' : ''}`} onClick={() => onOpen(p.id)}>
                <span className="impl-node" aria-hidden="true">{complete ? <Check size={13} strokeWidth={3} /> : p.n}</span>
                <span className="impl-phase-text">
                  <span className="impl-phase-name">{p.title}</span>
                  <span className="impl-phase-sum">{p.summary}</span>
                </span>
                <span className="impl-phase-owner">{p.owner}</span>
                <span className="impl-phase-prog">
                  <Bar done={pn} total={p.checks.length} height={4} />
                  <span>{pn}/{p.checks.length}</span>
                </span>
                <ChevronRight size={15} className="impl-phase-chev" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ConceptsPage() {
  return (
    <div className="docs-page">
      <PageHead crumb="Start Here" title="How Nexus Is Organized"
        lede="Read this once before Phase 1. Every setting in the phases fits into this picture: an organization holds companies; each company has departments, locations, holidays and job roles; people belong to a company, hold a job role and report to someone." />
      {/* The shape, as a simple tree - the words below explain each box. */}
      <section className="docs-sec">
        <pre className="impl-tree" aria-label="Organization, companies, roles and people">
{`Organization  (Settings at Every company, Microsoft 365 tenant)
├─ Company  (legal entity: domains, managers, HR contact)
│   ├─ Departments
│   ├─ Locations  (from the Location Library)
│   ├─ Holiday Calendar
│   ├─ Workforce Analytics Policy
│   └─ Job Roles  (tier + modules + time-clock rules + Teams destination)
│        └─ People  (company, department, Reports To, pay, contact)
└─ Access Groups  (extra modules on top of a job role)`}
        </pre>
      </section>
      <section className="docs-sec">
        <SectionHeading>The Terms</SectionHeading>
        <dl className="docs-deflist">
          {IMPL_CONCEPTS.map((c) => (
            <div key={c.term} className="docs-defrow"><dt>{c.term}</dt><dd>{c.text}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function DiscoveryPage() {
  return (
    <div className="docs-page">
      <PageHead crumb="Start Here" title="Discovery Questions"
        lede="Ask these at kickoff (Phase 0). Every answer feeds a later phase, so collecting them first turns setup into data entry." />
      {IMPL_DISCOVERY.map((a) => (
        <section key={a.area} className="docs-sec">
          <SectionHeading>{a.area} <span className="docs-count">{a.questions.length}</span></SectionHeading>
          <ol className="impl-questions">
            {a.questions.map((q) => <li key={q}>{q}</li>)}
          </ol>
        </section>
      ))}
    </div>
  );
}

export default function ImplementationGuide({ toastErr }) {
  const [activeId, setActiveId] = useState(readLast);
  const [done, setDone] = useState({});
  const [loadErr, setLoadErr] = useState('');
  const [busyId, setBusyId] = useState('');
  const nameOf = useNameResolver();
  const topRef = useRef(null);

  const load = useCallback(() => {
    setLoadErr('');
    api.getImplementationProgress().then((r) => setDone(r?.done || {}))
      .catch((e) => setLoadErr(e?.message || 'Progress could not be loaded.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (id, on) => {
    const before = done;
    setBusyId(id);
    setDone((d) => { const n = { ...d }; if (on) n[id] = { by: '', at: new Date().toISOString() }; else delete n[id]; return n; });
    try {
      const r = await api.setImplementationCheck(id, on);
      setDone(r?.done || {});
    } catch (e) {
      setDone(before);
      const msg = e?.message || 'Could not save that check.';
      if (toastErr) toastErr(msg); else setLoadErr(msg);
    }
    setBusyId('');
  };

  const idx = Math.max(0, PAGES.findIndex((p) => p.id === activeId));
  const page = PAGES[idx];
  const select = (id) => {
    setActiveId(id);
    writeLast(id);
    topRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const counts = useMemo(() => Object.fromEntries(IMPL_PHASES.map((p) => [p.id, [p.checks.filter((c) => done[c.id]).length, p.checks.length]])), [done]);
  const allDone = IMPL_CHECK_IDS.filter((id) => done[id]).length;
  const prev = PAGES[idx - 1];
  const next = PAGES[idx + 1];

  return (
    <div ref={topRef} className="docs-root">
      <div className="docs-layout docs-layout--guide">
        <aside className="docs-index" aria-label="Implementation guide sections">
          {/* Overall progress. */}
          <div className="impl-rail-progress">
            <div className="impl-rail-progress-text">
              {loadErr ? <span className="impl-err">{loadErr} <button type="button" onClick={load}>Retry</button></span>
                : `${allDone} of ${IMPL_CHECK_IDS.length} checks done`}
            </div>
            <Bar done={allDone} total={IMPL_CHECK_IDS.length} height={5} />
          </div>

          <div className="docs-index-sec">
            <div className="docs-index-group">Start Here</div>
            {PAGES.filter((p) => !p.phase).map((p) => {
              const on = p.id === page.id;
              return (
                <button key={p.id} type="button" onClick={() => select(p.id)} className={`docs-index-item${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined}>
                  <p.Icon size={15} aria-hidden="true" />
                  <span className="docs-index-name">{p.name}</span>
                </button>
              );
            })}
          </div>

          {/* The phases as a timeline: a node per phase on one line, green once its checks are all done. */}
          <div className="docs-index-sec">
            <div className="docs-index-group">Phases</div>
            <div className="impl-timeline">
              {PAGES.filter((p) => p.phase).map((p) => {
                const on = p.id === page.id;
                const [cn, ct] = counts[p.id];
                const complete = cn === ct;
                return (
                  <button key={p.id} type="button" onClick={() => select(p.id)} aria-current={on ? 'page' : undefined}
                    className={`docs-index-item impl-tl-item${on ? ' active' : ''}${complete ? ' complete' : ''}`}>
                    <span className="impl-node" aria-hidden="true">{complete ? <Check size={11} strokeWidth={3} /> : p.phase.n}</span>
                    <span className="docs-index-name">{p.name}</span>
                    <span className="impl-tl-count">{cn}/{ct}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <select className="form-input docs-index-select" value={page.id} onChange={(e) => select(e.target.value)} aria-label="Choose a section">
          {['Start Here', 'Phases'].map((g) => (
            <optgroup key={g} label={g}>
              {PAGES.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.phase ? `${p.phase.n}. ` : ''}{p.name}</option>)}
            </optgroup>
          ))}
        </select>

        <div className="docs-article">
          {page.id === 'overview' ? <OverviewPage done={done} onOpen={select} />
            : page.id === 'concepts' ? <ConceptsPage />
              : page.id === 'discovery' ? <DiscoveryPage />
                : <PhasePage p={page.phase} done={done} busyId={busyId} onToggle={toggle} nameOf={nameOf} />}

          <nav className="docs-pager" aria-label="More sections">
            {prev ? (
              <button type="button" className="docs-pager-link" onClick={() => select(prev.id)}>
                <span className="docs-pager-dir"><ArrowLeft size={13} /> Previous</span>
                <span className="docs-pager-name">{prev.phase ? `${prev.phase.n}. ` : ''}{prev.name}</span>
              </button>
            ) : <span />}
            {next && (
              <button type="button" className="docs-pager-link docs-pager-link--next" onClick={() => select(next.id)}>
                <span className="docs-pager-dir">Next <ArrowRight size={13} /></span>
                <span className="docs-pager-name">{next.phase ? `${next.phase.n}. ` : ''}{next.name}</span>
              </button>
            )}
          </nav>
        </div>
      </div>
    </div>
  );
}
