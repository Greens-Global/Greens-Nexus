// Support -> Implementation Guide (Neil, 10/06): how to set Nexus up for an
// organization, phase by phase. Content is support/implementationContent.js;
// the done-checks are ONE shared list for every administrator
// (routers/implementation.py), so the team implementing sees the same
// progress and who ticked what. Same layout as Documentation (SupportDocs):
// a rail on the left (a dropdown on phones), one page at a time on the right.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight, BadgeCheck, Bell, BookOpen, Building2, CalendarClock, CheckSquare, ChevronLeft, ChevronRight,
  Clock, ClipboardList, Cloud, Compass, HelpCircle, Lightbulb, ListChecks, MousePointerClick, Package, Palette,
  Plug, RefreshCw, Rocket, ShieldCheck, Target, TriangleAlert, Users, Waypoints,
} from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { useNameResolver } from '../lib/useNameResolver';
import { IMPL_INTRO, IMPL_CONCEPTS, IMPL_DISCOVERY, IMPL_INTEGRATIONS, IMPL_PHASES, IMPL_CHECK_IDS } from './implementationContent';

const ICONS = { ClipboardList, Cloud, Palette, Building2, ShieldCheck, Users, Clock, CalendarClock, ListChecks, CheckSquare, Package, Bell, BadgeCheck, Rocket, RefreshCw };
const BRAND = 'var(--wk-brand, #2b45e1)';
const GREEN = 'hsl(var(--color-green))';
const LAST_KEY = 'nexus-impl-guide-last';

const PAGES = [
  { id: 'overview', group: 'Start Here', name: 'Overview', Icon: Compass },
  { id: 'concepts', group: 'Start Here', name: 'How Nexus Is Organized', Icon: Waypoints },
  { id: 'discovery', group: 'Start Here', name: 'Discovery Questions', Icon: HelpCircle },
  ...IMPL_PHASES.map((p) => ({ id: p.id, group: 'Phases', name: p.title, Icon: ICONS[p.icon] || BookOpen, phase: p })),
  { id: 'integrations', group: 'Reference', name: 'Integrations and Permissions', Icon: Plug },
];
const GROUPS = ['Start Here', 'Phases', 'Reference'];

function readLast() {
  try { const v = localStorage.getItem(LAST_KEY); return PAGES.some((p) => p.id === v) ? v : 'overview'; } catch { return 'overview'; }
}
function writeLast(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* private window */ }
}
const go = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));

function SectionTitle({ icon: Icon, children }) {
  return (
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', fontSize: 15, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
      {Icon && <Icon size={16} style={{ color: BRAND }} />}{children}
    </h3>
  );
}

