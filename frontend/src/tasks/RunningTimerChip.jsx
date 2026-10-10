// Task Module - the running timer, visible on every Tasks screen (Oct 2026):
// elapsed time, the task it is on (click opens it), and Stop. Renders nothing
// when no timer is running.
import { Square, Timer } from 'lucide-react';
import { useTasks } from './TasksContext';
import { NX, FONT, btn } from './theme';
import { useElapsed } from './TimeTracking';

export default function RunningTimerChip() {
  const { runningTimer, stopTimer } = useTasks();
  const elapsed = useElapsed(runningTimer?.entry?.startedAt);
  if (!runningTimer?.entry) return null;
  const title = runningTimer.task?.title || 'a task';
  const open = () => { if (runningTimer.task?.id) window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: runningTimer.task.id } })); };
  return (
    <div role="status" aria-label={`Timer running on ${title}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 6px 4px 10px', borderRadius: 999, border: `1px solid ${NX.green}`, background: `${NX.green}14`, fontFamily: FONT, fontSize: 12.5, maxWidth: 360 }}>
      <Timer size={14} style={{ color: NX.green, flexShrink: 0 }} />
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: NX.green }}>{elapsed}</span>
      <button type="button" onClick={open} title={title} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, fontSize: 12.5, color: NX.ink, padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{title}</button>
      <button type="button" onClick={() => stopTimer().catch(() => {})} aria-label="Stop timer" title="Stop timer" style={{ ...btn('ghost'), padding: 4, color: NX.red }}><Square size={12} /></button>
    </div>
  );
}
