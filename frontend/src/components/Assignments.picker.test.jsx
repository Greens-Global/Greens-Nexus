import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Item Management > Assign: the person box is the searchable people picker
// (Oct 25 2026). Each row keeps the email (Visesh: several people share a
// name across domains) and the pick is the same email the old list stored.

const DIR = [
  { email: 'neil@greensglobal.com', name: 'Neil Kadakia' },
  { email: 'neil@gse.com', name: 'Neil Kadakia' },
  { email: 'amy@greensglobal.com', name: 'Amy Wilson' },
];
const assign = vi.fn(() => Promise.resolve({}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: DIR }) }));
vi.mock('../api', () => ({ api: { assignItem: (...a) => assign(...a), getPeopleDirectory: () => Promise.resolve(DIR) } }));
vi.mock('./PersonHoverCard', () => ({ default: ({ children }) => children }));

const { AssignItemModal } = await import('./Assignments');

beforeEach(() => {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
  try { localStorage.clear(); } catch { /* none */ }
});

describe('Assign item person picker', () => {
  it('searches, tells same-named people apart by email, and keeps the picked email', () => {
    render(<AssignItemModal item={{ id: 'i1', name: 'Laptop', ownershipType: 'permanent' }} onClose={() => {}} onDone={() => {}} toast={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Assign To:/ }));
    fireEvent.change(screen.getByPlaceholderText('Search people…'), { target: { value: 'neil' } });
    const rows = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(rows.some((t) => t.includes('neil@greensglobal.com'))).toBe(true);
    expect(rows.some((t) => t.includes('neil@gse.com'))).toBe(true);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Neil Kadakia - neil@gse.com'));
    expect(screen.getByRole('button', { name: /^Assign To:/ }).textContent).toContain('neil@gse.com');
  });
});