function Bar({ done, total, height = 6 }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${done} of ${total} done`}
      style={{ height, borderRadius: 999, background: 'var(--mist)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: pct === 100 ? GREEN : BRAND, transition: 'width .25s' }} />
    </div>
  );
}

function Chip({ children, tone }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
      color: tone === 'green' ? GREEN : 'var(--ink)', background: tone === 'green' ? 'hsla(var(--color-green),0.1)' : 'var(--mist)', border: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function CheckRow({ check, state, busy, onToggle, nameOf }) {
  const on = !!state;
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: busy ? 'wait' : 'pointer',
      border: `1px solid ${on ? 'hsla(var(--color-green),0.35)' : 'var(--line)'}`, background: on ? 'hsla(var(--color-green),0.06)' : 'var(--card)' }}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onToggle(check.id, e.target.checked)}
        style={{ width: 17, height: 17, marginTop: 1, accentColor: 'hsl(var(--color-green))', cursor: 'inherit', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.45, textDecoration: on ? 'line-through' : 'none', textDecorationColor: 'var(--muted)' }}>{check.text}</span>
        {on && (
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Done by {nameOf(state.by) || state.by} on {formatDate(state.at)}
          </span>
        )}
      </span>
    </label>
  );
}

function PhasePage({ p, done, busyId, onToggle, nameOf }) {
  const total = p.checks.length;
  const n = p.checks.filter((c) => done[c.id]).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <Chip>Phase {p.n}</Chip>
          <Chip><Users size={12} /> {p.owner}</Chip>
          <Chip><Clock size={12} /> {p.time}</Chip>
          {n === total && <Chip tone="green"><BadgeCheck size={12} /> Complete</Chip>}
        </div>
        <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>{p.title}</h2>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.55 }}>{p.summary}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, maxWidth: 420 }}>
          <div style={{ flex: 1 }}><Bar done={n} total={total} /></div>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{n} of {total} done</span>
        </div>
      </div>

      <section>
        <SectionTitle icon={Lightbulb}>Why This Matters</SectionTitle>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--ink)', lineHeight: 1.65 }}>{p.why}</p>
        {p.needs?.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--muted)' }}>
            <strong style={{ color: 'var(--ink)' }}>Needs first:</strong> {p.needs.join(' ')}
          </div>
        )}
      </section>

      {p.decisions?.length > 0 && (
        <section>
          <SectionTitle icon={Target}>Decide With the Client First</SectionTitle>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {p.decisions.map((d) => <li key={d} style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55 }}>{d}</li>)}
          </ul>
        </section>
      )}

      <section>
        <SectionTitle icon={MousePointerClick}>Steps</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {p.steps.map((s, i) => (
            <div key={s.title} className="docs-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: '50%', background: BRAND, color: '#fff', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{s.title}</div>
                  {s.where && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{s.where}</div>}
                </div>
                {s.view && (
                  <button type="button" className="secondary-btn" onClick={() => go(s.view, s.sub)}
                    style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px' }}>
                    Open <ArrowUpRight size={12} />
                  </button>
                )}
              </div>
              <ul style={{ margin: 0, paddingLeft: 52, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {s.items.map((it) => <li key={it} style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55 }}>{it}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle icon={ListChecks}>Done When</SectionTitle>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '-6px 0 10px' }}>Shared with every administrator - tick a check only when it is really true.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {p.checks.map((c) => <CheckRow key={c.id} check={c} state={done[c.id]} busy={busyId === c.id} onToggle={onToggle} nameOf={nameOf} />)}
        </div>
      </section>

      {p.pitfalls?.length > 0 && (
        <section>
          <SectionTitle icon={TriangleAlert}>Watch Out For</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {p.pitfalls.map((t) => (
              <div key={t} style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55, padding: '10px 14px', borderRadius: 10, background: 'rgba(180,83,9,0.07)', borderLeft: '3px solid #b45309' }}>{t}</div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function OverviewPage({ done, onOpen }) {
  const total = IMPL_CHECK_IDS.length;
  const n = IMPL_CHECK_IDS.filter((id) => done[id]).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>Set Nexus Up the Way the Organization Runs</h2>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.6 }}>{IMPL_INTRO.lead}</p>
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{IMPL_INTRO.audience}</p>
      </div>
      <section>
        <SectionTitle icon={BookOpen}>How to Use This Guide</SectionTitle>
        <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 7 }}>
          {IMPL_INTRO.howTo.map((t) => <li key={t} style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55 }}>{t}</li>)}
        </ul>
      </section>
      <section>
        <SectionTitle icon={ListChecks}>Progress</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, maxWidth: 520 }}>
          <div style={{ flex: 1 }}><Bar done={n} total={total} height={8} /></div>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{n} of {total} checks done</span>
        </div>
        <div className="docs-grid">
          {IMPL_PHASES.map((p) => {
            const I = ICONS[p.icon] || BookOpen;
            const pn = p.checks.filter((c) => done[c.id]).length;
            return (
              <button key={p.id} type="button" className="docs-card" onClick={() => onOpen(p.id)}
                style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <I size={16} style={{ color: pn === p.checks.length ? GREEN : BRAND, flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Phase {p.n}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: pn === p.checks.length ? GREEN : 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{pn}/{p.checks.length}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{p.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{p.summary}</div>
                <Bar done={pn} total={p.checks.length} height={4} />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>How Nexus Is Organized</h2>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          Read this once before Phase 1. Every setting in the phases fits into this picture: an organization holds companies; each company has departments, locations, holidays and job roles; people belong to a company, hold a job role and report to someone.
        </p>
      </div>
      {/* The shape, as a simple tree - the words below explain each box. */}
      <div className="docs-card" aria-label="Organization, companies, roles and people" style={{ fontSize: 13, lineHeight: 1.9, color: 'var(--ink)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowX: 'auto', whiteSpace: 'pre' }}>
{`Organization  (Global Settings, Microsoft 365 tenant)
├─ Company  (legal entity: domains, managers, HR contact)
│   ├─ Departments
│   ├─ Locations  (from the Location Library)
│   ├─ Holiday Calendar
│   ├─ Workforce Analytics Policy
│   └─ Job Roles  (tier + modules + time-clock rules + Teams destination)
│        └─ People  (company, department, Reports To, pay, contact)
└─ Access Groups  (extra modules on top of a job role)`}
      </div>
      <div className="docs-grid">
        {IMPL_CONCEPTS.map((c) => (
          <div key={c.term} className="docs-card">
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)', marginBottom: 5 }}>{c.term}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{c.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiscoveryPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>Discovery Questions</h2>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          Ask these at kickoff (Phase 0). Every answer feeds a later phase, so collecting them first turns setup into data entry.
        </p>
      </div>
      {IMPL_DISCOVERY.map((a) => (
        <section key={a.area}>
          <SectionTitle icon={HelpCircle}>{a.area}</SectionTitle>
          <ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {a.questions.map((q) => <li key={q} style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55 }}>{q}</li>)}
          </ol>
        </section>
      ))}
    </div>
  );
}

function IntegrationsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>Integrations and Permissions</h2>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.6 }}>
          What each connected service does in Nexus, how it is set up, and the permissions it needs. Hand this page to the client’s IT before Phase 1.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {IMPL_INTEGRATIONS.map((x) => (
          <div key={x.name} className="docs-card" style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>{x.name}</div>
            <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.55 }}><strong>What it does:</strong> {x.what}</div>
            <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.55 }}><strong>Setup:</strong> {x.setup}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}><strong>Permissions:</strong> <code style={{ fontSize: 12 }}>{x.perms}</code></div>
          </div>
        ))}
      </div>
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

  return (
    <div ref={topRef} style={{ display: 'flex', flexDirection: 'column', gap: 20, scrollMarginTop: 80 }}>
      <div className="docs-hero">
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: BRAND, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px', marginBottom: 10 }}>
            <Rocket size={12} /> {IMPL_INTRO.title}
          </div>
          <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.02em' }}>From Signed Contract to Live Organization</h2>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.55, maxWidth: 600 }}>
            {IMPL_PHASES.length} phases in the order they must happen, each with the decisions to make, the steps (with a link to each screen) and the checks that prove it is done.
          </p>
        </div>
        <div style={{ width: 260, maxWidth: '100%', alignSelf: 'flex-end' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
            {loadErr ? <span style={{ color: '#b45309' }}>{loadErr} <button type="button" onClick={load} style={{ border: 'none', background: 'none', color: BRAND, fontWeight: 700, cursor: 'pointer', padding: 0 }}>Retry</button></span>
              : `${allDone} of ${IMPL_CHECK_IDS.length} checks done`}
          </div>
          <Bar done={allDone} total={IMPL_CHECK_IDS.length} height={8} />
        </div>
      </div>

      <div className="docs-layout">
        <aside className="docs-index" aria-label="Implementation guide sections">
          {GROUPS.map((g) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '0 10px 5px' }}>{g}</div>
              {PAGES.filter((p) => p.group === g).map((p) => {
                const on = p.id === page.id;
                const c = counts[p.id];
                const complete = c && c[0] === c[1];
                return (
                  <button key={p.id} type="button" onClick={() => select(p.id)} className={`docs-index-item${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined}>
                    {complete && !on ? <BadgeCheck size={15} style={{ flexShrink: 0, color: GREEN }} /> : <p.Icon size={15} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.phase ? `${p.phase.n}. ` : ''}{p.name}
                    </span>
                    {c && <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.8, fontVariantNumeric: 'tabular-nums' }}>{c[0]}/{c[1]}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        <select className="form-input docs-index-select" value={page.id} onChange={(e) => select(e.target.value)} aria-label="Choose a section">
          {GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {PAGES.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.phase ? `${p.phase.n}. ` : ''}{p.name}</option>)}
            </optgroup>
          ))}
        </select>

        <div className="docs-article">
          {page.id === 'overview' ? <OverviewPage done={done} onOpen={select} />
            : page.id === 'concepts' ? <ConceptsPage />
              : page.id === 'discovery' ? <DiscoveryPage />
                : page.id === 'integrations' ? <IntegrationsPage />
                  : <PhasePage p={page.phase} done={done} busyId={busyId} onToggle={toggle} nameOf={nameOf} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
            {idx > 0 ? (
              <button type="button" className="secondary-btn" onClick={() => select(PAGES[idx - 1].id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <ChevronLeft size={14} /> {PAGES[idx - 1].name}
              </button>
            ) : <span />}
            {idx < PAGES.length - 1 && (
              <button type="button" className="secondary-btn" onClick={() => select(PAGES[idx + 1].id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                {PAGES[idx + 1].name} <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
