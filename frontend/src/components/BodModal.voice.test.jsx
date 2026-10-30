// BOD / EOD by voice (Neil, Oct 30 2026): the mic on the task list makes
// each spoken phrase its own line, under what is already there, so the Teams
// post still reads one task per line; the message mic types inline.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com', actingAs: null, realEmail: 'neil@greensglobal.com' }) }));
vi.mock('../msalInstance', () => ({ msalInstance: { getActiveAccount: () => ({ username: 'neil@greensglobal.com' }) } }));
vi.mock('../lib/geoPosition', () => ({ getPosition: vi.fn(async () => null), PUNCH_GEO_MS: { in: 10 } }));
vi.mock('../lib/punchLocation', () => ({ locationPermission: vi.fn(async () => 'granted') }));
vi.mock('../lib/bodQueue', () => ({ bodDurable: vi.fn(async () => ({})), newBodId: () => 'bod_1' }));
vi.mock('../api', () => {
  const named = { timeMyChat: async () => ({ chatId: '', chatName: '' }), getTasks: async () => [], timeStatus: async () => null, timeWhere: async () => ({ label: '' }) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (async () => ({})) }) };
});

const { default: BodModal, addSpokenLine } = await import('./BodModal');

afterEach(() => { cleanup(); delete window.webkitSpeechRecognition; try { localStorage.clear(); } catch { /* none */ } });

describe('addSpokenLine', () => {
  it('puts each phrase on its own capitalized line', () => {
    expect(addSpokenLine('', 'call the vendor')).toBe('Call the vendor');
    expect(addSpokenLine('Call the vendor\n', 'order the gravel')).toBe('Call the vendor\nOrder the gravel');
    expect(addSpokenLine('Call the vendor', '   ')).toBe('Call the vendor');
  });
});

describe('BodModal dictation', () => {
  it('says each task onto its own line', async () => {
    let rec;
    window.webkitSpeechRecognition = function SR() { rec = this; this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); this.abort = vi.fn(); };
    await act(async () => { render(<BodModal mode="bod" onClose={vi.fn()} />); });
    fireEvent.click(screen.getByRole('button', { name: /Say Each Task/ }));
    expect(rec.start).toHaveBeenCalled();
    await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'walk the Temecula site' } }] }); });
    await act(async () => { rec.onresult({ resultIndex: 1, results: [{ isFinal: true, 0: { transcript: 'walk the Temecula site' } }, { isFinal: true, 0: { transcript: 'order the gravel' } }, { isFinal: true, 0: { transcript: 'call the inspector' } }] }); });
    const tasks = screen.getAllByRole('textbox').find((t) => t.value.includes('Walk the Temecula site'));
    expect(tasks.value).toBe('Walk the Temecula site\nOrder the gravel\nCall the inspector');
  });
});
