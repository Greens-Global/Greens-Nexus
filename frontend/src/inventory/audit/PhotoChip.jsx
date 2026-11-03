// Item Management - A photo value in the activity log.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState } from 'react';

// Render an audit field value: photos show as a thumbnail (old = dim/red ring,
// new = green ring), everything else as text. Broken images fall back to a label.
export function PhotoChip({ url, kind }) {
  const [err, setErr] = useState(false);
  if (err) return <span style={{ fontSize:11.5, color:'var(--muted)' }}>image</span>;
  return <img src={url} alt="item photo" loading="lazy" onError={() => setErr(true)}
    onClick={() => window.open(url, '_blank', 'noopener')} title="Open full image"
    style={{ width:40, height:40, objectFit:'cover', borderRadius:7, cursor:'zoom-in', verticalAlign:'middle',
      border: `2px solid ${kind === 'from' ? 'hsla(var(--color-red),0.55)' : kind === 'to' ? 'hsl(var(--color-green))' : 'var(--line)'}`,
      opacity: kind === 'from' ? 0.65 : 1 }} />;
}
