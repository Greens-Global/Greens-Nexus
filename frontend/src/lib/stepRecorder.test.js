import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { startRecording, stopRecording } from './stepRecorder';

// Steps record WHAT was used, never the values (Oct 28 2026: a click inside a
// rich-text editor saved the typed paragraph as the step's label).

afterEach(() => { stopRecording(); document.body.innerHTML = ''; });
// jsdom has no innerText (no layout); the browser's is the element's text.
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } }); });
afterAll(() => { delete HTMLElement.prototype.innerText; });

describe('step recorder', () => {
  it('names a rich-text editor by its label and never saves what was typed in it', () => {
    document.body.innerHTML = '<div contenteditable="true" aria-label="Ticket Description"><p>My SSN is 123-45-6789 please fix</p></div>';
    startRecording();
    document.querySelector('p').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const steps = stopRecording();
    const all = JSON.stringify(steps);
    expect(all).not.toContain('123-45-6789');
    expect(steps.at(-1)).toMatchObject({ role: 'typed into', label: 'Ticket Description' });
  });

  it('falls back to "Text Editor" for an unlabeled editor, still without its text', () => {
    document.body.innerHTML = '<div contenteditable><p>Secret plan</p></div>';
    startRecording();
    document.querySelector('p').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const steps = stopRecording();
    expect(JSON.stringify(steps)).not.toContain('Secret plan');
    expect(steps.at(-1).label).toBe('Text Editor');
  });

  it('still names a button by its text', () => {
    document.body.innerHTML = '<button type="button">Save Changes</button>';
    startRecording();
    document.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(stopRecording().at(-1)).toMatchObject({ role: 'clicked', label: 'Save Changes' });
  });
});
