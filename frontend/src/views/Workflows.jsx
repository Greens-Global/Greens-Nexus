// Workflows (Oct 28 2026): the lazy root App.jsx mounts for view
// "workflows". The module itself is src/workflows/ (WorkflowsApp and the
// screens); this file only maps the shell's activeSub / onSubChange onto it.
import WorkflowsApp from '../workflows/WorkflowsApp';

export default function Workflows({ activeSub, onSubChange }) {
  return <WorkflowsApp sub={activeSub} go={(sub) => onSubChange?.(sub)} />;
}
