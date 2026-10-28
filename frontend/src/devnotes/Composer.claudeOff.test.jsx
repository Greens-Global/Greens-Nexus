import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The comment box while Send to Claude Code is on hold (meta.CLAUDE_SEND_ON
// off, Pranshu Oct 27): one Save that never sends - Ctrl+Enter too - and
// Record asks With Audio or Without Audio first, with Mic On / Off while it runs.

vi.mock('../api', () => ({
  api: { devNotesOwnerOf: vi.fn(() => Promise.resolve({ owner: null, held: false })) },
  onApiRequest: vi.fn(() => () => {}),
  setApiBodyCapture: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: null, supabaseUrl: '', supabaseAnonKey: '' }));

// The switch is on in the app (Oct 27); this file covers it turned off.
vi.mock('./meta', async (importOriginal) => ({ ...(await importOriginal()), CLAUDE_SEND_ON: false }));

const Composer = (await import('./Composer')).default;
afterEach(cleanup);

const pick = { target: { tag: 'button', text: 'Mark All Read', selector: '#x', headings: [], components: [] }, rect: { x: 10, y: 10, w: 100, h: 30 }, mode: 'element' };
const draft = { id: 'd1', kind: 'bug', priority: 'normal', comment: '', attachments: [] };
const mount = (extra = {}) => {
  const p = { onSave: vi.fn(), onRecord: vi.fn(), onRecordChoice: vi.fn(), onRecordAskCancel: vi.fn(), onToggleAudio: vi.fn(), ...extra };
  render(<Composer pick={pick} draft={draft} onChange={vi.fn()} onCancel={vi.fn()} settings={{ sendInstantly: true }} view="tasks" {...p} />);
  return p;
};

describe('Composer while Send to Claude Code is on hold', () => {
  it('has one Save, which only saves - even with Send Instantly stored - and Ctrl+Enter only saves', () => {
    const p = mount();
    expect(screen.queryByRole('button', { name: /Save And Send/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onSave).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(screen.getByTestId('bm-composer'), { key: 'Enter', ctrlKey: true });
    expect(p.onSave).toHaveBeenLastCalledWith(false);
  });

  it('Record asks With Audio or Without Audio, and the pick starts it', () => {
    const p = mount({ askRecord: true });
    fireEvent.click(screen.getByRole('button', { name: /Without Audio/ }));
    expect(p.onRecordChoice).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: /With Audio/ }));
    expect(p.onRecordChoice).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Do not record' }));
    expect(p.onRecordAskCancel).toHaveBeenCalled();
  });

  it('while recording without sound, Mic Off turns the mic on', () => {
    const p = mount({ recording: { startedAt: Date.now(), transcript: '', audio: false } });
    expect(screen.getByText(/Recording without sound/)).toBeTruthy();
    const mic = screen.getByRole('button', { name: /Mic Off/ });
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(mic);
    expect(p.onToggleAudio).toHaveBeenCalled();
  });
});
