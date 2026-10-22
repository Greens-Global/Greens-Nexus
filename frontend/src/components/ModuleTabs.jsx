import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import AnchoredMenu from './AnchoredMenu';
import TabInk from './TabInk';

/*
Module tab strip -> header center (Work OS shell, Jul 28).

Every module used to render its own `.scroll-tabs` strip inside the page body.
The Work OS shell moves that strip into the center of the top header
(Stella-style: breadcrumb left, module tabs center, actions right). Modules
keep OWNING their tab list - gating (per-tab role checks), labels, and the
activeSub wiring stay in the module. They just declare the strip through
<ModuleTabs> instead of rendering it inline:

    <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />

tabs: [{ key, label, Icon?, badge? }] - Icon optional (Accounting's pills are
label-only); badge is an optional count pill (falsy hides it).

Oct 6 (Charmi and Neil, 10/04): a tab may carry `items: [{ key, label, Icon? }]`
- it then draws as a dropdown (Accounting's Dashboard > Overview / Cash /
Performance / Close). `active` stays the CHILD's key, so every existing sub
key and deep link keeps working; the group lights up when one of its items
is active and names that item beside its own label.

Oct 22 (Neil and Charmi, Accounting's bar - all opt-in, no other module
changes): an item may carry its own `items`, drawn as a row with an arrow
that opens a side flyout (Reports > Financial > Income Statement > T12); a
tab may name a `landing` item that a click on the group opens (Dashboard ->
Overview); and `compactGroups` keeps the picked item's name OUT of the bar,
so choosing a page never widens it.

On desktop the strip renders in the header (TopHeader reads it via
useHeaderTabs). Below 900px the header center is hidden, so <ModuleTabs>
renders the classic in-page `.scroll-tabs` strip itself - phones keep the
swipeable tabs exactly where they were.
*/

const HeaderTabsContext = createContext(null);

export function HeaderTabsProvider({ children }) {
  const [entry, setEntry] = useState(null); // { tabs, active, onChange }
  return (
    <HeaderTabsContext.Provider value={{ entry, setEntry }}>
      {children}
    </HeaderTabsContext.Provider>
  );
}

// TopHeader-facing: the currently published strip, or null (-> header shows
// the plain search bar, e.g. on the dashboard).
export function useHeaderTabs() {
  return useContext(HeaderTabsContext)?.entry ?? null;
}

