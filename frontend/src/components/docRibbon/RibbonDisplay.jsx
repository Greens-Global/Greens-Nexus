// Word's Ribbon Display Options (11/11/2026), at the right end of the tab
// row: Classic Ribbon (every group, the full height), Simplified Ribbon (one
// line of the most used buttons) and Show Tabs Only (Ctrl+F1). The chevron
// beside it folds the ribbon to its tabs and back.
import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Check } from 'lucide-react';
import AnchoredMenu from '../AnchoredMenu';

export const RIBBON_MODES = [
  ['classic', 'Classic Ribbon', 'Every group, with labels'],
  ['simplified', 'Simplified Ribbon', 'One line of the most used buttons'],
  ['tabs', 'Show Tabs Only', 'Click a tab to open its buttons'],
];

export default function RibbonDisplay({ mode, onMode, onToggle }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const current = RIBBON_MODES.find(([k]) => k === mode) || RIBBON_MODES[0];
  return (
    <span className="doc-ribbon-display">
      <button ref={btn} type="button" className="doc-ribbon-display-btn" aria-haspopup="menu" aria-expanded={open}
        title="Ribbon Display Options" onClick={() => setOpen((o) => !o)}>
        {current[1]} <ChevronDown size={11} aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" minWidth={240}
        className="doc-toolbar doc-ribbon doc-ribbon-panel" aria-label="Ribbon Display Options">
        {RIBBON_MODES.map(([k, label, hint]) => (
          <button key={k} type="button" role="menuitemradio" aria-checked={mode === k} className={`doc-ribbon-item${mode === k ? ' is-active' : ''}`}
            onClick={() => { onMode(k); setOpen(false); }}>
            <span className="doc-ribbon-display-tick">{mode === k ? <Check size={13} /> : null}</span>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span>{label}</span>
              <span className="doc-ribbon-item-hint" style={{ marginLeft: 0 }}>{hint}</span>
            </span>
          </button>
        ))}
      </AnchoredMenu>
      <button type="button" className="doc-ribbon-display-fold" onClick={onToggle}
        title={mode === 'tabs' ? 'Show the Ribbon (Ctrl+F1)' : 'Show Tabs Only (Ctrl+F1)'} aria-label={mode === 'tabs' ? 'Show the Ribbon' : 'Show Tabs Only'}>
        {mode === 'tabs' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </span>
  );
}
