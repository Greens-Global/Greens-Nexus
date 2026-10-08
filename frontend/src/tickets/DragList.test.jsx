import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, createEvent, cleanup } from '@testing-library/react';
import DragList from './DragList';

// Drag to reorder (Sep 30) - replaced the up/down chevrons on departments,
// ticket types, intake questions and help topics. Only the grip starts a drag,
// the drop lands above or below the row it is released on, and Arrow Up /
// Down on the grip moves a row without a mouse.
afterEach(cleanup);

const ITEMS = ['IT', 'Construction', 'Admin', 'Operations'];
const setup = (onReorder = vi.fn()) => {
  render(<DragList items={ITEMS} getKey={(x) => x} onReorder={onReorder} label="department"
    renderItem={(x, handle) => <div>{handle}<span>{x}</span><input aria-label={`name ${x}`} /></div>} />);
  return onReorder;
};
// jsdom has no layout: every row is 0px tall at y=0, so clientY 1 means
// "below the middle" (drop after) and -1 means "above" (drop before).
const drag = (fromKey, toKey, clientY) => {
  const grips = screen.getAllByRole('button', { name: /Drag to reorder/ });
  fireEvent.mouseDown(grips[ITEMS.indexOf(fromKey)]);
  const from = screen.getByTestId(`drag-row-${fromKey}`);
  const to = screen.getByTestId(`drag-row-${toKey}`);
  const dataTransfer = { setData: () => {}, effectAllowed: '' };
  fireEvent.dragStart(from, { dataTransfer });
  // jsdom's drag events do not carry clientY, so it is set on the event.
  for (const kind of ['dragOver', 'drop']) {
    const ev = createEvent[kind](to, { dataTransfer });
    Object.defineProperty(ev, 'clientY', { value: clientY });
    fireEvent(to, ev);
  }
};

describe('DragList', () => {
  it('only arms a row for dragging from its grip', () => {
    setup();
    expect(screen.getByTestId('drag-row-Admin').getAttribute('draggable')).toBe('false');
    fireEvent.mouseDown(screen.getAllByRole('button', { name: /Drag to reorder/ })[2]);
    expect(screen.getByTestId('drag-row-Admin').getAttribute('draggable')).toBe('true');
  });

  it('drops a row above the one it is released on', () => {
    const onReorder = setup();
    drag('Operations', 'Construction', -1);
    expect(onReorder).toHaveBeenCalledWith(['IT', 'Operations', 'Construction', 'Admin']);
  });

  it('drops a row below the one it is released on', () => {
    const onReorder = setup();
    drag('IT', 'Admin', 1);
    expect(onReorder).toHaveBeenCalledWith(['Construction', 'Admin', 'IT', 'Operations']);
  });

  it('does nothing when dropped back where it was', () => {
    const onReorder = setup();
    drag('Admin', 'Admin', -1);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys on the grip', () => {
    const onReorder = setup();
    const grips = screen.getAllByRole('button', { name: /Drag to reorder/ });
    fireEvent.keyDown(grips[1], { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenLastCalledWith(['Construction', 'IT', 'Admin', 'Operations']);
    fireEvent.keyDown(grips[1], { key: 'ArrowDown' });
    expect(onReorder).toHaveBeenLastCalledWith(['IT', 'Admin', 'Construction', 'Operations']);
  });
});
