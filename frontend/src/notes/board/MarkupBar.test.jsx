import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MarkupBar from './MarkupBar';

const props = (over = {}) => ({
  tool: 'select', colorKey: 'red', sizeKey: 'medium',
  onTool: vi.fn(), onColor: vi.fn(), onSize: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), onDelete: vi.fn(), onMore: vi.fn(), ...over,
});

describe('MarkupBar', () => {
  it('lights the active tool and picks another', () => {
    const p = props({ tool: 'pen' });
    render(<MarkupBar {...p} />);
    expect(screen.getByRole('button', { name: 'Pen' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Arrow' }));
    expect(p.onTool).toHaveBeenCalledWith('arrow');
  });

  it('keeps Move Around, Undo / Redo and More for a phone only', () => {
    const { rerender } = render(<MarkupBar {...props()} />);
    expect(screen.queryByRole('button', { name: 'Move Around' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    rerender(<MarkupBar {...props()} phone />);
    expect(screen.getByRole('button', { name: 'Move Around' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
  });

  it('shows Delete on a phone only while something is selected', () => {
    const p = props({ hasSelection: true });
    render(<MarkupBar {...p} phone />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Selected' }));
    expect(p.onDelete).toHaveBeenCalled();
  });

  it('opens the inks and widths from the ink dot; the highlighter has no widths', () => {
    const p = props({ tool: 'pen' });
    const { rerender } = render(<MarkupBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ink: Red' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(p.onColor).toHaveBeenCalledWith('blue');
    fireEvent.click(screen.getByRole('radio', { name: 'Bold' }));
    expect(p.onSize).toHaveBeenCalledWith('bold');
    rerender(<MarkupBar {...p} tool="highlight" />);
    expect(screen.queryByRole('radio', { name: 'Bold' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('radio', { name: 'Blue' })).toBeNull();
  });

  it('opens More Tools and picks one; the button shows the one in use', () => {
    const p = props();
    const { rerender } = render(<MarkupBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Laser Pointer/ }));
    expect(p.onTool).toHaveBeenCalledWith('laser');
    expect(screen.queryByRole('menu', { name: 'More Tools' })).toBeNull();
    rerender(<MarkupBar {...p} tool="laser" />);
    expect(screen.getByRole('button', { name: 'More Tools: Laser Pointer' })).toBeTruthy();
  });
});
