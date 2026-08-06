import { describe, it, expect, vi } from 'vitest';

// Pasting a screenshot into a comment put it in twice: the rich editor's own
// handlePaste embeds it inline and calls preventDefault, and that event then
// BUBBLES to the composer's wrapper, which staged the same file as a pending
// attachment. The comment rendered the image inline and again as an attachment
// card underneath.
//
// The wrapper is still the fallback for a paste that lands outside the editor,
// so it cannot simply be deleted - it has to defer when the editor already took
// the event.

const { onPasteStage } = await import('./TaskDetailDrawer');

function pasteEvent({ handled = false } = {}) {
  const file = new File([new Blob(['x'])], 'screenshot.png', { type: 'image/png' });
  return {
    defaultPrevented: handled,
    nativeEvent: { defaultPrevented: handled },
    preventDefault: vi.fn(),
    clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] },
  };
}

describe('comment composer paste', () => {
  it('stages an image when the paste landed outside the editor', () => {
    const setFiles = vi.fn();
    const e = pasteEvent();
    onPasteStage(e, setFiles);
    expect(setFiles).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('does not stage one the editor has already embedded', () => {
    // The duplicate. The editor calls preventDefault before this ever runs.
    const setFiles = vi.fn();
    onPasteStage(pasteEvent({ handled: true }), setFiles);
    expect(setFiles).not.toHaveBeenCalled();
  });

  it('ignores a paste carrying no image', () => {
    const setFiles = vi.fn();
    const e = {
      defaultPrevented: false, nativeEvent: { defaultPrevented: false },
      preventDefault: vi.fn(),
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] },
    };
    onPasteStage(e, setFiles);
    expect(setFiles).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
