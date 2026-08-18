import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke for the unauthenticated activation route (/activate/{token}) -
// per CLAUDE.md a new public surface must never white-screen: every phase
// (loading, invalid, intro, code) paints something.

const calls = [];
let lookupResult;
global.fetch = vi.fn(async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) });
  if (url.includes('/activate/lookup')) {
    if (lookupResult === 'invalid') {
      return { ok: false, json: async () => ({ detail: 'This invitation link is invalid, already used, or expired - ask your Greens Global contact to send a new one.' }) };
    }
    return { ok: true, json: async () => lookupResult };
  }
  if (url.includes('/activate/send-code')) {
    return { ok: true, json: async () => ({ ok: true, channel: 'sms', delivered: true, hint: '***1234' }) };
  }
  if (url.includes('/activate/verify')) {
    return { ok: true, json: async () => ({ ok: true, next: '/' }) };
  }
  return { ok: false, json: async () => ({}) };
});

vi.mock('../lib/externalAuth', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, EXTERNAL_AUTH_API: '' };
});

const ExternalActivate = (await import('./ExternalActivate')).default;

beforeEach(() => {
  calls.length = 0;
  lookupResult = {
    email: 'pat.partner@buildco.example', firstName: 'Pat', lastName: 'Partner',
    name: 'Pat Partner', company: 'BuildCo', invitedBy: 'Visesh Lodha',
    hasPhone: true, phoneMasked: '***1234',
  };
});

describe('ExternalActivate', () => {
  it('shows the invitation intro after lookup', async () => {
    render(<ExternalActivate token="tok-abc" />);
    expect(await screen.findByText('Welcome, Pat')).toBeTruthy();
    expect(screen.getByText(/Visesh Lodha invited you/)).toBeTruthy();
    expect(screen.getByDisplayValue('pat.partner@buildco.example')).toBeTruthy();
    expect(screen.getByText('Text Me a Code')).toBeTruthy();
    expect(screen.getByText('Email Me a Code')).toBeTruthy();
  });

  it('moves to the code screen after sending', async () => {
    render(<ExternalActivate token="tok-abc" />);
    fireEvent.click(await screen.findByText('Text Me a Code'));
    expect(await screen.findByText('Enter your code')).toBeTruthy();
    expect(screen.getByText(/texted a 6-digit code to \*\*\*1234/)).toBeTruthy();
    expect(screen.getByText('Send to My Email Instead')).toBeTruthy();
    // Verify posts the token + code
    fireEvent.change(screen.getByPlaceholderText('______'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify and Continue'));
    await waitFor(() => expect(calls.some(c => c.url.includes('/activate/verify')
      && c.body.code === '123456' && c.body.token === 'tok-abc')).toBe(true));
  });

  it('confirms an account switch before proceeding when another session exists', async () => {
    lookupResult = {
      ...lookupResult,
      signedInAs: { email: 'visesh.lodha@greensglobal.com', name: 'Visesh Lodha' },
      sessionConflict: true,
    };
    render(<ExternalActivate token="tok-abc" />);
    // Interstitial first - no silent replacement
    expect(await screen.findByText('Switch accounts?')).toBeTruthy();
    expect(screen.getByText('Visesh Lodha')).toBeTruthy();
    expect(screen.getByText('pat.partner@buildco.example')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.queryByText('Text Me a Code')).toBeNull();   // flow is gated
    // Continue proceeds into the normal activation intro
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Welcome, Pat')).toBeTruthy();
    expect(screen.getByText('Text Me a Code')).toBeTruthy();
  });

  it('skips the switch warning when the session is the same email', async () => {
    lookupResult = {
      ...lookupResult,
      signedInAs: { email: 'pat.partner@buildco.example', name: 'Pat Partner' },
      sessionConflict: false,
    };
    render(<ExternalActivate token="tok-abc" />);
    expect(await screen.findByText('Welcome, Pat')).toBeTruthy();
    expect(screen.queryByText('Switch accounts?')).toBeNull();
  });

  it('paints the invalid state instead of white-screening', async () => {
    lookupResult = 'invalid';
    render(<ExternalActivate token="dead-token" />);
    expect(await screen.findByText('This link is not valid')).toBeTruthy();
    expect(screen.getByText(/ask your Greens Global contact/)).toBeTruthy();
  });
});
