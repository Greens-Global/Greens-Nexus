import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Search, LayoutDashboard, Package, ClipboardList, ShoppingCart, CornerDownLeft } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { useInventory } from '../contexts/InventoryContext';
import { useRequisitions } from '../contexts/RequisitionContext';
import { NAV } from './Sidebar';
import { SUBMENUS } from './MobileMenu';

// ── Global search palette ─────────────────────────────────────────────────────
// Ctrl/Cmd+K (or the header search button) from anywhere. Searches screens
// (modules + their sub-tabs, role-gated exactly like the sidebar), inventory
// items, checkouts, and purchase requisitions — all from data the app already
// holds in its contexts, so opening it costs no extra requests.
export default function GlobalSearch({ onNavigate }) {
  const { can, myGrantedModules } = useRole();
  const { items = [], checkouts = [] } = useInventory() || {};
  const { requisitions = [] } = useRequisitions() || {};

  const [open,      setOpen]      = useState(false);
  const [query,     setQuery]     = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef  = useRef(null);

  // Open triggers: Ctrl/Cmd+K anywhere, or the custom event from TopHeader
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('nexus:search-open', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('nexus:search-open', onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery(''); setActiveIdx(0);
      // autofocus after the panel paints
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      document.body.style.overflow = 'hidden';
      return () => { clearTimeout(t); document.body.style.overflow = ''; };
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  const go = useCallback((view, sub = null) => {
    onNavigate(view, sub);
    setOpen(false);
  }, [onNavigate]);

  // Screens registry: sidebar NAV (same role gating) + each module's sub-tabs
  const screens = useMemo(() => {
    const visible = NAV.filter(i => !i.divider && (!i.minRole || can?.(i.minRole) || myGrantedModules?.has(i.view)));
    const out = [];
    for (const item of visible) {
      out.push({ view: item.view, sub: null, label: item.label, context: null });
      const entry = SUBMENUS[item.view];
      const subs = !entry ? null : Array.isArray(entry) ? entry : (can?.('manager') ? entry.manager : entry.employee);
      if (subs) for (const s of subs) out.push({ view: item.view, sub: s.sub, label: s.label, context: item.label });
    }
    return out;
  }, [can, myGrantedModules]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const match = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
    const out = [];

    for (const s of screens) {
      if (match(s.label, s.context, s.view)) {
        out.push({
          type: 'Screens', Icon: LayoutDashboard,
          title: s.label, detail: s.context,
          run: () => go(s.view, s.sub),
        });
      }
      if (out.length >= 6) break;
    }

    let n = 0;
    for (const i of items) {
      if (n >= 5) break;
      if (match(i.name, i.make, i.model, i.itemType, i.location)) {
        n++;
        out.push({
          type: 'Items', Icon: Package,
          title: i.name,
          detail: [i.itemType, i.location, i.status?.replace(/_/g, ' ')].filter(Boolean).join(' · '),
          run: () => go('inventory', can?.('supervisor') ? 'manage' : 'catalog'),
        });
      }
    }

    n = 0;
    for (const c of checkouts) {
      if (n >= 4) break;
      if (match(c.itemName, c.requestedBy)) {
        n++;
        out.push({
          type: 'Checkouts', Icon: ClipboardList,
          title: c.itemName,
          detail: [c.requestedBy, c.status?.replace(/_/g, ' ')].filter(Boolean).join(' · '),
          run: () => go('inventory', can?.('manager') ? 'checkouts' : 'myitems'),
        });
      }
    }

    n = 0;
    for (const r of requisitions) {
      if (n >= 4) break;
      if (match(r.item, r.employeeName, r.id)) {
        n++;
        out.push({
          type: 'Purchase Requests', Icon: ShoppingCart,
          title: `${r.item} — ${r.employeeName}`,
          detail: [r.id, (r.status || '').replace(/_/g, ' ')].filter(Boolean).join(' · '),
          run: () => go('purchase', 'log'),
        });
      }
    }

    return out;
  }, [query, screens, items, checkouts, requisitions, can, go]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  // Keep the highlighted row scrolled into view during keyboard nav
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  function onKeyDown(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(results.length - 1, i + 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    if (e.key === 'Enter' && results[activeIdx]) { results[activeIdx].run(); }
  }

  if (!open) return null;

  // Section headers appear when the result type changes
  let lastType = null;

  return (
    <div className="gs-overlay" onClick={e => e.target === e.currentTarget && close()}>
      <div className="gs-panel" role="search" aria-label="Global search">
        <div className="gs-input-row">
          <Search size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="gs-input"
            placeholder="Search screens, items, checkouts, requests…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="gs-kbd">esc</kbd>
        </div>

        {query.trim() && (
          <div className="gs-results" ref={listRef}>
            {results.length === 0 ? (
              <div className="gs-empty">No matches for “{query}”</div>
            ) : results.map((r, i) => {
              const header = r.type !== lastType ? r.type : null;
              lastType = r.type;
              return (
                <div key={i}>
                  {header && <div className="gs-section">{header}</div>}
                  <button
                    className="gs-row"
                    data-active={i === activeIdx}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={r.run}>
                    <r.Icon size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span className="gs-row-title">{r.title}</span>
                    {r.detail && <span className="gs-row-detail">{r.detail}</span>}
                    {i === activeIdx && <CornerDownLeft size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!query.trim() && (
          <div className="gs-hint">
            Jump to any screen, or find an item, checkout, or purchase request.
          </div>
        )}
      </div>
    </div>
  );
}
