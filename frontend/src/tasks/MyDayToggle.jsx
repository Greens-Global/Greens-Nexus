// "Add To My Day" / "Remove From My Day" outside the My Day tab (Oct 22 2026):
// the sun in the task drawer's header, and the item in a list row's menu.
// Both read and change the one My Day copy (tasks/myDay.js), so the tab
// shows the change at once.
import { Sun } from 'lucide-react';
import { useMyDay } from './myDay';
import { NX, btn } from './theme';

const labelFor = (on) => (on ? 'Remove From My Day' : 'Add To My Day');

/** The drawer header's sun: filled amber while the task is on today's list. */
export default function MyDayToggle({ task }) {
  const myDay = useMyDay();
  if (!task?.id || !myDay.me) return null;
  const on = myDay.has(task.id);
  const label = labelFor(on);
  return (
    <button type="button" data-testid="myday-toggle" onClick={() => (on ? myDay.remove(task) : myDay.add(task))}
      title={label} aria-label={label} aria-pressed={on}
      style={{ ...btn('ghost'), padding: 7, color: on ? NX.amber : NX.faint }}>
      <Sun size={16} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

/** A row menu's item. `onDone` closes the menu. */
export function MyDayMenuItem({ task, style, onDone }) {
  const myDay = useMyDay();
  if (!task?.id || !myDay.me) return null;
  const on = myDay.has(task.id);
  return (
    <button type="button" role="menuitem" style={style}
      onClick={() => { onDone?.(); if (on) myDay.remove(task); else myDay.add(task); }}>
      <Sun size={13} style={{ color: on ? NX.amber : NX.faint }} fill={on ? 'currentColor' : 'none'} />{labelFor(on)}
    </button>
  );
}
