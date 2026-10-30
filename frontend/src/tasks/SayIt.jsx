// Say It on New Task (Neil, Oct 30 2026): tap, say the whole task in one
// sentence, and the form fills itself - name, due date, priority, assignee
// (rules in sayTask.js, on the device, no AI). What it understood shows as
// chips; a chip's X puts those words back in the name and the field back to
// what it was. Nothing is created until the person taps Create.
// Browsers that cannot dictate (Firefox) show nothing.
import { useEffect, useRef, useState } from 'react';
import { Mic, X } from 'lucide-react';
import { canDictate, useDictation } from '../lib/voice';
import { parseSpokenTask } from './sayTask';
import { fmtDate } from './lib';
import { localTodayISO } from './components';
import { NX, FONT, btn, PRIORITY_META } from './theme';

const chip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 9px', borderRadius: 999,
  background: 'rgba(37,99,235,0.08)', color: NX.ink, fontSize: 12, fontWeight: 600, maxWidth: '100%',
};
const chipX = { border: 'none', background: 'transparent', cursor: 'pointer', color: NX.dim, display: 'flex', padding: 3, borderRadius: 999 };

/**
 * snapshot() -> { title, dueOn, priority, assigneeIds } as the form stands;
 * onFill(those four) writes them back.
 */
export default function SayIt({ people, myEmail, snapshot, onFill }) {
  const [live, setLive] = useState('');
  const [result, setResult] = useState(null);   // { said, ignore, base, r }
  const heard = useRef('');
  const cancelled = useRef(false);
  const base = useRef(null);
  const wasListening = useRef(false);
  const d = useDictation((t) => { heard.current = `${heard.current} ${t}`.trim(); setLive(heard.current); });

  const apply = (said, ignore, baseVals) => {
    const r = parseSpokenTask(said, { people, myEmail, ignore, today: localTodayISO() });
    onFill({
      title: r.title || baseVals.title,
      dueOn: r.dueOn || baseVals.dueOn,
      priority: r.priority || baseVals.priority,
      assigneeIds: r.assigneeIds.length ? r.assigneeIds : baseVals.assigneeIds,
    });
    setResult({ said, ignore, base: baseVals, r });
  };

  // The sentence is read once the microphone stops - Done, a pause, or the
  // browser's own time limit.
  useEffect(() => {
    if (d.listening) { wasListening.current = true; return; }
    if (!wasListening.current) return;
    wasListening.current = false;
    if (!cancelled.current && heard.current) apply(heard.current, [], base.current);
  }, [d.listening]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canDictate()) return null;

  const start = () => {
    cancelled.current = false;
    heard.current = '';
    setLive('');
    base.current = snapshot();
    d.start();
  };
  const cancel = () => { cancelled.current = true; d.stop(); };
  const undo = (kind) => apply(result.said, [...result.ignore, kind], result.base);

  const nameOf = (email) => (email === myEmail ? 'You' : people.find((p) => p.email === email)?.name || email);
  const label = (m) => (m.kind === 'date' ? `Due ${fmtDate(m.value)}`
    : m.kind === 'priority' ? `${PRIORITY_META[m.value]?.label || m.value} Priority`
      : m.value.map(nameOf).join(', '));
  const kindName = { date: 'Due Date', priority: 'Priority', assignee: 'Assignee' };

  if (d.listening) {
    return (
      <div role="status" aria-live="polite" style={{ border: `1px solid ${NX.red}`, borderRadius: 12, padding: '10px 12px', background: 'rgba(220,38,38,0.05)', fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: NX.ink }}>
          <span className="nx-rec-dot" aria-hidden="true" /> Listening - say the whole task
        </div>
        <div style={{ fontSize: 14, color: live ? NX.ink : NX.faint, margin: '6px 0 10px', lineHeight: 1.4 }}>
          {live ? `"${live}"` : 'Like "Call the vendor about the leak Friday, high priority, for Bob"'}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={cancel} style={btn('ghost')}>Cancel</button>
          <button type="button" onClick={() => d.stop()} style={btn('primary')}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={start} aria-label="Say It - speak the whole task"
          style={{ ...btn('outline'), gap: 6, fontWeight: 700, color: NX.primary, borderColor: NX.primary }}>
          <Mic size={15} aria-hidden="true" /> Say It
        </button>
        {!result && <span style={{ fontSize: 12, color: NX.faint }}>Say the whole task: what, when, who</span>}
        {result && result.r.matched.map((m) => (
          <span key={m.kind} style={chip} title={`Heard "${m.words}"`}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(m)}</span>
            <button type="button" style={chipX} aria-label={`Undo ${kindName[m.kind]} from Say It`} title="Put these words back in the name"
              onClick={() => undo(m.kind)}><X size={12} aria-hidden="true" /></button>
          </span>
        ))}
      </div>
      {result && (
        <div style={{ fontSize: 12, color: NX.faint, lineHeight: 1.4 }}>
          Heard "{result.said}". Check the details, then create the task.
        </div>
      )}
      {d.error && <div role="alert" style={{ fontSize: 12, color: NX.red }}>{d.error}</div>}
    </div>
  );
}
