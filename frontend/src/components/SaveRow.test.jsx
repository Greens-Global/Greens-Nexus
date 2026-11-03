import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SaveRow from './SaveRow';

// After a save lands the row says when ("Saved 2:41 PM", US 12-hour time)
// until the next edit; a discard is not a save.
describe('SaveRow', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('says Saving… while it saves, then Saved <time> until the next edit', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 2, 14, 41));
    const { rerender } = render(<SaveRow dirty note="Applies to every company." onSave={() => {}} />);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    rerender(<SaveRow dirty busy note="Applies to every company." onSave={() => {}} />);
    expect(screen.getByRole('button', { name: /Saving…/ })).toBeDisabled();
    rerender(<SaveRow note="Applies to every company." onSave={() => {}} />);
    expect(screen.getByText('Saved 2:41 PM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    rerender(<SaveRow dirty note="Applies to every company." onSave={() => {}} />);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    rerender(<SaveRow note="Applies to every company." onSave={() => {}} />);
    expect(screen.getByText('Applies to every company.')).toBeInTheDocument();
  });

  it('a failed save (busy ends, still dirty) does not say Saved', () => {
    const { rerender } = render(<SaveRow dirty busy onSave={() => {}} />);
    rerender(<SaveRow dirty onSave={() => {}} />);
    expect(screen.queryByText(/^Saved /)).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });
});
