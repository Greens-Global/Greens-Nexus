// One lane of steps (Oct 2026): the root Do list, an If's Then / Otherwise,
// an approval's branches, a For Each's body, the fault steps. Reorder by
// grip drag (tickets/DragList) or Move Up / Move Down; Skip and Delete on
// every step; Add Step at the end. Works on one array and hands back the
// next one, so a lane nested in a step is just another StepList.
import { useState } from 'react';
import DragList from '../../tickets/DragList';
import { insertAt, moveAt, patchAt, removeAt, toggleAt } from '../lib/definition';
import AddStepMenu from './AddStepMenu';
import StepCard from './StepCard';
import { hint } from '../lib/text.builder-helpers';
import { isBlankStep } from '../lib/blanks';

export default function StepList({ steps, onChange, ctx, depth = 0, emptyText = 'No steps yet.', addLabel = 'Add Step' }) {
  const list = Array.isArray(steps) ? steps : [];
  const [justAdded, setJustAdded] = useState('');
  const add = (step) => { setJustAdded(step.id); onChange(insertAt(list, step)); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!list.length && <div style={hint}>{emptyText}</div>}
      <DragList items={list} getKey={(s) => s.id} onReorder={onChange} gap={8} label="step"
        renderItem={(step, handle, i) => (
          <StepCard step={step} index={i} count={list.length} handle={handle} ctx={ctx} depth={depth}
            initiallyOpen={step.id === justAdded}
            blank={depth === 0 && isBlankStep(ctx.blanks, i, step.id)}
            onChange={(patch) => onChange(patchAt(list, i, patch))}
            onRemove={() => onChange(removeAt(list, i))}
            onMove={(dir) => onChange(moveAt(list, i, i + dir))}
            onToggle={() => onChange(toggleAt(list, i))} />
        )} />
      <div>
        <AddStepMenu catalog={ctx.catalog} isNew={ctx.isNew} onAdd={add} label={addLabel} compact={depth > 0} />
      </div>
    </div>
  );
}
