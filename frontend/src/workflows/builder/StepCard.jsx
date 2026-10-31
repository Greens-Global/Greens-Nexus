// One step (Oct 2026). Collapsed it is a sentence from lib/text.js, so the
// whole workflow reads top to bottom as prose; expanded it shows the
// controls the catalog says the step takes. If / Else, Ask For Approval and
// For Each show their branches as indented lanes (each one a StepList).
// A step a template left blank (`blank`) wears a dashed outline until the
// builder is next opened.
import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Trash2 } from 'lucide-react';
import { StatusLabel } from '../../components/StatusLabel';
import { NumberBox, Switch } from '../../components/settings/SettingsUI';
import { describeStep } from '../lib/text';
import { DEFAULT_OPTIONS, findAction, lanesOf } from '../lib/definition';
import { ConditionGroups } from './ConditionsCard';
import ParamControl, { DateOffsetControl, ListSourceControl, OptionsEditor, RecipientsPicker, TemplateBox } from './ParamControl';
import StepList from './StepList';
import { STEP_ICONS, fieldLabel, hint, iconBtn, lane, laneTitle, select, sentence, textInput } from '../lib/text.builder-helpers';

const MODES = [
  { key: 'any', label: 'The First To Answer Decides' },
  { key: 'all', label: 'Everyone Must Agree' },
  { key: 'sequence', label: 'One After Another' },
];

