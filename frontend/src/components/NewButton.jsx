// "+ New" - the ONE create button across Nexus (Neil, 11/13/2026: "let's
// stick with that instead of + Create ... consistent across Nexus"). A green
// primary button that says New; with more than one thing to start it opens a
// menu of them (icon, name, one short line), with only one it starts it.
//
//   <NewButton items={[{ key, label, hint, Icon, sep }]} onPick={(key) => ...} />
//
// The menu is AnchoredMenu (a portal: outside click, Escape, never clipped);
// it opens with the first row focused and arrow keys, Home and End move
// through it. `className` goes on the button (e.g. a module's own button
// class); `testId` lands as data-testid.
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import AnchoredMenu from './AnchoredMenu';

export default function NewButton({ items = [], onPick, className = 'primary-btn', compact = false, testId, title = '', menuLabel = 'New', style }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const panel = useRef(null);
  const single = items.length === 1 ? items[0] : null;

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => panel.current?.querySelector('[role="menuitem"]')?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const pick = (key) => { setOpen(false); onPick?.(key); };
  const onKeyDown = (e) => {
    const rows = [...(panel.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    rows[(to + rows.length) % rows.length].focus();
  };

  return (
    <>
      <button ref={btn} type="button" className={`${className} nx-new-btn${compact ? ' is-compact' : ''}`} data-testid={testId}
        aria-haspopup={single ? undefined : 'menu'} aria-expanded={single ? undefined : open}
        aria-label={single ? `New ${single.label}` : 'New'} title={title || (single ? `New ${single.label}` : 'Start something new')}
        style={style}
        onClick={() => (single ? pick(single.key) : setOpen((o) => !o))}
        onKeyDown={(e) => { if (!single && e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        <Plus size={15} aria-hidden="true" /> New{!single && <ChevronDown size={14} className="nx-new-caret" aria-hidden="true" />}
      </button>
      {!single && (
        <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" className="nx-new-menu" aria-label={menuLabel}>
          <div ref={panel} role="none" onKeyDown={onKeyDown}>
            {items.map(({ key, label, hint, Icon, sep }) => (
              <Fragment key={key}>
                {sep && <div className="nx-new-sep" role="separator" />}
                <button type="button" role="menuitem" className="nx-new-item" onClick={() => pick(key)}>
                  {Icon && <Icon size={16} aria-hidden="true" />}
                  <span className="nx-new-words"><span className="nx-new-label">{label}</span>{hint && <span className="nx-new-hint">{hint}</span>}</span>
                </button>
              </Fragment>
            ))}
          </div>
        </AnchoredMenu>
      )}
    </>
  );
}
