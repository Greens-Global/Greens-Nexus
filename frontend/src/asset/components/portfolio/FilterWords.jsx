import { X } from 'lucide-react';

/**
 * The picks above the list, as words (Neil, 11/17/2026): "Type Self-Storage or Vehicle
 * Storage x", "State California x", then Clear and Save as View; "6 of 23 properties" on the
 * right. No chips: a word and its own small remove button.
 */
export function FilterWords({ words, onRemove, onClear, onSaveView, shown, total }) {
  if (!words.length) return null;
  return (
    <div className="pt-words" aria-label="Filters in use">
      {words.map((w) => (
        <span key={w.key} className="pt-word">
          <span className="pt-dim">{w.title}</span> <b>{w.words}</b>
          <button type="button" className="pt-word-x" aria-label={`Remove ${w.title} ${w.words}`} onClick={() => onRemove(w)}><X size={13} /></button>
        </span>
      ))}
      <button type="button" className="pt-link" onClick={onClear}>Clear</button>
      {onSaveView && <button type="button" className="pt-link" onClick={onSaveView}>Save as View</button>}
      <span className="pt-words-count">{shown} of {total} {total === 1 ? 'property' : 'properties'}</span>
    </div>
  );
}
