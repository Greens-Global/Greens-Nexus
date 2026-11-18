// What a task name box understood from the sentence typed into it
// (useTypedTask.js), as chips: "Fri 11/20/2026", "High", "Bob Smith". A
// chip's X puts its words back in the name for this entry. The chip is the
// one Say It draws (UnderstoodChip - SayIt.jsx uses it too).
// A screen reader hears what was understood once the typing pauses, not on
// every key.
import { useEffect, useState } from 'react';
import { CalendarDays, User, X } from 'lucide-react';
import { PriorityMark } from '../components/StatusLabel';
import { chipLabel, chipSpoken, understoodText } from './useTypedTask';
import { FS } from '../lib/typeScale';
import { NX, FONT, PRIORITY_META } from './theme';

const chip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 9px', borderRadius: 999,
  background: 'rgba(37,99,235,0.08)', color: NX.ink, fontSize: FS.label, fontWeight: 600, maxWidth: '100%',
};
const chipX = { border: 'none', background: 'transparent', cursor: 'pointer', color: NX.dim, display: 'flex', padding: 3, borderRadius: 999 };

export function UnderstoodChip({ label, title, icon = null, removeLabel, removeTitle = 'Put these words back in the name', onRemove, onMouseDown }) {
  return (
    <span style={chip} title={title}>
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <button type="button" style={chipX} aria-label={removeLabel} title={removeTitle} onMouseDown={onMouseDown} onClick={onRemove}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

const SAY_AFTER_MS = 700;

// Which kind a chip is, at a glance. The priority mark is the module's own,
// colored for Urgent and High only, as everywhere (StatusLabel.jsx).
function kindIcon(c) {
  if (c.kind === 'date') return <CalendarDays size={12} aria-hidden="true" style={{ color: NX.dim, flexShrink: 0 }} />;
  if (c.kind === 'priority') return <PriorityMark priority={c.value} size={12} color={c.value === 'urgent' || c.value === 'high' ? PRIORITY_META[c.value].color : NX.dim} />;
  return <User size={12} aria-hidden="true" style={{ color: NX.dim, flexShrink: 0 }} />;
}

/**
 * `typed` is useTypedTask's result; `inputRef` the name box, which gets the
 * cursor back after a chip is removed so Enter still saves.
 */
export default function TypedTaskChips({ typed, people = [], myEmail = '', inputRef = null, style }) {
  const ctx = { people, myEmail };
  const summary = understoodText(typed.chips, ctx);
  const [said, setSaid] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setSaid(summary), SAY_AFTER_MS);
    return () => clearTimeout(id);
  }, [summary]);
  const remove = (kind) => { typed.remove(kind); inputRef?.current?.focus?.(); };
  return (
    <>
      {typed.chips.length > 0 && (
        <div role="group" aria-label="Understood From the Task Name" data-testid="typed-task-chips"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0, fontFamily: FONT, ...style }}>
          {typed.chips.map((c) => (
            <UnderstoodChip key={c.kind} label={chipLabel(c, ctx)} icon={kindIcon(c)} title={`Read from "${c.words}"`}
              removeLabel={`Remove ${chipSpoken(c, ctx)}`}
              // The cursor stays in the name box under a mouse or a finger.
              onMouseDown={(e) => e.preventDefault()}
              onRemove={() => remove(c.kind)} />
          ))}
        </div>
      )}
      <span className="nx-sr" role="status" aria-live="polite">{said}</span>
    </>
  );
}
