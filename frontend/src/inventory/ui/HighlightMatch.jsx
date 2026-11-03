// Item Management - Search-term highlight.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).

// Highlights the active search query inside a name - flashes on arrival (CSS
// animation), then stays softly marked. key={q} remounts the <mark> when the
// query changes so the flash replays for each new search.
export function HighlightMatch({ text, query }) {
  const q = (query || '').trim().replace(/^#/, '');
  if (!q || !text) return text ?? null;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark key={q} className="search-hit">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}
