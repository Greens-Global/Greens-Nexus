import { describe, it, expect } from 'vitest';
import { isPreviewHost, handoffUrl, challengeFor, PREVIEW_HOST, finishPreviewSignIn, autoPreviewSignIn } from './previewSignIn';

describe('hosted Build Mode previews', () => {
  it('knows our preview addresses and nothing else', () => {
    expect(isPreviewHost('0d332dc0.greens-nexus-dev.pages.dev')).toBe(true);
    expect(isPreviewHost('claude-hopeful-brown-y9pezg.greens-nexus-dev.pages.dev')).toBe(true);
    expect(isPreviewHost('greens-nexus-dev.pages.dev')).toBe(false);          // the project itself
    expect(isPreviewHost('a.b.greens-nexus-dev.pages.dev')).toBe(false);
    expect(isPreviewHost('x.greens-nexus-dev.pages.dev.evil.example')).toBe(false);
    expect(isPreviewHost('dev.nexus.greensglobal.com')).toBe(false);
    expect(isPreviewHost('localhost')).toBe(false);
  });

  it('is off everywhere else (tests run on localhost)', async () => {
    expect(PREVIEW_HOST).toBe(false);
    expect(await finishPreviewSignIn()).toBe(false);
    expect(autoPreviewSignIn()).toBe(false);
  });

  it('sends the dev site the origin, the path and the challenge', () => {
    const u = new URL(handoffUrl({ origin: 'https://abc.greens-nexus-dev.pages.dev', next: '/tasks/home?x=1', challenge: 'c'.repeat(43) }));
    expect(u.origin + u.pathname).toBe('https://dev.nexus.greensglobal.com/api/auth/preview-handoff');
    expect(u.searchParams.get('to')).toBe('https://abc.greens-nexus-dev.pages.dev');
    expect(u.searchParams.get('next')).toBe('/tasks/home?x=1');
    expect(u.searchParams.get('challenge')).toBe('c'.repeat(43));
  });

  it('hashes the verifier the way the server does (sha256, base64url, no padding)', async () => {
    // build_preview.challenge_of("v" * 43) on the server
    const c = await challengeFor('v'.repeat(43));
    expect(c).toBe('7w_YNF9DSfIdPf_pRjSq646_kPr-2-o9NAl16JGghdM');
  });
});
