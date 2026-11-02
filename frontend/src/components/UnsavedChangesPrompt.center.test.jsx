import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';

// A question stays a centered card while content popups became right-edge
// sheets (Neil, 11/01/2026): nx-center is the opt-out the sheet CSS reads.
describe('UnsavedChangesPrompt', () => {
  it('is tagged nx-center so it never becomes a sheet', () => {
    render(<UnsavedChangesPrompt onKeepEditing={() => {}} onDiscard={() => {}} />);
    const box = document.querySelector('.modal-content');
    expect(box.className).toContain('nx-popup');
    expect(box.className).toContain('nx-center');
  });
});
