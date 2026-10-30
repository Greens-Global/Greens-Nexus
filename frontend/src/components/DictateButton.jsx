// The mic beside a text box (Neil, Oct 30 2026): tap, talk, and the words
// are typed where the cursor is - the same browser speech service as Notes'
// Dictate (lib/voice.js useDictation). Tap again (or pause long enough) to
// stop. Browsers that cannot dictate (Firefox) get no button at all.
//
//   <DictateButton target={ref} />         types into an <input>/<textarea>
//   <DictateButton onText={(t) => ...} />  hands each phrase to the caller
//
// A plain React-controlled box takes the words through insertAtCursor, which
// sets the value the way typing would and fires an input event, so the
// box's own onChange (and its draft, dirty flag, validation) sees it.
import { Mic } from 'lucide-react';
import { canDictate, useDictation, insertAtCursor } from '../lib/voice';



export default function DictateButton({ target, onText, size = 16, className = '', style, title = 'Dictate' }) {
  const d = useDictation((t) => { if (onText) onText(t); else insertAtCursor(target?.current, t); });
  if (!canDictate()) return null;
  const label = d.listening ? 'Stop Dictating' : `${title} - type what you say`;
  return (
    <span className="nx-dictate">
      <button type="button" className={`nx-mic${d.listening ? ' is-on' : ''} ${className}`.trim()} style={style}
        aria-label={label} title={label} aria-pressed={d.listening}
        // Keep the box's cursor where it is: the words go there.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (d.listening ? d.stop() : d.start())}>
        <Mic size={size} aria-hidden="true" />
      </button>
      {(d.listening || d.error) && (
        <span className={`nx-dictate-live${d.error ? ' is-bad' : ''}`} role={d.error ? 'alert' : 'status'}>
          {d.error || (d.interim ? `"${d.interim}"` : 'Listening…')}
        </span>
      )}
    </span>
  );
}
