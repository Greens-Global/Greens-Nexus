import { createContext, useContext, useEffect, useRef, useState } from 'react';

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
export default function ModuleTabs({ tabs, active, onChange, mobileInline = true }) {
  const ctx = useContext(HeaderTabsContext);
  const setEntry = ctx?.setEntry;

  // onChange is almost always a fresh closure each render - keep it in a ref
  // so publishing only re-fires when the tab set or selection actually change.
  // (Written in an effect, not during render: clicks read it at event time,
  // long after commit, so post-render assignment is equivalent and lint-clean.)
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  const signature = tabs.map(t => `${t.key} ${t.label} ${t.badge ?? ''}`).join('|');
  useEffect(() => {
    if (!setEntry) return;
    setEntry({ tabs, active, onChange: key => onChangeRef.current?.(key) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setEntry, signature, active]);

  useEffect(() => {
    if (!setEntry) return;
    return () => setEntry(null); // leaving the module empties the header slot
  }, [setEntry]);

  // <=900px fallback - same markup contract as the old in-page strips.
  if (!mobileInline) return null;
  return (
    <div className="scroll-tabs module-tabs-inline">
      {tabs.map(({ key, label, Icon, badge }) => (
        <button
          key={key}
          className={`module-tab-inline-btn${active === key ? ' active' : ''}`}
          onClick={() => onChange?.(key)}
        >
          {Icon && <Icon size={16} />} {label}
          {badge > 0 && <span className="hdr-tab-badge">{badge}</span>}
        </button>
      ))}
    </div>
  );
}
