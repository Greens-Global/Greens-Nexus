// Stickies to Tasks (Neil, 11/10/2026): the selected stickies, one per line,
// in Add Several (tasks/AddSeveralModal.jsx) - the ONE many-tasks-at-once
// path, POST /tasks/import, its dry run first, one bell and one batched
// email per person. Lazy: the Tasks store loads only when someone asks.
import { TasksProvider } from '../../tasks/TasksContext';
import AddSeveralModal from '../../tasks/AddSeveralModal';

export default function StickyTasks({ lines, onDone, onClose }) {
  return (
    <TasksProvider>
      <AddSeveralModal defaults={{ text: lines.join('\n'), source: 'paste' }} onDone={onDone} onClose={onClose} zIndex={4200} />
    </TasksProvider>
  );
}
