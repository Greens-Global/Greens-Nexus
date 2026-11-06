import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// The header's own photo (11/05/2026): the directory takes a moment on every
// page load, so the initials showed first and the photo after - on dev it
// looked like the avatar switched between the photo and "NK" page to page.
// The last photo the directory gave is shown until it answers.

let answer;
vi.mock('../api', () => ({ api: { getPeopleDirectory: () => answer } }));

async function fresh() {
  vi.resetModules();
  return (await import('./peoplePhotos')).usePersonPhoto;
}
function Probe({ use, email }) {
  return <span data-testid="p">{use(email) || 'initials'}</span>;
}

beforeEach(() => { localStorage.clear(); });

describe('usePersonPhoto', () => {
  it('shows the remembered photo while the directory loads, then remembers what it says', async () => {
    let resolve;
    answer = new Promise((r) => { resolve = r; });
    localStorage.setItem('nexus.ownPhoto.neil@x.com', 'https://s/old.jpg');
    const use = await fresh();
    render(<Probe use={use} email="Neil@x.com" />);
    expect(screen.getByTestId('p').textContent).toBe('https://s/old.jpg');
    await act(async () => { resolve([{ email: 'neil@x.com', photoUrl: 'https://s/new.jpg' }]); });
    expect(screen.getByTestId('p').textContent).toBe('https://s/new.jpg');
    expect(localStorage.getItem('nexus.ownPhoto.neil@x.com')).toBe('https://s/new.jpg');
  });

  it('forgets the photo when the directory has none, and keeps it when the directory fails', async () => {
    answer = Promise.resolve([{ email: 'neil@x.com', photoUrl: '' }]);
    localStorage.setItem('nexus.ownPhoto.neil@x.com', 'https://s/old.jpg');
    let use = await fresh();
    const first = render(<Probe use={use} email="neil@x.com" />);
    await act(async () => {});
    expect(screen.getByTestId('p').textContent).toBe('initials');
    expect(localStorage.getItem('nexus.ownPhoto.neil@x.com')).toBeNull();
    first.unmount();

    answer = { then: (_, fail) => fail(new Error('offline')) };   // rejects only once asked
    localStorage.setItem('nexus.ownPhoto.neil@x.com', 'https://s/kept.jpg');
    use = await fresh();
    render(<Probe use={use} email="neil@x.com" />);
    await act(async () => {});
    expect(screen.getByTestId('p').textContent).toBe('https://s/kept.jpg');
  });
});
