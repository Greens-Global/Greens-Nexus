// Word's status bar: Page X of Y (a click opens View > Navigation > Pages),
// the word count, the variables placed (a click opens Variables), Track
// Changes, the language, Word's three view buttons and the zoom on the right.
import { ZoomIn, ZoomOut, BookOpen, FileText, Globe } from 'lucide-react';

export default function StatusBar({ page, pages, words, zoom, setZoom, onFit, onPageWidth, onWordCount, onPages, variables, onVariables, tracking, onTracking, view, onView }) {
  const pct = Math.round(zoom * 100);
  return (
    <div className="doc-status" role="status">
      {onPages ? <button type="button" className="doc-status-link" onClick={onPages} title="Show the pages (View > Navigation)">Page {page} of {pages}</button>
        : <span>Page {page} of {pages}</span>}
      <button type="button" className="doc-status-link" onClick={onWordCount} title="Word Count">{words} {words === 1 ? 'word' : 'words'}</button>
      {variables != null && (
        <button type="button" className="doc-status-link" onClick={onVariables} title="Variables used in this document">
          {variables === 1 ? '1 Variable' : `${variables} Variables`}
        </button>
      )}
      {tracking != null && (
        <button type="button" className="doc-status-link" onClick={onTracking} title="Review > Track Changes">
          Track Changes: {tracking === 'off' ? 'Off' : tracking === 'mine' ? 'Just Mine' : 'On'}
        </button>
      )}
      <span className="doc-status-lang">English (U.S.)</span>
      <span className="doc-status-spacer" />
      {onView && (
        <span className="doc-status-views" role="group" aria-label="Views">
          <button type="button" className="doc-status-btn" title="Read Mode" aria-label="Read Mode" aria-pressed={view === 'read'} onClick={() => onView('read')}><BookOpen size={14} /></button>
          <button type="button" className="doc-status-btn" title="Print Layout" aria-label="Print Layout" aria-pressed={view === 'print'} onClick={() => onView('print')}><FileText size={14} /></button>
          <button type="button" className="doc-status-btn" title="Web Layout" aria-label="Web Layout" aria-pressed={view === 'web'} onClick={() => onView('web')}><Globe size={14} /></button>
        </span>
      )}
      <button type="button" className="doc-status-btn" title="Zoom Out" onClick={() => setZoom(Math.max(0.5, Math.round((zoom - 0.1) * 100) / 100))} disabled={zoom <= 0.5}><ZoomOut size={14} /></button>
      <input type="range" min={50} max={200} step={10} value={pct} onChange={(e) => setZoom(Number(e.target.value) / 100)} aria-label="Zoom" title={`Zoom ${pct}%`} />
      <button type="button" className="doc-status-btn" title="Zoom In" onClick={() => setZoom(Math.min(2, Math.round((zoom + 0.1) * 100) / 100))} disabled={zoom >= 2}><ZoomIn size={14} /></button>
      <button type="button" className="doc-status-link" title="Reset to 100%" onClick={() => setZoom(1)} style={{ minWidth: 38, textAlign: 'right', fontWeight: 700 }}>{pct}%</button>
      <button type="button" className="doc-status-link" title="Page Width" onClick={onPageWidth}>Page Width</button>
      <button type="button" className="doc-status-link" title="Fit the whole page" onClick={onFit}>Fit</button>
    </div>
  );
}
