// Quick Action composers (Oct 14 widget pass): New Email / New Event open from
// inside a dashboard tile, so their overlay is portaled to <body> - rendered in
// the card, a fixed overlay was boxed in by it and painted over by later tiles.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn(async () => [{ email: 'amy@greensglobal.com', name: 'Amy Adams' }]) } }));
vi.mock('../m365', () => ({ sendMail: vi.fn(async () => ({ sent: true })), createEvent: vi.fn(async () => ({ sent: true })) }));
vi.mock('../tasks/TasksContext', () => ({ TasksProvider: ({ children }) => <>{children}</> }));
vi.mock('../tasks/CreateTaskModal', () => ({ default: () => null }));
vi.mock('../links/personalLinkModal.jsx', () => ({ PersonalLinkComposer: () => null }));

import QuickActionModal from './QuickActionModals.jsx';

afterEach(cleanup);

// A stand-in tile: the composer mounts inside it, like the Quick Actions widget.
const inTile = (ui) => render(<div data-testid="tile" style={{ transform: 'translateZ(0)', overflow: 'hidden' }}>{ui}</div>);

describe('Quick Action composers', () => {
  it('New Email renders its overlay on document.body, not inside the tile', async () => {
    inTile(<QuickActionModal kind="email" onClose={() => {}} />);
    const overlay = screen.getByTestId('quick-action-overlay');
    expect(overlay.parentElement).toBe(document.body);
    expect(within(screen.getByTestId('tile')).queryByTestId('quick-action-overlay')).toBeNull();
    expect(within(overlay).getByRole('dialog', { name: 'New Email' })).toBeTruthy();
  });

  it('New Event is portaled too, with Title Case copy and a labeled 36px close button', () => {
    const onClose = vi.fn();
    inTile(<QuickActionModal kind="event" onClose={onClose} />);
    const overlay = screen.getByTestId('quick-action-overlay');
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: /Create Event/ })).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.style.minWidth).toBe('36px');
    expect(close.style.minHeight).toBe('36px');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it('a recipient can be removed with a named, 36px button', async () => {
    inTile(<QuickActionModal kind="email" onClose={() => {}} />);
    const select = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /Amy Adams/ });
    fireEvent.change(select, { target: { value: 'amy@greensglobal.com' } });
    const remove = screen.getByRole('button', { name: 'Remove Amy Adams' });
    expect(remove.style.minHeight).toBe('36px');
    fireEvent.click(remove);
    expect(screen.queryByRole('button', { name: 'Remove Amy Adams' })).toBeNull();
  });
});
