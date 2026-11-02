import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The hover card carries the person's tier mark after their name (Neil,
// 11/02/2026) - from the `tier` field /myhr/person sends, never as text.

const cards = {
  'bo@x.com': { name: 'Bo Boss', jobTitle: 'Controller', department: 'Accounting', photoUrl: '', workEmail: 'bo@x.com', tier: 'super' },
  'sam@x.com': { name: 'Sam Staff', jobTitle: 'Analyst', department: 'Accounting', photoUrl: '', workEmail: 'sam@x.com', tier: '' },
};
vi.mock('../api', () => ({ api: { personCard: (q) => Promise.resolve(cards[q]) } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myGrantedModules: new Map(), myEmail: 'me@x.com' }),
}));
vi.mock('./PersonActions', () => ({ default: () => null }));

const PersonHover = (await import('./PersonHoverCard')).default;

afterEach(cleanup);

async function openCard(email) {
  render(<PersonHover email={email}><span data-testid="av">av</span></PersonHover>);
  fireEvent.focus(screen.getByTestId('av').parentElement);   // focus opens like hover, without pointer types
  return screen.findByText(cards[email].name, {}, { timeout: 2000 });
}

describe('PersonHoverCard - tier mark', () => {
  it('a Super Administrator carries the mark after the name, never the words', async () => {
    const name = await openCard('bo@x.com');
    expect(name.parentElement.querySelector('[aria-label="Super Administrator"]')).toBeTruthy();
    expect(screen.queryByText('Super Administrator')).toBeNull();
    expect(screen.getByText('Controller')).toBeTruthy();
  });

  it('an employee carries no mark', async () => {
    const name = await openCard('sam@x.com');
    expect(name.parentElement.querySelector('svg')).toBeNull();
  });
});
