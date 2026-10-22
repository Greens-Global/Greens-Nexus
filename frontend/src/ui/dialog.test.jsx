import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { dialog, DialogHost } from './dialog';

// `minLength` (Oct 23): the Unlock reason needs 5 characters on the server,
// and "jn" failed with only a toast - the prompt now says so and waits.
describe('dialog.prompt minLength', () => {
  it('keeps OK disabled, with a hint, until the text is long enough', async () => {
    render(<DialogHost />);
    let result;
    await act(async () => { result = dialog.prompt('Why?', { confirmText: 'Unlock', required: true, minLength: 5 }); });
    const ok = screen.getByRole('button', { name: 'Unlock' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'jn' } });
    expect(ok.disabled).toBe(true);
    expect(screen.getByText('At least 5 characters (2 so far).')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wrong lunch' } });
    expect(ok.disabled).toBe(false);
    expect(screen.queryByText(/At least 5 characters/)).toBeNull();
    await act(async () => { fireEvent.click(ok); });
    expect(await result).toBe('Wrong lunch');
  });
});
