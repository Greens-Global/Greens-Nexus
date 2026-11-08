import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// C then T opens New Task from anywhere (Neil, 11/07/2026) - never while
// typing, never with a modifier, never when the T comes too late.

vi.mock('../dashboard/QuickActionModals.jsx', () => ({ default: ({ kind }) => <div role="dialog" aria-label={`Composer ${kind}`} /> }));
vi.mock('../contexts/RoleContext', async (orig) => ({
  ...(await orig()),
  useRole: () => ({
    myRole: 'employee', isExternal: false, can: (r) => r === 'employee',
    myGrantedModules: new Map([['tasks', 'editor']]), canAccessModule: () => true,
  }),
}));

const { default: QuickCreate } = await import('./QuickCreate');

afterEach(() => { cleanup(); vi.useRealTimers(); });
const press = (target, key, extra = {}) => fireEvent.keyDown(target, { key, ...extra });

describe('C then T', () => {
  it('opens the New Task composer', async () => {
    render(<QuickCreate />);
    press(document.body, 'c');
    press(document.body, 't');
    expect(await screen.findByRole('dialog', { name: 'Composer task' })).toBeTruthy();
  });

  it('is ignored inside an input, with a modifier, after a second, or with a key between', () => {
    vi.useFakeTimers();
    render(<><QuickCreate /><input aria-label="Box" /></>);
    const box = screen.getByLabelText('Box');
    press(box, 'c'); press(box, 't');
    press(document.body, 'c', { metaKey: true }); press(document.body, 't', { metaKey: true });
    press(document.body, 'c'); vi.advanceTimersByTime(1500); press(document.body, 't');
    press(document.body, 'c'); press(document.body, 'x'); press(document.body, 't');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
