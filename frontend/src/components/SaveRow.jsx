import { useState } from 'react';
import { Check } from 'lucide-react';
import { Spinner } from './AsyncState';
import { formatTime } from '../lib/datetime';
import LoadingButton from '../ui/LoadingButton';

// The one Save row of a Settings form (Oct 23 2026): at the foot of the
// group, Save disabled until something changed, Discard Changes beside it
// while there is something to discard, the spinner on the button while it
// saves, and - for a company's own copy of a layered setting - Use the
// Default on the left. Switches, selects and chip lists save on change and
// never show this row; a form with typed fields always does.
//   note      a line on the left ("Last changed by ...", a hint, which
//             fields this row saves when the card also has instant controls)
//   children  anything else to sit on the left (an action button, say)
// After a save lands (busy ends with nothing left to save) the note says
// "Saved 2:41 PM" until the next edit; the panel's toast still shows.
export default function SaveRow({
  dirty = false, busy = false, onSave, onDiscard, label = 'Save', saveDisabled = false,
  onUseDefault, useDefaultLabel = 'Use the Default', useDefaultBusy = false,
  note, children, style,
}) {
  const [seen, setSeen] = useState({ busy, dirty, savedAt: null });
  if (seen.busy !== busy || seen.dirty !== dirty) {
    let savedAt = seen.savedAt;
    if (seen.busy && !busy && !dirty) savedAt = new Date();
    if (dirty) savedAt = null;
    setSeen({ busy, dirty, savedAt });
  }
  const line = dirty ? 'Unsaved changes' : seen.savedAt ? `Saved ${formatTime(seen.savedAt)}` : note;
  return (
    <div data-save-row="" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)', ...style }}>
      {onUseDefault && (
        <button type="button" className="secondary-btn" onClick={onUseDefault} disabled={busy || useDefaultBusy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          {useDefaultBusy && <Spinner size={13} />} {useDefaultLabel}
        </button>
      )}
      {children}
      <span aria-live="polite" style={{ fontSize: 12, color: dirty ? 'hsl(var(--color-orange))' : 'var(--muted)', flex: '1 1 160px', minWidth: 0, fontWeight: dirty ? 600 : 400 }}>
        {line}
      </span>
      {dirty && onDiscard && (
        <button type="button" className="secondary-btn" onClick={onDiscard} disabled={busy} style={{ fontSize: 12.5 }}>Discard Changes</button>
      )}
      <LoadingButton onClick={onSave} busy={busy} done={!!seen.savedAt} disabled={!dirty || saveDisabled} icon={<Check size={13} />}>
        {label}
      </LoadingButton>
    </div>
  );
}
