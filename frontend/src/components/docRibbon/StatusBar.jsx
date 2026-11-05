// Word's status bar: Page X of Y, the word count, the language, and the zoom
// controls on the right (the floating pill that used to sit over the page).
import { ZoomIn, ZoomOut } from 'lucide-react';

export default function StatusBar({ page, pages, words, zoom, setZoom, onFit, onPageWidth, onWordCount }) {
  const pct = Math.round(zoom * 100);
  return (
    <div className="doc-status" role="status">
      <span>Page {page} of {pages}</span>
      <button type="button" className="doc-status-link" onClick={onWordCount} title="Word Count">{words} {words === 1 ? 'word' : 'words'}</button>
      <span>English (U.S.)</span>
      <span className="doc-status-spacer" />
      <button type="button" className="doc-status-btn" title="Zoom Out" onClick={() => setZoom(Math.max(0.5, Math.round((zoom - 0.1) * 100) / 100))} disabled={zoom <= 0.5}><ZoomOut size={14} /></button>
      <input type="range" min={50} max={200} step={10} value={pct} onChange={(e) => setZoom(Number(e.target.value) / 100)} aria-label="Zoom" title={`Zoom ${pct}%`} />
      <button type="button" className="doc-status-btn" title="Zoom In" onClick={() => setZoom(Math.min(2, Math.round((zoom + 0.1) * 100) / 100))} disabled={zoom >= 2}><ZoomIn size={14} /></button>
      <button type="button" className="doc-status-link" title="Reset to 100%" onClick={() => setZoom(1)} style={{ minWidth: 38, textAlign: 'right', fontWeight: 700 }}>{pct}%</button>
      <button type="button" className="doc-status-link" title="Page Width" onClick={onPageWidth}>Page Width</button>
      <button type="button" className="doc-status-link" title="Fit the whole page" onClick={onFit}>Fit</button>
    </div>
  );
}
