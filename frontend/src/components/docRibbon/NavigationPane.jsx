// Word's View > Navigation pane: the document's headings; a click goes there.
import { X } from 'lucide-react';

export default function NavigationPane({ headings, onGo, onClose }) {
  return (
    <aside className="doc-navpane" aria-label="Navigation">
      <div className="doc-navpane-head">
        Navigation
        <button type="button" onClick={onClose} title="Close" className="doc-status-btn"><X size={14} /></button>
      </div>
      {headings.length === 0 ? (
        <p className="doc-navpane-empty">Add headings (Home &gt; Styles) and they show here.</p>
      ) : headings.map((h, i) => (
        <button key={`${h.pageId}-${h.pos}-${i}`} type="button" className="doc-navpane-item" style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
          onClick={() => onGo(h)} title={`Page ${h.page}`}>{h.text}</button>
      ))}
    </aside>
  );
}
