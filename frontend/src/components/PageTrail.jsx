import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

/*
The page trail (Neil, 11/04/2026): a small line ABOVE the page title that
says where the page sits - the module, then the pages above a record -
"TEAM" over "Shift Planner", "ASSET MANAGEMENT / PORTFOLIO" over
"Greens Storage, Fairfield". Every part goes UP a level; the top bar's back
arrow still goes BACK to wherever you came from. The trail never repeats the
page you are on: that is the title (or the lit tab) right below it.

One trail per screen, from one place:
  - the MODULE comes from the shell (`PageTrailProvider` in App.jsx, the
    same label the left navigation shows);
  - a page with a title row puts <PageTrail title="..." /> above its h2 - the
    title lets the trail step aside when it would only repeat it (Settings
    over "Settings");
  - a record page names the pages above it with useTrailCrumbs([{ label,
    onClick }]) - one line, never a hand-built trail. A deeper page held in
    the module's own state (What's New > Manage, a Portfolio, a course) passes
    `onHome` too - useTrailCrumbs(crumbs, onHome) - so the module part leaves
    it; the page's "Back to ..." button goes (11/04/2026);
  - a module heading names the OPEN TAB, never the module: the trail above it
    names the module, and the tab itself is never a part of the trail;
  - a screen with no title row needs nothing: the shell draws the trail at
    the top of the page itself (`ShellTrail`) whenever no page has placed one.
Never build a second breadcrumb in a module; extend this one.
*/

const TrailCtx = createContext(null);

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export function PageTrailProvider({ view, label, onNavigate, children }) {
  const [crumbs, setCrumbs] = useState([]);
  const [placed, setPlaced] = useState(0);
  const navRef = useRef(onNavigate);
  const homeRef = useRef(null);
  useEffect(() => { navRef.current = onNavigate; });
  const value = useMemo(() => ({
    view, label, crumbs, setCrumbs, placed, setPlaced, homeRef,
    goModule: () => { homeRef.current?.(); navRef.current?.(view); },
  }), [view, label, crumbs, placed]);
  return <TrailCtx.Provider value={value}>{children}</TrailCtx.Provider>;
}

/** A record page names the pages above it: [{ label, onClick }], top-down.
 *  `onHome` (optional) takes a page held in the module's own state back to
 *  the module's home when the module part is clicked. */
export function useTrailCrumbs(crumbs, onHome) {
  const ctx = useContext(TrailCtx);
  const set = ctx?.setCrumbs;
  const homeRef = ctx?.homeRef;
  const ref = useRef(crumbs);
  const onHomeRef = useRef(onHome);
  useEffect(() => { ref.current = crumbs; onHomeRef.current = onHome; });
  useLayoutEffect(() => {
    if (!homeRef) return undefined;
    homeRef.current = () => onHomeRef.current?.();
    return () => { homeRef.current = null; };
  }, [homeRef]);
  const sig = (crumbs || []).map((c) => c?.label || '').join('\u0001');
  useLayoutEffect(() => {
    if (!set) return;
    set((crumbs || []).filter((c) => c?.label).map((c, i) => ({ label: c.label, go: () => ref.current?.[i]?.onClick?.() })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, sig]);
  useLayoutEffect(() => () => set?.([]), [set]);
}

/** The name of the tab `key` names in a <ModuleTabs> list, dropdown items included. */
export function tabLabelOf(tabs, key) {
  for (const t of tabs || []) {
    if (t.key === key) return t.title || t.label || '';
    const hit = tabLabelOf(t.items, key);
    if (hit) return hit;
  }
  return '';
}

/** The trail's parts for this screen, or [] when it would say nothing new. */
function partsFor(ctx, title) {
  if (!ctx?.label) return [];
  if (!ctx.crumbs.length && title && same(title, ctx.label)) return [];
  // A first crumb named like the module (Workflows > the Workflows list) is
  // the module part itself: one "WORKFLOWS" that goes to that list.
  const [first, ...rest] = ctx.crumbs;
  if (first && same(first.label, ctx.label)) return [{ label: ctx.label, go: first.go, module: true }, ...rest];
  return [{ label: ctx.label, go: ctx.goModule, module: true }, ...ctx.crumbs];
}

export default function PageTrail({ title, standalone = false, className = '' }) {
  const ctx = useContext(TrailCtx);
  const setPlaced = ctx?.setPlaced;
  // A trail placed by the page tells the shell it need not draw its own.
  useLayoutEffect(() => {
    if (standalone || !setPlaced) return undefined;
    setPlaced((n) => n + 1);
    return () => setPlaced((n) => n - 1);
  }, [standalone, setPlaced]);
  const parts = partsFor(ctx, title);
  if (!parts.length) return null;
  const last = parts.length - 1;
  return (
    <nav className={`page-trail${standalone ? ' page-trail--standalone' : ''}${parts.length > 1 ? ' page-trail--deep' : ''}${className ? ` ${className}` : ''}`} aria-label="Breadcrumb">
      <ol>
        {parts.map((p, i) => (
          <li key={`${i}:${p.label}`} className={i === last ? 'page-trail-parent' : undefined}>
            {/* A phone shows only the level just above, as "< Portfolio". */}
            {i === last && last > 0 && <ChevronLeft size={13} strokeWidth={2.4} className="page-trail-up" aria-hidden="true" />}
            <button type="button" className={p.module ? 'page-trail-module' : undefined} onClick={p.go}
              title={p.module ? `Go to ${p.label}` : `Back up to ${p.label}`}>{p.label}</button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The shell's own trail, for a screen with no title row of its own. */
export function ShellTrail({ hidden = false, flush = false }) {
  const ctx = useContext(TrailCtx);
  if (hidden || !ctx || ctx.placed > 0) return null;
  return <PageTrail standalone className={flush ? 'page-trail--flush' : ''} />;
}
