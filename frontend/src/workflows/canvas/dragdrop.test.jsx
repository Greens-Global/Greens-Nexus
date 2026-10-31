// Drag and drop on the canvas (10/30/2026): a dock block dropped on a
// connector inserts there, a tap on a dock block appends, a step dragged
// onto another lane's insert point moves, a step dropped on its own lanes
// or let go in the open goes home with nothing changed.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import Canvas from './Canvas';
import { catalog, ctx, sample } from './Canvas.test';
import { getLane } from '../lib/definition';

vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myRole: 'owner', companies: [] }) }));

// The sheet is 1000 x 700 at the page's origin, and the view is the
// identity, so a hot's sheet pixels are its screen pixels.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.classList && this.classList.contains('wfc-sheet')) return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0 };
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
  };
});

const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
const hotAt = (path, index) => document.querySelector(`.wfc-hotspot[data-insert-path="${path}"][data-insert-index="${index}"]`);
const posOf = (el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) });

const mount = () => {
  const onChange = vi.fn(); const onSelect = vi.fn();
  render(<Canvas definition={sample()} catalog={catalog} ctx={ctx} selectedId={null} onSelect={onSelect} onChange={onChange} canEdit
    entityDef={ctx.entityDef} eventDef={ctx.eventDef} initialView={{ x: 0, y: 0, s: 1 }} />);
  return { onChange, onSelect };
};

const fire = (target, type, x, y) => act(() => { target.dispatchEvent(ev(type, x, y)); });
function dragTo(el, from, to) {
  fire(el, 'pointerdown', from.x, from.y);
  fire(window, 'pointermove', from.x + 8, from.y + 8);
  fire(window, 'pointermove', to.x, to.y);
  fire(window, 'pointerup', to.x, to.y);
}

describe('canvas drag and drop', () => {
  it('drops a dock block on a connector and inserts it there', () => {
    const { onChange } = mount();
    const hot = hotAt('steps', 1); const p = posOf(hot);
    dragTo(screen.getByRole('button', { name: /^Wait block/ }), { x: 50, y: 300 }, p);
    const next = onChange.mock.calls[0][0];
    expect(next.steps.map((s) => s.kind)).toEqual(['action', 'wait', 'if', 'wait']);
  });

  it('lights the insert point under the pointer while a block is held', () => {
    mount();
    const hot = hotAt('steps.1.else', 0); const p = posOf(hot);
    const block = screen.getByRole('button', { name: /^Stop block/ });
    fire(block, 'pointerdown', 50, 300);
    fire(window, 'pointermove', 60, 310);
    fire(window, 'pointermove', p.x + 10, p.y - 10);
    expect(hot).toHaveClass('is-armed');
    expect(document.querySelector('.wfc-ghost[data-insert-path="steps.1.else"]')).toHaveClass('is-armed');
    expect(document.querySelector('.wfc-ghost-block')).toBeInTheDocument();
    fire(window, 'pointerup', p.x + 10, p.y - 10);
    expect(document.querySelector('.wfc-ghost-block')).not.toBeInTheDocument();
  });

  it('appends a block to the workflow on a tap', () => {
    const { onChange } = mount();
    const block = screen.getByRole('button', { name: /^Stop block/ });
    fire(block, 'pointerdown', 50, 300);
    fire(window, 'pointerup', 51, 300);
    expect(onChange.mock.calls[0][0].steps.map((s) => s.kind)).toEqual(['action', 'if', 'wait', 'stop']);
  });

  it('moves a step into another lane when dropped on its insert point', () => {
    const { onChange } = mount();
    const hot = hotAt('steps.1.else', 0); const p = posOf(hot);
    dragTo(screen.getByRole('button', { name: /^Wait: / }), { x: 300, y: 600 }, p);
    const next = onChange.mock.calls[0][0];
    expect(next.steps.map((s) => s.id)).toEqual(['a1', 'if1']);
    expect(getLane(next, ['steps', 1, 'else']).map((s) => s.id)).toEqual(['w1']);
  });

  it('refuses to drop a step inside its own lanes and goes home when let go in the open', () => {
    const { onChange, onSelect } = mount();
    const inner = hotAt('steps.1.then', 1); const p = posOf(inner);
    const node = screen.getByRole('button', { name: /^If \/ Else: / });
    const home = node.style.transform;
    dragTo(node, { x: 300, y: 400 }, p);          // onto its own Then lane: refused, so this is "the open"
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(node.style.transform).toBe(home);
    expect(node).not.toHaveClass('is-dragging');
  });

  it('does not let a read-only canvas insert or move anything', () => {
    const onChange = vi.fn();
    render(<Canvas definition={sample()} catalog={catalog} ctx={ctx} selectedId={null} onSelect={() => {}} onChange={onChange} canEdit={false}
      entityDef={ctx.entityDef} eventDef={ctx.eventDef} initialView={{ x: 0, y: 0, s: 1 }} />);
    expect(document.querySelector('.wfc-hotspot')).toBeNull();
    expect(screen.getByRole('button', { name: /^Wait block/ })).toBeDisabled();
  });

  it('never lifts a block on a read-only canvas: a press that moves is nothing, not a drag', () => {
    const onChange = vi.fn(); const onSelect = vi.fn();
    render(<Canvas definition={sample()} catalog={catalog} ctx={ctx} selectedId={null} onSelect={onSelect} onChange={onChange} canEdit={false}
      entityDef={ctx.entityDef} eventDef={ctx.eventDef} initialView={{ x: 0, y: 0, s: 1 }} />);
    const node = screen.getByRole('button', { name: /^Wait: / });
    const home = node.style.transform;
    fire(node, 'pointerdown', 300, 600);
    fire(window, 'pointermove', 400, 500);
    expect(node.style.transform).toBe(home);
    expect(node).not.toHaveClass('is-dragging');
    fire(window, 'pointerup', 400, 500);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not commit a cancelled gesture: the step goes home and nothing changes', () => {
    const { onChange, onSelect } = mount();
    const hot = hotAt('steps.1.else', 0); const p = posOf(hot);
    const node = screen.getByRole('button', { name: /^Wait: / });
    const home = node.style.transform;
    fire(node, 'pointerdown', 300, 600);
    fire(window, 'pointermove', 308, 608);
    fire(window, 'pointermove', p.x, p.y);
    expect(hot).toHaveClass('is-armed');
    fire(window, 'pointercancel', p.x, p.y);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(node.style.transform).toBe(home);
    expect(node).not.toHaveClass('is-dragging');
    expect(hot).not.toHaveClass('is-armed');
  });

  it('opens a new Action right away so its picker is there', () => {
    const { onChange, onSelect } = mount();
    act(() => { hotAt('steps', 1).click(); });
    const next = onChange.mock.calls[0][0];
    expect(next.steps[1].kind).toBe('action');
    expect(next.steps[1].action).toBe('');
    expect(onSelect).toHaveBeenCalledWith(next.steps[1].id);
  });
});