// mobileInline=false suppresses the <=900px in-page fallback for modules that
// already have their own phone chrome (e.g. Item Management's bottom bar).
// syncTitle: opt-in per module (Time Clock, Aug 31) - when true, TopHeader's
// breadcrumb shows the active tab's `title` (falling back to its `label`)
// instead of the module's own name, so switching tabs actually renames the
// page instead of leaving every tab reading as the module's landing tab.
// Off by default: most modules (Documents, IT, ...) deliberately keep their
// own name in the breadcrumb across tabs, and this must not change that.
//
// inline=true keeps the strip IN THE PAGE at every width and publishes nothing
// to the header, so the module can place its own tabs (the Task module renders
// them in its own bar, below the header, rather than in the header centre).
// Publishing is skipped rather than ignored: a module that draws its own strip
// and also published one would show the same tabs twice on desktop. It makes
// syncTitle moot for that module - nothing is published for TopHeader to read.
//
// compactGroups=true (Accounting, Oct 22): a dropdown tab shows only its own
// label, never "Dashboard · Overview".
export default function ModuleTabs({ tabs, active, onChange, mobileInline = true, syncTitle = false, inline = false, compactGroups = false }) {
  const ctx = useContext(HeaderTabsContext);
  const setEntry = inline ? null : ctx?.setEntry;

  // onChange is almost always a fresh closure each render - keep it in a ref
  // so publishing only re-fires when the tab set or selection actually change.
  // (Written in an effect, not during render: clicks read it at event time,
  // long after commit, so post-render assignment is equivalent and lint-clean.)
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  const itemsSig = (items) => (items ? ` [${items.map(i => `${i.key}:${i.label}${itemsSig(i.items)}`).join(',')}]` : '');
  const signature = tabs.map(t => `${t.key} ${t.label} ${t.title ?? ''} ${t.badge ?? ''}${t.landing ? ` >${t.landing}` : ''}${itemsSig(t.items)}`).join('|');
  useEffect(() => {
    if (!setEntry) return;
    setEntry({ tabs, active, syncTitle, compactGroups, onChange: key => onChangeRef.current?.(key) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setEntry, signature, active, syncTitle, compactGroups]);

  useEffect(() => {
    if (!setEntry) return;
    return () => setEntry(null); // leaving the module empties the header slot
  }, [setEntry]);

  // <=900px fallback - same markup contract as the old in-page strips.
  if (!inline && !mobileInline) return null;
  return (
    <div className={`scroll-tabs module-tabs-inline${inline ? ' module-tabs-inline--always' : ''}`}>
      <TabInk key={signature} active={active} variant="line" />
      {tabs.map(({ key, label, Icon, badge, items, landing }) => (items ? (
        <TabGroupButton key={key} tab={{ key, label, Icon, items, landing }} active={active} onSelect={(k) => onChange?.(k)} className="module-tab-inline-btn" iconSize={16} compact={compactGroups} />
      ) : (
        <button
          key={key}
          className={`module-tab-inline-btn${active === key ? ' active' : ''}`}
          onClick={() => onChange?.(key)}
        >
          {Icon && <Icon size={16} />} {label}
          {badge > 0 && <span className="hdr-tab-badge">{badge}</span>}
        </button>
      )))}
    </div>
  );
}

/** Does this list of items (flyouts included) hold the key `active`? */
const holds = (items, active) => !!items?.some((i) => i.key === active || holds(i.items, active));
/** Is `active` this tab, or one of its dropdown items? */
const tabIsActive = (tab, active) => tab.key === active || holds(tab.items, active);
/** The item `active` names, however deep in the flyouts. */
const findItem = (items, active) => {
  for (const i of items || []) {
    if (i.key === active) return i;
    const hit = findItem(i.items, active);
    if (hit) return hit;
  }
  return null;
};

const MENU_STYLE = { background: 'var(--bg-card, #fff)', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.15)', padding: 4, display: 'grid', gap: 1 };
const rowStyle = (sel, on = sel) => ({ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: 'none', borderRadius: 7, background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', font: 'inherit', fontSize: '0.84rem', fontWeight: on ? 700 : 500, textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap' });

// A tab with a dropdown (Oct 6). The menu is portaled (AnchoredMenu): the
// header strip scrolls sideways, and a scroller would clip a menu drawn
// inside it. Used by the header strip (TopHeader) and the phone strip above,
// each passing its own button class so it looks like its neighbors.
export function TabGroupButton({ tab, active, onSelect, className, iconSize = 16, compact = false }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const { label, Icon, items, landing } = tab;
  const on = tabIsActive(tab, active);
  const current = compact ? null : findItem(items, active);
  const pick = (key) => { setOpen(false); onSelect?.(key); };
  return (
    <>
      <button ref={btn} type="button" className={`${className}${on ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-current={on ? 'page' : undefined}
        onClick={() => {
          // A group with a landing item opens it on the first click (Oct 22,
          // Neil: Dashboard comes up on Overview); the menu still opens.
          if (landing && !on) onSelect?.(landing);
          setOpen((v) => !v);
        }}>
        {Icon && <Icon size={iconSize} strokeWidth={2} />}
        <span>{label}</span>
        {current && current.label !== label && <span className="tab-group-current">{current.label}</span>}
        <ChevronDown size={14} className="tab-group-caret" style={{ opacity: 0.7, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} minWidth={200} aria-label={label} style={MENU_STYLE}>
        <MenuRows items={items} active={active} onPick={pick} />
      </AnchoredMenu>
    </>
  );
}

// The rows of a dropdown. An item with `items` is a row with an arrow whose
// flyout opens beside it, on hover, click or the right arrow key; pointing at
// any other row closes it (Oct 22, Neil: "an arrow here and it pops out and
// you get a secondary menu on the side").
function MenuRows({ items, active, onPick }) {
  const [flyout, setFlyout] = useState(null);
  return items.map((it) => (it.items ? (
    <FlyoutRow key={it.key} item={it} active={active} onPick={onPick} open={flyout === it.key}
      onOpen={() => setFlyout(it.key)} onClose={() => setFlyout((k) => (k === it.key ? null : k))} />
  ) : (
    <button key={it.key} type="button" role="menuitem" aria-current={it.key === active ? 'page' : undefined}
      onMouseEnter={() => setFlyout(null)} onClick={() => onPick(it.key)} style={rowStyle(it.key === active)}>
      {it.Icon ? <it.Icon size={15} /> : null}
      <span style={{ flex: 1 }}>{it.label}</span>
      {it.key === active ? <Check size={14} /> : null}
    </button>
  )));
}

function FlyoutRow({ item, active, onPick, open, onOpen, onClose }) {
  const row = useRef(null);
  const on = holds(item.items, active);
  return (
    <>
      <button ref={row} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open}
        onMouseEnter={onOpen} onClick={() => (open ? onClose() : onOpen())}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); onOpen(); } }}
        style={{ ...rowStyle(false, on), fontWeight: on ? 700 : 500 }}>
        {item.Icon ? <item.Icon size={15} /> : null}
        <span style={{ flex: 1 }}>{item.label}</span>
        <ChevronRight size={14} style={{ opacity: 0.7 }} />
      </button>
      <AnchoredMenu anchorRef={row} open={open} onClose={onClose} side="right" minWidth={200} aria-label={item.label} style={MENU_STYLE}>
        <MenuRows items={item.items} active={active} onPick={onPick} />
      </AnchoredMenu>
    </>
  );
}
