// Passwords - the "..." beside "+ New": the things a few people need now and
// then (Activity, Trash, Export for an Audit, Select Several, the sort), kept
// off the screen until asked for. Same menu look as "+ New" (AnchoredMenu:
// a portal, outside click, Escape, arrow keys).
import { Fragment, useRef, useState } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import AnchoredMenu from "../components/AnchoredMenu";

export default function MoreMenu({ items = [], onPick, label = "More" }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const panel = useRef(null);
  const pick = (key) => { setOpen(false); onPick?.(key); };
  const onKeyDown = (e) => {
    const rows = [...(panel.current?.querySelectorAll('[role^="menuitem"]') || [])];
    const at = rows.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
    if (to == null || !rows.length) return;
    e.preventDefault();
    rows[(to + rows.length) % rows.length].focus();
  };
  return (
    <>
      <button ref={btn} type="button" className="secondary-btn cv-more" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" className="nx-new-menu" aria-label={label}>
        <div ref={panel} role="none" onKeyDown={onKeyDown}>
          {items.map(({ key, label: text, hint, Icon, sep, checked }) => (
            <Fragment key={key}>
              {sep && <div className="nx-new-sep" role="separator" />}
              <button type="button" role={checked == null ? "menuitem" : "menuitemradio"} aria-checked={checked == null ? undefined : checked} className="nx-new-item" onClick={() => pick(key)}>
                {Icon ? <Icon size={16} aria-hidden="true" /> : <span style={{ width: 16, display: "inline-flex" }}>{checked ? <Check size={14} aria-hidden="true" /> : null}</span>}
                <span className="nx-new-words"><span className="nx-new-label">{text}</span>{hint && <span className="nx-new-hint">{hint}</span>}</span>
              </button>
            </Fragment>
          ))}
        </div>
      </AnchoredMenu>
    </>
  );
}
