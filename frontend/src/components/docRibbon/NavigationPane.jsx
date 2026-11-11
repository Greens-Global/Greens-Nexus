// Word's View > Navigation pane (11/11/2026): Headings, Pages and Results.
// It floats over the desk's left margin (the old Pages rail lived here for
// good; now it is one tab, open only when asked for). Headings: a click goes
// there. Pages: the sheets as thumbnails (the builder draws them). Results:
// every match of the search box, with the words around it.
import { X, Search } from 'lucide-react';

const TABS = [['headings', 'Headings'], ['pages', 'Pages'], ['results', 'Results']];

export default function NavigationPane({ tab = 'headings', onTab, headings, onGo, pages, onClose, query = '', onQuery, results = null, onResult, activeResult = -1 }) {
  const tabs = TABS.filter(([k]) => k !== 'pages' || pages);
  const shown = tabs.some(([k]) => k === tab) ? tab : 'headings';
  return (
    <div className="doc-navpane">
      <div className="doc-navpane-head">
        <span>Navigation</span>
        <button type="button" onClick={onClose} title="Close" aria-label="Close Navigation" className="doc-status-btn"><X size={14} /></button>
      </div>
      {onQuery && (
        <label className="doc-navpane-search">
          <Search size={13} aria-hidden="true" />
          <input value={query} placeholder="Search document" aria-label="Search document"
            onChange={(e) => { onQuery(e.target.value); if (e.target.value) onTab?.('results'); }} />
        </label>
      )}
      <div className="doc-navpane-tabs" role="tablist" aria-label="Navigation">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={shown === k} className={shown === k ? 'is-on' : ''} onClick={() => onTab?.(k)}>{label}</button>
        ))}
      </div>
      <div className="doc-navpane-body" role="tabpanel" aria-label={tabs.find(([k]) => k === shown)?.[1]}>
        {shown === 'headings' && (headings.length === 0 ? (
          <p className="doc-navpane-empty">Add headings (Home &gt; Styles) and they show here.</p>
        ) : headings.map((h, i) => (
          <button key={`${h.pageId}-${h.pos}-${i}`} type="button" className="doc-navpane-item" style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
            onClick={() => onGo(h)} title={`Page ${h.page}`}>{h.text}</button>
        )))}
        {shown === 'pages' && pages}
        {shown === 'results' && (
          !query ? <p className="doc-navpane-empty">Type in the search box to find text in the document.</p>
            : !results?.length ? <p className="doc-navpane-empty">No results for &quot;{query}&quot;.</p>
              : (
                <>
                  <p className="doc-navpane-count">{results.length === 1 ? '1 result' : `${results.length} results`}</p>
                  {results.map((r, i) => (
                    <button key={`${r.pageId}-${r.from}`} type="button" className={`doc-navpane-result${i === activeResult ? ' is-on' : ''}`} onClick={() => onResult?.(i)}>
                      <span>{r.before}</span><mark>{r.match}</mark><span>{r.after}</span>
                    </button>
                  ))}
                </>
              )
        )}
      </div>
    </div>
  );
}