export default function StepCard({ step, index, count, handle, onChange, onRemove, onMove, onToggle, ctx, depth = 0, initiallyOpen = false, blank = false }) {
  const [open, setOpen] = useState(initiallyOpen);
  const skipped = step.enabled === false;
  const Icon = STEP_ICONS[step.kind] || STEP_ICONS.action;
  const words = describeStep(step, ctx.catalog) || 'New step';
  const idBase = `step-${step.id}`;

  return (
    <div data-blank={blank ? 'true' : undefined} style={{
      border: blank ? '1.5px dashed var(--nx-primary)' : '1px solid var(--nx-border)', borderRadius: 12, background: 'var(--nx-surface)',
      opacity: skipped ? 0.6 : 1, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 8px 6px' }}>
        {handle}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse step' : 'Expand step'} style={{ ...iconBtn, padding: 2 }}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <Icon size={15} style={{ color: 'var(--nx-dim)', flexShrink: 0 }} />
        <button type="button" onClick={() => setOpen((o) => !o)} style={{
          ...sentence, flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer',
          fontFamily: 'inherit', padding: 0, textDecoration: skipped ? 'line-through' : 'none',
        }}>
          {step.label ? <span style={{ fontWeight: 600 }}>{step.label}: </span> : null}{words}
        </button>
        {skipped && <StatusLabel label="Skipped" color="#94a3b8" size="sm" />}
        <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move Up" title="Move Up" style={{ ...iconBtn, opacity: index === 0 ? 0.3 : 1 }}><ArrowUp size={14} /></button>
          <button type="button" onClick={() => onMove(1)} disabled={index >= count - 1} aria-label="Move Down" title="Move Down" style={{ ...iconBtn, opacity: index >= count - 1 ? 0.3 : 1 }}><ArrowDown size={14} /></button>
          <button type="button" onClick={onToggle} aria-label={skipped ? 'Include step' : 'Skip step'} title={skipped ? 'Include' : 'Skip'} aria-pressed={skipped} style={iconBtn}>{skipped ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          <button type="button" onClick={onRemove} aria-label="Delete step" title="Delete" style={{ ...iconBtn, color: 'var(--nx-faint)' }}><Trash2 size={14} /></button>
        </span>
      </div>
      {open && (
        <div style={{ padding: '4px 14px 14px 32px', display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--nx-border2)' }}>
          <Editor step={step} onChange={onChange} ctx={ctx} depth={depth} idBase={idBase} />
        </div>
      )}
    </div>
  );
}

function Lane({ title, steps, onChange, ctx, depth }) {
  return (
    <div style={lane}>
      <div style={laneTitle}>{title}</div>
      <StepList steps={steps} onChange={onChange} ctx={ctx} depth={depth + 1} emptyText="Nothing here yet." addLabel="Add Step" />
    </div>
  );
}

// The controls one step takes. `lanes` draws the nested lanes (Then /
// Otherwise, the answers, the loop body) as indented StepLists - the recipe
// wants them, the canvas inspector does not (the sheet shows them).
export function Editor({ step, onChange, ctx, depth = 0, idBase = `step-${step?.id || 'x'}`, lanes = true }) {
  const setParam = (key, v) => onChange({ params: { ...(step.params || {}), [key]: v } });

  if (step.kind === 'action') {
    const def = findAction(ctx.catalog, step.action);
    if (!def) return <div style={{ ...hint, color: 'var(--nx-red, #dc2626)' }}>This action ({step.action || 'none'}) is no longer available. Delete the step or skip it.</div>;
    return (
      <>
        {def.adminOnly && <div style={hint}>Global Admins only.</div>}
        {(def.params || []).map((p) => (
          <div key={p.key}>
            <label style={fieldLabel} htmlFor={`${idBase}-${p.key}`}>{p.label}{p.required === false ? '' : ' *'}</label>
            <ParamControl id={`${idBase}-${p.key}`} param={p} value={step.params?.[p.key]} onChange={(v) => setParam(p.key, v)} ctx={ctx} />
            {p.hint && p.type !== 'text' && p.type !== 'template' && <div style={{ ...hint, marginTop: 4 }}>{p.hint}</div>}
          </div>
        ))}
        <StepLabel step={step} onChange={onChange} idBase={idBase} />
      </>
    );
  }

  if (step.kind === 'if') {
    return (
      <>
        <div>
          <span style={fieldLabel}>If</span>
          <ConditionGroups groups={step.conditions || []} onChange={(c) => onChange({ conditions: c })} entityDef={ctx.entityDef} eventDef={ctx.eventDef} catalog={ctx.catalog} people={ctx.people} emptyText="Add a condition." />
        </div>
        {lanes && <Lane title="Then" steps={step.then || []} onChange={(s) => onChange({ then: s })} ctx={ctx} depth={depth} />}
        {lanes && <Lane title="Otherwise" steps={step.else || []} onChange={(s) => onChange({ else: s })} ctx={ctx} depth={depth} />}
      </>
    );
  }

  if (step.kind === 'approval') {
    const p = step.params || {};
    const options = Array.isArray(p.options) && p.options.length ? p.options : DEFAULT_OPTIONS;
    const setOptions = (next) => {
      const branches = { ...(step.branches || {}) };
      next.forEach((o) => { if (!Array.isArray(branches[o])) branches[o] = []; });
      if (!Array.isArray(branches.expired)) branches.expired = [];
      onChange({ params: { ...p, options: next }, branches });
    };
    return (
      <>
        <div>
          <label style={fieldLabel} htmlFor={`${idBase}-approvers`}>Who Approves *</label>
          <RecipientsPicker id={`${idBase}-approvers`} value={p.approvers} onChange={(v) => setParam('approvers', v)} ctx={ctx} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <label style={fieldLabel} htmlFor={`${idBase}-mode`}>How They Decide</label>
            <select id={`${idBase}-mode`} value={p.mode || 'any'} onChange={(e) => setParam('mode', e.target.value)} style={select}>
              {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <span style={fieldLabel}>Remind After</span>
            <NumberBox value={p.remindDays ?? 0} onChange={(v) => setParam('remindDays', Number(v) || 0)} min={0} max={60} unit="days" label="Remind after days" />
          </div>
          <div>
            <span style={fieldLabel}>Expire After</span>
            <NumberBox value={p.expireDays ?? 0} onChange={(v) => setParam('expireDays', Number(v) || 0)} min={0} max={365} unit="days" label="Expire after days" />
          </div>
        </div>
        <div>
          <label style={fieldLabel} htmlFor={`${idBase}-question`}>Question *</label>
          <TemplateBox id={`${idBase}-question`} param={{ key: 'question', label: 'Question', type: 'template', max: 500, hint: 'e.g. Approve {{ subject.name }}\'s request?' }} value={p.question} onChange={(v) => setParam('question', v)} ctx={ctx} />
        </div>
        <div>
          <label style={fieldLabel} htmlFor={`${idBase}-options`}>Options</label>
          <OptionsEditor id={`${idBase}-options`} value={options} onChange={setOptions} label="option" />
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...hint }}>
          <Switch checked={!!p.allowSelf} onChange={(v) => setParam('allowSelf', v)} label="Let the person decide about themselves" />
          Let the person decide about themselves
        </label>
        {lanes && lanesOf(step).map((l) => (
          <Lane key={l.key} title={l.label} steps={step.branches?.[l.key] || []} onChange={(s) => onChange({ branches: { ...(step.branches || {}), [l.key]: s } })} ctx={ctx} depth={depth} />
        ))}
      </>
    );
  }

  if (step.kind === 'wait') {
    const p = step.params || { mode: 'duration' };
    return (
      <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={p.mode || 'duration'} onChange={(e) => onChange({ params: { ...p, mode: e.target.value } })} aria-label="How long to wait" style={select}>
            <option value="duration">For A Length Of Time</option>
            <option value="until">Until A Date On The Record</option>
            <option value="business_morning">Until The Next Business Morning</option>
          </select>
          {p.mode === 'duration' && <ParamControl param={{ key: 'minutes', label: 'Wait for', type: 'duration' }} value={p.minutes} onChange={(v) => setParam('minutes', v)} ctx={ctx} />}
        </div>
        {p.mode === 'until' && <DateOffsetControl value={{ field: p.field || '', offsetDays: p.offsetDays || 0 }} onChange={(v) => onChange({ params: { ...p, field: v.field, offsetDays: v.offsetDays } })} ctx={ctx} label="Wait until" withTime={false} />}
        {p.mode === 'business_morning' && <div style={hint}>Resumes at the start of the next working day in the record's company time zone.</div>}
      </>
    );
  }

  if (step.kind === 'for_each') {
    const innerCtx = { ...ctx, loopNames: [...(ctx.loopNames || []), step.as || 'item'] };
    return (
      <>
        <div>
          <label style={fieldLabel} htmlFor={`${idBase}-source`}>List *</label>
          <ListSourceControl id={`${idBase}-source`} value={step.source} onChange={(v) => onChange({ source: v })} ctx={ctx} label="List" />
        </div>
        <div>
          <label style={fieldLabel} htmlFor={`${idBase}-as`}>Call Each One</label>
          <input id={`${idBase}-as`} type="text" value={step.as || ''} onChange={(e) => onChange({ as: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') || 'item' })} style={{ ...textInput, width: 160 }} />
          <div style={{ ...hint, marginTop: 4 }}>Steps inside can use {'{{ '}{step.as || 'item'}.name{' }}'}.</div>
        </div>
        {lanes && <Lane title={`For Each ${step.as || 'item'}`} steps={step.steps || []} onChange={(s) => onChange({ steps: s })} ctx={innerCtx} depth={depth} />}
      </>
    );
  }

  return <div style={hint}>The run ends here. Later steps do not run.</div>;
}

function StepLabel({ step, onChange, idBase }) {
  return (
    <div>
      <label style={fieldLabel} htmlFor={`${idBase}-label`}>Step Name (Optional)</label>
      <input id={`${idBase}-label`} type="text" value={step.label || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Shown in runs and reports" style={{ ...textInput, maxWidth: 360 }} />
    </div>
  );
}
