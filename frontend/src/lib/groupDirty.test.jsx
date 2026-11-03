import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GroupDirtyContext, makeGroupReporter, saveAll, useGroupDirty } from './groupDirty';

// Several forms in one Settings group (the Ticket Manager's Routing and Desk
// Access tabs both sit under `service-desk`): each is its own reporter, so a
// clean form mounting or unmounting never clears another's unsaved flag.
function Form({ name, startDirty = false, save }) {
  const [dirty, setDirty] = useState(startDirty);
  useGroupDirty(dirty, save);
  return <button onClick={() => setDirty(d => !d)}>{`${name} ${dirty ? 'dirty' : 'clean'}`}</button>;
}

function Harness({ onChange, children }) {
  const [report] = useState(() => makeGroupReporter(onChange));
  return <GroupDirtyContext.Provider value={report}>{children}</GroupDirtyContext.Provider>;
}

describe('groupDirty', () => {
  it('keeps a group dirty while any of its forms is', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Harness onChange={onChange}><Form name="routing" startDirty /></Harness>,
    );
    expect(onChange).toHaveBeenLastCalledWith(true, [null]);
    // A second, clean form mounts beside it: still dirty.
    rerender(<Harness onChange={onChange}><Form name="routing" startDirty /><Form name="access" /></Harness>);
    expect(onChange).toHaveBeenLastCalledWith(true, [null]);
    // That clean form unmounts: still dirty.
    rerender(<Harness onChange={onChange}><Form name="routing" startDirty /></Harness>);
    expect(onChange).toHaveBeenLastCalledWith(true, [null]);
    // The dirty one goes clean: now the group is clean.
    fireEvent.click(screen.getByText('routing dirty'));
    expect(onChange).toHaveBeenLastCalledWith(false, []);
  });

  it('passes each dirty form\'s save, and a plain boolean reporter still works', () => {
    const onChange = vi.fn();
    const report = makeGroupReporter(onChange);
    report(true);
    expect(onChange).toHaveBeenLastCalledWith(true, [null]);
    report(false);
    expect(onChange).toHaveBeenLastCalledWith(false, []);
    const save = vi.fn(() => Promise.resolve(true));
    render(<GroupDirtyContext.Provider value={report}><Form name="pay" startDirty save={save} /></GroupDirtyContext.Provider>);
    const [dirty, saves] = onChange.mock.lastCall;
    expect(dirty).toBe(true);
    expect(saves).toHaveLength(1);
    saves[0]();
    expect(save).toHaveBeenCalled();
  });

  it('saveAll is true only when every save said it saved', async () => {
    await expect(saveAll([() => Promise.resolve(true), () => true])).resolves.toBe(true);
    await expect(saveAll([() => Promise.resolve(true), () => Promise.resolve(false)])).resolves.toBe(false);
    await expect(saveAll([() => Promise.resolve(true), () => undefined])).resolves.toBe(false);
    await expect(saveAll([() => Promise.reject(new Error('no'))])).resolves.toBe(false);
    await expect(saveAll([null])).resolves.toBe(false);
    await expect(saveAll([])).resolves.toBe(false);
  });

  it('is a no-op outside Settings', () => {
    render(<Form name="alone" startDirty />);
    act(() => { fireEvent.click(screen.getByText('alone dirty')); });
    expect(screen.getByText('alone clean')).toBeInTheDocument();
  });
});
