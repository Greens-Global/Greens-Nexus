// The canvas (10/30/2026): every step is a block that speaks its sentence,
// a click selects and opens the panel, the zoom controls answer, the skin
// follows the prop, and a layout the engine cannot draw never blanks the
// screen.
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import Canvas from './Canvas';
import { emptyDefinition, newStep } from '../lib/definition';

vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myRole: 'owner', companies: [] }) }));

export const catalog = {
  entities: [{ key: 'employee', label: 'Person', module: 'hr', fields: [{ key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }], visibility: 'all' }], dates: [], people: [{ key: 'manager', label: 'Their Manager' }] }],
  events: [{ key: 'hr.employee.status_changed', entity: 'employee', label: 'Status Changes', module: 'hr', group: 'People', changes: ['status'], volume: 'normal' }],
  actions: [
    { key: 'notify', label: 'Send A Notification', module: 'core', params: [{ key: 'to', label: 'To', type: 'recipients', required: true }, { key: 'title', label: 'Title', type: 'template', required: true }] },
    { key: 'tasks.create', label: 'Create Task', module: 'tasks', params: [{ key: 'title', label: 'Title', type: 'template', required: true }] },
  ],
  listSources: [], operators: { select: [{ key: 'is', label: 'is' }] }, filters: [], newSince: [],
};

export function sample() {
  const def = emptyDefinition({ kind: 'event', event: 'hr.employee.status_changed', filters: [] });
  def.conditions = [[{ field: 'status', op: 'is', value: 'active' }]];
  const iff = { ...newStep('if'), id: 'if1', then: [{ ...newStep('action', catalog.actions[1]), id: 't1', params: { title: 'Welcome' } }], else: [] };
  def.steps = [{ ...newStep('action', catalog.actions[0]), id: 'a1', params: { to: [{ kind: 'manager' }], title: 'Hello' } }, iff, { ...newStep('wait'), id: 'w1' }];
  return def;
}

export const ctx = { catalog, isNew: () => false, entityDef: catalog.entities[0], eventDef: catalog.events[0], people: [], companies: [], loopNames: [], blanks: [] };

const mount = (props = {}) => {
  const onSelect = vi.fn(); const onChange = vi.fn(); const onSkin = vi.fn();
  const utils = render(<Canvas definition={sample()} catalog={catalog} ctx={ctx} skin="paper" onSkin={onSkin} selectedId={null} onSelect={onSelect} onChange={onChange}
    canEdit entityDef={ctx.entityDef} eventDef={ctx.eventDef} initialView={{ x: 0, y: 0, s: 1 }} panel={<div>Rail here</div>} {...props} />);
  return { ...utils, onSelect, onChange, onSkin };
};

describe('Canvas', () => {
  it('draws a block for the trigger, the gate and every step, each named by its sentence', () => {
    mount();
    expect(screen.getByRole('button', { name: /^Trigger: .*Status Changes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Only If: Only if Status is Active/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Action: Send A Notification/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^If \/ Else: / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Action: Create Task/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Wait: / })).toBeInTheDocument();
    // the empty Otherwise lane shows a drop slot; the panel shows the rail while nothing is selected
    expect(screen.getAllByRole('button', { name: 'Add a step here' })).toHaveLength(2); // the Otherwise lane and the fault lane
    expect(screen.getByText('Rail here')).toBeInTheDocument();
    expect(screen.getByTestId('wfc')).toHaveAttribute('data-skin', 'paper');
  });

  it('selects a block on a press without movement and on Enter', () => {
    const { onSelect } = mount();
    const node = screen.getByRole('button', { name: /^Action: Send A Notification/i });
    act(() => { node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })); });
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 11, clientY: 10 })); });
    expect(onSelect).toHaveBeenCalledWith('a1');
    fireEvent.keyDown(screen.getByRole('button', { name: /^Wait: / }), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('w1');
  });

  it('shows the selected step in the panel with its controls and the lane buttons', () => {
    const { onChange } = mount({ selectedId: 'a1' });
    expect(screen.getByRole('complementary', { name: 'Action step' })).toBeInTheDocument();
    expect(screen.getByText('Step 1')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const next = onChange.mock.calls[0][0];
    expect(next.steps.map((s) => s.id)).toEqual(['if1', 'w1']);
  });

  it('zooms with the controls and switches skins', () => {
    const { onSkin } = mount();
    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(screen.getByText('120%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    expect(onSkin).toHaveBeenCalledWith('night');
  });

  it('inserts an action where an insert point is clicked', () => {
    const { onChange } = mount();
    const hot = document.querySelector('.wfc-hotspot[data-insert-path="steps"][data-insert-index="1"]');
    fireEvent.click(hot);
    const next = onChange.mock.calls[0][0];
    expect(next.steps.map((s) => s.kind)).toEqual(['action', 'action', 'if', 'wait']);
    expect(next.steps[1].action).toBe('');
  });

  it('wears the replay statuses it is handed', () => {
    // the order is the path the run took (replayPlan); a status is worn only by a block on it
    mount({ replay: { order: ['trigger', 'gate', 'a1', 'w1'], statusById: { trigger: 'done', a1: 'done', w1: 'waiting' }, note: 'Replaying run from 10/30/2026' } });
    expect(screen.getByRole('button', { name: /^Action: Send A Notification/i })).toHaveClass('wfc-lit');
    expect(screen.getByRole('button', { name: /^Wait: / })).toHaveClass('wfc-waitlit');
    expect(screen.getByRole('status')).toHaveTextContent('Replaying run from 10/30/2026');
    expect(document.querySelector('path.wfc-edge[data-key="gate>a1"]')).toHaveClass('wfc-hot');
  });

  it('breathes only while the workflow is live', () => {
    mount({ workflowStatus: 'active' });
    expect(screen.getByTestId('wfc')).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: /^Trigger: / })).toHaveClass('is-listening');
  });

  it('keeps the rail mounted, hidden, while a block is open', () => {
    mount({ selectedId: 'a1' });
    const rail = screen.getByText('Rail here');
    expect(rail).toBeInTheDocument();
    expect(rail).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('says so instead of going blank when a definition cannot be drawn', () => {
    const broken = Object.defineProperty({ v: 1, trigger: { kind: 'manual' }, conditions: [] }, 'steps', { get() { throw new Error('boom'); } });
    render(<Canvas definition={broken} catalog={catalog} ctx={ctx} onChange={() => {}} onSelect={() => {}} initialView={{ x: 0, y: 0, s: 1 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be drawn as a canvas');
  });
});
