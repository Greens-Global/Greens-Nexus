import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HRuler } from './Ruler';

// Word's horizontal ruler (Neil, 11/11/2026): the margins' edges and the
// paragraph's indent markers are drags that write points / inches back.
// jsdom lays nothing out, so the ruler's box starts at x = 0 and a pointer's
// clientX is its position on the ruler. Letter: 816 px, 1" margins at 100%.
const MARGINS = { left: 1, right: 1, top: 1, bottom: 1 };
// jsdom has no PointerEvent; a MouseEvent carries clientX and button.
if (!window.PointerEvent) window.PointerEvent = class PointerEvent extends MouseEvent {};

function drag(el, toX) {
  fireEvent.pointerDown(el, { button: 0, clientX: 0 });
  fireEvent.pointerMove(window, { clientX: toX });
  fireEvent.pointerUp(window, { clientX: toX });
}

describe('the horizontal ruler', () => {
  it('draws the paragraph markers only inside a paragraph', () => {
    const { rerender } = render(<HRuler widthPx={816} margins={MARGINS} para={null} />);
    expect(screen.queryByRole('slider', { name: 'Left Indent' })).toBeNull();
    rerender(<HRuler widthPx={816} margins={MARGINS} para={{ left: 0, first: 0, right: 0 }} />);
    for (const name of ['First Line Indent', 'Hanging Indent', 'Left Indent', 'Right Indent']) expect(screen.getByRole('slider', { name })).toBeTruthy();
  });

  it('moves the left indent half an inch, snapped to 1/16 inch', () => {
    const onIndent = vi.fn();
    render(<HRuler widthPx={816} margins={MARGINS} para={{ left: 0, first: 0, right: 0 }} onIndent={onIndent} />);
    drag(screen.getByRole('slider', { name: 'Left Indent' }), 96 + 49);   // 1" margin + 0.51" -> snaps to 0.5"
    expect(onIndent).toHaveBeenCalledWith({ indentLeft: 36 });
  });

  it('a first-line drag is measured from the left indent; a hanging drag keeps the first line where it is', () => {
    const onIndent = vi.fn();
    render(<HRuler widthPx={816} margins={MARGINS} para={{ left: 36, first: 0, right: 0 }} onIndent={onIndent} />);
    drag(screen.getByRole('slider', { name: 'First Line Indent' }), 96 + 96);   // 1" from the margin, 0.5" past the left indent
    expect(onIndent).toHaveBeenLastCalledWith({ indentFirst: 36 });
    drag(screen.getByRole('slider', { name: 'Hanging Indent' }), 96 + 96);      // the left indent moves to 1", the first line stays at 0.5"
    expect(onIndent).toHaveBeenLastCalledWith({ indentLeft: 72, indentFirst: -36 });
  });

  it('sets a margin from its edge, in inches', () => {
    const onMargin = vi.fn();
    render(<HRuler widthPx={816} margins={MARGINS} para={null} onMargin={onMargin} />);
    drag(screen.getByTitle('Right Margin'), 816 - 144);   // 1.5" from the right edge
    expect(onMargin).toHaveBeenCalledWith('right', 1.5);
  });

  it('does nothing on a read-only document', () => {
    const onMargin = vi.fn();
    render(<HRuler widthPx={816} margins={MARGINS} para={null} editable={false} onMargin={onMargin} />);
    expect(screen.queryByTitle('Right Margin')).toBeNull();
  });
});
