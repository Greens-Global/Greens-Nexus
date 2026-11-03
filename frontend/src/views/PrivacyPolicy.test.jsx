import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockApi = vi.hoisted(() => ({ privacyNoticeMe: vi.fn() }));
vi.mock('../api', () => ({ api: mockApi, API_BASE: 'http://api.test' }));

import PrivacyPolicy from './PrivacyPolicy';

const NOTICE = {
  title: 'Privacy Policy', updated: '11/02/2026', version: '2026-11-02',
  sections: [
    { h: '2. What We Collect and Why', p: ['Nexus collects personal information about you.'], list: ['Location (sensitive): punches.'] },
    { h: '4. AI Features', p: ['On this Nexus, AI features are OFF: nothing is sent to Anthropic.'], aiStatus: { enabled: false } },
    { h: '5. Who We Share It With', p: ['Nexus does not sell your personal information.'],
      groupTitles: { core: 'Services every Nexus uses', ai: 'AI' },
      processors: [
        { key: 'supabase', name: 'Supabase', group: 'core', purpose: 'Database', data: 'Everything' },
        { key: 'anthropic', name: 'Anthropic (Claude AI)', group: 'ai', purpose: 'AI features', data: 'The text' },
      ] },
  ],
};

describe('PrivacyPolicy', () => {
  beforeEach(() => { mockApi.privacyNoticeMe.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('public page reads the server notice with a plain fetch and draws the processors', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(NOTICE) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PrivacyPolicy />);
    expect(await screen.findByText('Supabase')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/policy/privacy-notice');
    expect(screen.getByText('Anthropic (Claude AI)')).toBeTruthy();
    expect(screen.getByText('AI Features: Off')).toBeTruthy();
    expect(screen.queryByText('Draft for Counsel Review')).toBeNull();
    expect(screen.queryByText('In Use')).toBeNull();
    expect(mockApi.privacyNoticeMe).not.toHaveBeenCalled();
  });

  it('embedded page shows In Use and, for administrators, the counsel-review note', async () => {
    mockApi.privacyNoticeMe.mockResolvedValue({
      ...NOTICE,
      sections: NOTICE.sections.map((s) => (s.processors ? { ...s, processors: s.processors.map((p) => ({ ...p, inUse: p.key === 'supabase' })) } : s)),
      admin: { counselReview: true, needsInput: [{ company: 'Bare Co', field: 'HR Contact', where: 'Settings > Companies > Profile' }],
        signInPolicyOutOfDate: { missing: ['Location'] } },
    });
    render(<PrivacyPolicy embedded />);
    expect(await screen.findByText('Draft for Counsel Review')).toBeTruthy();
    expect(screen.getAllByText('In Use', { selector: 'th' }).length).toBe(2);
    expect(screen.getByText(/Bare Co/)).toBeTruthy();
    expect(screen.getByText('Sign-In Policy Out of Date')).toBeTruthy();
  });

  it('never renders blank: a summary with Try Again when the server is unreachable', async () => {
    mockApi.privacyNoticeMe.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(NOTICE);
    render(<PrivacyPolicy embedded />);
    expect(await screen.findByText(/could not be loaded right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try Again/ }));
    await waitFor(() => expect(screen.getByText('Supabase')).toBeTruthy());
  });
});
