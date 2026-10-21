import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

// The red location bar (Neil, Oct 21 2026): a clock-in with no location
// raises it; Turn On puts the fix on the punch, Skip tells the manager.

const turnOnLocation = vi.fn();
vi.mock('../lib/punchLocation', () => ({ turnOnLocation: (...a) => turnOnLocation(...a) }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../api', () => ({ api: {
  timePunchLocation: vi.fn(async () => ({ updated: true })),
  timePunchLocationSkip: vi.fn(async () => ({ skipped: true })),
} }));

import LocationNoticeBar from './LocationNoticeBar';
import { api } from '../api';

const raise = () => act(() => { window.dispatchEvent(new CustomEvent('nexus:location-ask')); });

describe('LocationNoticeBar', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it('shows nothing until a clock-in asks', () => {
    const { container } = render(<LocationNoticeBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Turn On sends the fix and clears the bar', async () => {
    turnOnLocation.mockResolvedValueOnce({ lat: '1', lng: '2', accuracy_m: 5 });
    render(<LocationNoticeBar />);
    raise();
    expect(screen.getByText('Needs Attention: Location Is Off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn On' }));
    await waitFor(() => expect(api.timePunchLocation).toHaveBeenCalledWith({ lat: '1', lng: '2', accuracy_m: 5 }));
    expect(await screen.findByText(/your location is on/)).toBeInTheDocument();
    expect(localStorage.getItem('nexus:location-ask')).toBeNull();
  });

  it('Not Now keeps the bar', async () => {
    turnOnLocation.mockResolvedValueOnce(null);
    render(<LocationNoticeBar />);
    raise();
    fireEvent.click(screen.getByRole('button', { name: 'Turn On' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn On' })).not.toBeDisabled());
    expect(api.timePunchLocation).not.toHaveBeenCalled();
    expect(screen.getByText('Needs Attention: Location Is Off')).toBeInTheDocument();
  });

  it('Skip tells the server and clears the bar', async () => {
    render(<LocationNoticeBar />);
    raise();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText(/shows Location Off/)).toBeInTheDocument();
    expect(api.timePunchLocationSkip).toHaveBeenCalledTimes(1);
  });

  it('comes back after a reload until answered', () => {
    localStorage.setItem('nexus:location-ask', String(Date.now()));
    render(<LocationNoticeBar />);
    expect(screen.getByText('Needs Attention: Location Is Off')).toBeInTheDocument();
  });
});
