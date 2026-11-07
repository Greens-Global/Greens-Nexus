import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Keyboard triage on the Tasks Home Updates card (Neil, 11/07/2026): J / K
// step the rows, Enter opens one, E resolves a comment handed to me and
// steps on; nothing fires from the reply box.

const editTaskComment = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({ api: { editTaskComment: (...a) => editTaskComment(...a) } }));
vi.mock('./components', () => ({ Avatar: () => <span /> }));

const { default: UpdatesCard } = await import('./HomeUpdates');

const now = new Date().toISOString();
const updates = [
  { id: 'u1', taskId: 't1', at: now, actorId: 'a@x.com', forYou: true, ask: 'open', parts: [{ kind: 'comment' }], comment: { id: 'c1', threadId: 'c1', canResolve: true } },
  { id: 'u2', taskId: 't2', at: now, actorId: 'b@x.com', forYou: true, ask: 'open', parts: [{ kind: 'comment' }], comment: { id: 'c2', threadId: 'c2' } },
];
const taskById = new Map([['t1', { id: 't1', title: 'First' }], ['t2', { id: 't2', title: 'Second' }]]);

function setup() {
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  render(<UpdatesCard updates={updates} failed={false} nameOf={() => ''} statusMeta={{}} taskById={taskById} onOpen={onOpen} onChanged={onChanged} />);
  const rows = () => [...document.querySelectorAll('[data-update-row]')];
  return { onOpen, onChanged, rows };
}

afterEach(() => { cleanup(); editTaskComment.mockClear(); });

describe('Updates card keys', () => {
  it('J and K move focus through the rows, Enter opens the focused one', () => {
    const { onOpen, rows } = setup();
    const tab = screen.getByRole('tab', { name: 'All' });
    tab.focus();
    fireEvent.keyDown(tab, { key: 'j' });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(document.activeElement, { key: 'j' });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'c1' }));
  });

  it("E resolves the focused comment through the row's own call and steps on", async () => {
    const { onChanged, rows } = setup();
    rows()[0].focus();
    fireEvent.keyDown(rows()[0], { key: 'e' });
    expect(editTaskComment).toHaveBeenCalledWith('c1', { resolved: true });
    expect(document.activeElement).toBe(rows()[1]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('E does nothing on a row with no Resolve, and keys in the reply box are left alone', () => {
    const { rows } = setup();
    rows()[1].focus();
    fireEvent.keyDown(rows()[1], { key: 'e' });
    expect(editTaskComment).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /Reply/ })[0]);
    const box = screen.getByLabelText('Reply');
    box.focus();
    fireEvent.keyDown(box, { key: 'j' });
    expect(document.activeElement).toBe(box);
  });
});
