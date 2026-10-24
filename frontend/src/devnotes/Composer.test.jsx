import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Build Mode v2 composer (Oct 24 2026): a pick on another developer's file
// says whose area it is and saves for them (no Save And Send); my own area,
// or a file nobody owns, keeps the v1 buttons.

vi.mock('../api', () => ({ api: {}, onApiRequest: vi.fn(() => () => {}), setApiBodyCapture: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: null, supabaseUrl: '', supabaseAnonKey: '' }));

const Composer = (await import('./Composer')).default;
const { normalizePath, ownerOf, foreignOwner } = await import('./lib/owners');

const OWNERS = [
  { name: 'Visesh', email: 'visesh.lodha@greensglobal.com', paths: ['frontend/src/views/InventoryManagement.jsx', 'frontend/src/components/NotificationBell.jsx', 'backend/routers/items.py'] },
  { name: 'Neil', email: 'neil@greensglobal.com', paths: ['frontend/src/views/PropertyAsset.jsx', 'frontend/src/asset/'] },
];

const pickAt = (file) => ({ target: { tag: 'button', text: 'Mark All Read', selector: '#x', headings: [], components: ['Bell'], source: file ? { file, line: 12, col: 3 } : undefined }, rect: { x: 10, y: 10, w: 100, h: 30 }, mode: 'element' });
const draft = { id: 'd1', kind: 'bug', priority: 'normal', comment: '', attachments: [] };

const mount = (file, { myEmail = 'neil@greensglobal.com', sendInstantly = false, onSave = vi.fn() } = {}) => {
  render(<Composer pick={pickAt(file)} draft={draft} onChange={vi.fn()} onCancel={vi.fn()} onSave={onSave} settings={{ sendInstantly }} view="inventory" owners={OWNERS} myEmail={myEmail} />);
  return onSave;
};

afterEach(() => { cleanup(); });

describe('owners map', () => {
  it('normalizes stamps the way code_owners.py does', () => {
    expect(normalizePath('src/tasks/X.jsx')).toBe('frontend/src/tasks/X.jsx');
    expect(normalizePath('./src/tasks/X.jsx')).toBe('frontend/src/tasks/X.jsx');
    expect(normalizePath('frontend/src/tasks/X.jsx')).toBe('frontend/src/tasks/X.jsx');
    expect(normalizePath('backend/routers/items.py')).toBe('backend/routers/items.py');
  });
  it('matches files exactly and folders by prefix', () => {
    expect(ownerOf('src/components/NotificationBell.jsx', OWNERS)?.name).toBe('Visesh');
    expect(ownerOf('src/asset/lib/sync.js', OWNERS)?.name).toBe('Neil');
    expect(ownerOf('src/components/NotificationBellX.jsx', OWNERS)).toBeNull();
    expect(ownerOf('', OWNERS)).toBeNull();
    expect(foreignOwner('src/asset/lib/sync.js', OWNERS, 'NEIL@greensglobal.com')).toBeNull();
  });
});

describe('Composer - ownership', () => {
  it("someone else's area: the owner line and Save For <Owner>, no Save And Send", () => {
    const onSave = mount('src/components/NotificationBell.jsx');
    expect(screen.getByTestId('bm-owner-line').textContent).toBe("This is Visesh's area - it goes to Visesh, not Claude Code.");
    expect(screen.queryByRole('button', { name: /Save And Send/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save Pin/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Save For Visesh/ }));
    expect(onSave).toHaveBeenCalledWith(false);
  });

  it('Send Instantly does not turn a held pin into Save And Send, and Ctrl+Enter only saves', () => {
    const onSave = mount('src/views/InventoryManagement.jsx', { sendInstantly: true });
    expect(screen.queryByRole('button', { name: /Save And Send/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Save For Visesh/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('bm-composer'), { key: 'Enter', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith(false);
  });

  it('my own area: as before - Save Pin and Save And Send, no owner line', () => {
    mount('src/asset/AssetShell.jsx');
    expect(screen.queryByTestId('bm-owner-line')).toBeNull();
    expect(screen.getByRole('button', { name: /Save Pin/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save And Send/ })).toBeTruthy();
  });

  it('a file nobody owns, or no source stamp: as before', () => {
    mount('src/tasks/Home.jsx');
    expect(screen.queryByTestId('bm-owner-line')).toBeNull();
    expect(screen.getByRole('button', { name: /Save And Send/ })).toBeTruthy();
    cleanup();
    mount(null);
    expect(screen.queryByTestId('bm-owner-line')).toBeNull();
    expect(screen.getByRole('button', { name: /Save And Send/ })).toBeTruthy();
  });
});
