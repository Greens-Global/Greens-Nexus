import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Access > People: ten people a page, with a count and Previous / Next, and a
// search starts again at page one.

const dir = Array.from({ length: 23 }, (_, i) => ({
  email: `p${i + 1}@example.com`, display_name: `Person ${String(i + 1).padStart(2, '0')}`,
}));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: dir }) }));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: () => true, myRole: 'owner', myEmail: 'me@example.com' }) };
});

const RolesAccess = (await import('./RolesAccess')).default;

afterEach(() => { cleanup(); });

describe('Access > People paging', () => {
  it('shows ten people a page and moves between pages', async () => {
    render(<RolesAccess embedded />);
    expect(await screen.findByText('Person 01')).toBeInTheDocument();
    expect(screen.getByText('Person 10')).toBeInTheDocument();
    expect(screen.queryByText('Person 11')).not.toBeInTheDocument();
    expect(screen.getByText('1-10 of 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Person 11')).toBeInTheDocument();
    expect(screen.queryByText('Person 01')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('21-23 of 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('starts a search from the first page', async () => {
    render(<RolesAccess embedded />);
    await screen.findByText('Person 01');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('11-20 of 23')).toBeInTheDocument();
    // Still matches everyone, so the pager stays - and is back on page one.
    fireEvent.change(screen.getByPlaceholderText('Search anyone…'), { target: { value: 'person' } });
    expect(screen.getByText('1-10 of 23')).toBeInTheDocument();
    expect(screen.getByText('Person 01')).toBeInTheDocument();
  });
});
