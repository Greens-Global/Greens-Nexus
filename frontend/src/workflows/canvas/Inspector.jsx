// The side panel (10/30/2026). With a block selected it shows that block's
// controls - the very same ones the recipe's cards draw (TriggerCard,
// ConditionsCard, StepCard's Editor) so the two views can never disagree -
// with Move Up / Move Down, Skip and Remove under a step. With nothing
// selected it shows whatever the builder hands it (the Settings / Test /
// Versions rail); the rail stays mounted, only hidden, while a block is
// open, so a test result is still there when the block closes. Escape
// clears the selection.
import { useEffect } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, Filter, Trash2 } from 'lucide-react';
import { btn } from '../../tasks/theme';
import { describeStep } from '../lib/text';
import { findAction, getLane, moveStep, newStep, removeStep, toggleStep } from '../lib/definition';
import { moduleLabel, sortModules } from '../lib/modules';
import TriggerCard from '../builder/TriggerCard';
import ConditionsCard from '../builder/ConditionsCard';
import { Editor } from '../builder/StepCard';
import { CANVAS_ICONS, KIND_LABEL, nodeColor } from './palette';
import { locate, patchStep } from './edits';

// The ctx a step inside one or more For Each lanes edits with: each loop on
// the way down adds its name, so {{ item.name }} offers the right lists.
// Walks every numeric segment of the lane path (an approval lane is three
// segments long - 'branches', the option, the index - an If's two), the
// way lib/definition.js's problems() does.
function ctxFor(ctx, definition, path) {
  const names = [];
  for (let i = 1; i < path.length; i++) {
    if (typeof path[i] !== 'number') continue;
    const step = getLane(definition, path.slice(0, i))[path[i]];
    if (step && step.kind === 'for_each' && path[i + 1] === 'steps') names.push(step.as || 'item');
  }
  return names.length ? { ...ctx, loopNames: [...(ctx.loopNames || []), ...names] } : ctx;
}

