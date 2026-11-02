import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UnsavedChangesPrompt, { nameList } from './UnsavedChangesPrompt';

// A question stays a centered card while content popups became right-edge
// sheets (Neil, 11/01/2026): nx-center is the opt-out the sheet CSS reads,
// and without nx-popup it is never the 60% content card either - it is as
// tall as its words.
describe('UnsavedChangesPrompt', () => {
  it('is a small centered question card, never a sheet or a 60% card', () => {
    render(<UnsavedChangesPrompt onKeepEditing={() => {}} onDiscard={() => {}} />);
    const box = document.querySelector('.modal-content');
    expect(box.className).toContain('nx-center');
    expect(box.className).not.toContain('nx-popup');
    expect(box.style.maxWidth).toBe('440px');
    expect(screen.getByText('Discard Unsaved Changes?')).toBeInTheDocument();
    expect(screen.queryByText(/in this window/)).not.toBeInTheDocument();
  });

  it('names what has unsaved changes on this page', () => {
    render(<UnsavedChangesPrompt what={['Pay Rules', 'Probation']} onKeepEditing={() => {}} onDiscard={() => {}} />);
    expect(screen.getByText('Your changes to Pay Rules and Probation on this page have not been saved. If you leave now, they will be lost.')).toBeInTheDocument();
  });

  it('offers Save and Leave only when given a save', () => {
    const onSave = vi.fn();
    const { rerender } = render(<UnsavedChangesPrompt onKeepEditing={() => {}} onDiscard={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Save and Leave' })).not.toBeInTheDocument();
    rerender(<UnsavedChangesPrompt onKeepEditing={() => {}} onDiscard={() => {}} onSave={onSave} saveText="Save and Leave" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save and Leave' }));
    expect(onSave).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Discard Changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep Editing' })).toBeInTheDocument();
  });

  it('joins names the American way', () => {
    expect(nameList([])).toBe('');
    expect(nameList(['A'])).toBe('A');
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
