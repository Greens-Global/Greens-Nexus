import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The Act As picker shows profile pictures (Neil, Oct 13 2026): the row's own
// photoUrl, else the app-wide People photo map, else initials.

let TARGETS = [];
let DIRECTORY = [];
vi.mock('../api', () => ({ api: {
  getActAsEligibleTargets: () => Promise.resolve(TARGETS),
  getPeopleDirectory: () => Promise.resolve(DIRECTORY),
} }));

const { ActAsPicker } = await import('./ActAsModal');

afterEach(() => cleanup());

describe('Act As picker', () => {
  it('draws a photo from the row, from the People map, or initials', async () => {
    TARGETS = [
      { email: 'ann@x.com', name: 'Ann Able', photoUrl: 'https://cdn/ann.jpg' },
      { email: 'bo@x.com', name: 'Bo Brown', photoUrl: '' },
      { email: 'cy@x.com', name: 'Cy Cole', photoUrl: '' },
    ];
    DIRECTORY = [{ email: 'bo@x.com', photoUrl: 'https://cdn/bo.jpg' }];
    render(<ActAsPicker onStart={vi.fn()} />);
    const ann = (await screen.findByText('Ann Able')).closest('button');
    expect(ann.querySelector('img').getAttribute('src')).toBe('https://cdn/ann.jpg');
    const bo = screen.getByText('Bo Brown').closest('button');
    await vi.waitFor(() => expect(bo.querySelector('img')?.getAttribute('src')).toBe('https://cdn/bo.jpg'));
    const cy = screen.getByText('Cy Cole').closest('button');
    expect(cy.querySelector('img')).toBeNull();
    expect(cy.textContent).toContain('CC');
  });
});