// An action step dropped from the dock has no action yet: pick one here.
function ActionPicker({ catalog, onPick, id }) {
  const actions = catalog?.actions || [];
  const modules = sortModules(actions.map((a) => a.module));
  return (
    <div>
      <label className="wfc-fieldlbl" htmlFor={id}>Which Action</label>
      <select id={id} className="wfc-select" defaultValue="" onChange={(e) => { const def = findAction(catalog, e.target.value); if (def) onPick(def); }}>
        <option value="" disabled>Choose an action</option>
        {modules.map((m) => (
          <optgroup key={m} label={moduleLabel(m)}>
            {actions.filter((a) => a.module === m).map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function Selected({ definition, catalog, ctx, selectedId, nodes, onChange, onSelect, canEdit, people, isNew, entityDef, eventDef }) {
  const close = () => onSelect(null);

  if (selectedId === 'trigger') {
    return (
      <>
        <div className="wfc-panel-hd">
          <span className="wfc-ic" style={{ background: '#475569' }} aria-hidden="true"><CANVAS_ICONS.trigger /></span>
          <div><div className="wfc-panel-k">Trigger</div><div className="wfc-panel-n">When This Happens</div></div>
          <button type="button" className="wfc-panel-x" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="wfc-panel-bd" key="trigger">
          <TriggerCard definition={definition} onChange={onChange} catalog={catalog} isNew={isNew} people={people} open onToggle={close} />
        </div>
        <div className="wfc-panel-ft">
          <button type="button" onClick={() => onSelect('gate')} style={btn('outline')}><Filter size={13} /> Only If Conditions</button>
        </div>
      </>
    );
  }

  if (selectedId === 'gate') {
    return (
      <>
        <div className="wfc-panel-hd">
          <span className="wfc-ic" style={{ background: '#475569' }} aria-hidden="true"><CANVAS_ICONS.gate /></span>
          <div><div className="wfc-panel-k">Only If</div><div className="wfc-panel-n">Only Run When</div></div>
          <button type="button" className="wfc-panel-x" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="wfc-panel-bd" key="gate">
          <ConditionsCard definition={definition} onChange={onChange} entityDef={entityDef} eventDef={eventDef} catalog={catalog} people={people} open onToggle={close} />
        </div>
      </>
    );
  }

  const at = locate(nodes, selectedId);
  if (!at) return null;
  const { step, path, index } = at;
  const lane = getLane(definition, path);
  const Icon = CANVAS_ICONS[step.kind] || CANVAS_ICONS.action;
  const node = nodes.find((n) => n.id === selectedId);
  const skipped = step.enabled === false;
  const patch = (p) => onChange(patchStep(definition, path, index, p));
  const pickAction = (def) => patch({ action: def.key, params: newStep('action', def).params });
  const idBase = `canvas-step-${step.id}`;

  return (
    <>
      <div className="wfc-panel-hd">
        <span className="wfc-ic" style={{ background: nodeColor(node, catalog) }} aria-hidden="true"><Icon /></span>
        <div><div className="wfc-panel-k">{KIND_LABEL[step.kind] || step.kind}</div><div className="wfc-panel-n">Step {index + 1}</div></div>
        <button type="button" className="wfc-panel-x" onClick={close} aria-label="Close">×</button>
      </div>
      <div className="wfc-panel-bd" key={step.id}>
        <div className="wfc-sentence">{describeStep(step, catalog) || 'New step'}</div>
        {step.kind === 'action' && !step.action
          ? <ActionPicker catalog={catalog} onPick={pickAction} id={`${idBase}-action`} />
          : <Editor step={step} onChange={patch} ctx={ctxFor(ctx, definition, path)} depth={0} idBase={idBase} lanes={false} />}
      </div>
      {canEdit && (
        <div className="wfc-panel-ft">
          <button type="button" onClick={() => onChange(moveStep(definition, path, index, index - 1))} disabled={index === 0} aria-label="Move Up" title="Move Up" style={{ ...btn('ghost'), padding: 6 }}><ArrowUp size={14} /></button>
          <button type="button" onClick={() => onChange(moveStep(definition, path, index, index + 1))} disabled={index >= lane.length - 1} aria-label="Move Down" title="Move Down" style={{ ...btn('ghost'), padding: 6 }}><ArrowDown size={14} /></button>
          <button type="button" onClick={() => onChange(toggleStep(definition, path, index))} aria-pressed={skipped} style={btn('outline')}>
            {skipped ? <><EyeOff size={13} /> Include</> : <><Eye size={13} /> Skip</>}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => { onChange(removeStep(definition, path, index)); close(); }} style={{ ...btn('outline'), color: 'hsl(var(--color-red))' }}><Trash2 size={13} /> Remove</button>
        </div>
      )}
    </>
  );
}

function panelLabel(selectedId, nodes) {
  if (!selectedId) return 'Workflow panel';
  if (selectedId === 'trigger') return 'Trigger';
  if (selectedId === 'gate') return 'Only If';
  const at = locate(nodes, selectedId);
  return at ? `${KIND_LABEL[at.step.kind] || at.step.kind} step` : 'Workflow panel';
}

export default function Inspector({ definition, catalog, ctx, selectedId, nodes, onChange, onSelect, canEdit = true, people, isNew, entityDef, eventDef, panel }) {
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onSelect(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onSelect]);

  // A selection the sheet no longer has (the step was removed) shows the rail.
  const known = selectedId && (selectedId === 'trigger' || selectedId === 'gate' || !!locate(nodes, selectedId));

  return (
    <aside className="wfc-panel" aria-label={panelLabel(known ? selectedId : null, nodes)}>
      <div className="wfc-panel-rail" hidden={!!known}>{panel}</div>
      {known && (
        <Selected definition={definition} catalog={catalog} ctx={ctx} selectedId={selectedId} nodes={nodes} onChange={onChange} onSelect={onSelect}
          canEdit={canEdit} people={people} isNew={isNew} entityDef={entityDef} eventDef={eventDef} />
      )}
    </aside>
  );
}
