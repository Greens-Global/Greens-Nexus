import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ASSETS, STORE } from './fixture.test-data.js';
import { ActivityTab } from './ActivityTab.jsx';

afterEach(cleanup);

describe('ActivityTab', () => {
  it('says what is new in words and marks the log seen', () => {
    const onSeen = vi.fn();
    render(<ActivityTab logs={STORE.logs} assets={ASSETS} lastSeen="2026-11-05T00:00:00.000Z" onSeen={onSeen} />);
    expect(screen.getByText('2 new since your last visit')).toBeTruthy();
    expect(screen.getByText(/3 changes by 2 people/)).toBeTruthy();
    expect(onSeen).toHaveBeenCalled();
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText('Removed')).toBeTruthy();
  });

  it('filters by person and asset; Go To and Undo still work', () => {
    const onGoTo = vi.fn();
    const onUndo = vi.fn();
    render(<ActivityTab logs={STORE.logs} assets={ASSETS} onGoTo={onGoTo} onUndo={onUndo} canUndo={() => true} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), { target: { value: 'pranshu pandey' } });
    expect(screen.queryByText('Added')).toBeNull();
    fireEvent.click(screen.getByText(/Go To/));
    expect(onGoTo).toHaveBeenCalledWith(STORE.logs[0]);
    fireEvent.click(screen.getByTitle('Undo this change'));
    fireEvent.click(screen.getAllByRole('button', { name: /Undo/ }).pop());
    expect(onUndo).toHaveBeenCalledWith(STORE.logs[0]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Person' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Asset' }), { target: { value: 'v1' } });
    expect(screen.getAllByText('Removed').length).toBe(1);
    expect(screen.queryByText('Edited')).toBeNull();
  });

  it('scoped to one asset: no asset filter', () => {
    render(<ActivityTab logs={STORE.logs.filter((l) => l.propertyId === 'mur')} assets={ASSETS} scopeName="Greens Storage, Murrieta" />);
    expect(screen.queryByRole('combobox', { name: 'Asset' })).toBeNull();
  });

  it('no uppercase anywhere', () => {
    const { container } = render(<ActivityTab logs={STORE.logs} assets={ASSETS} />);
    expect(container.innerHTML).not.toMatch(/uppercase/i);
  });
});
