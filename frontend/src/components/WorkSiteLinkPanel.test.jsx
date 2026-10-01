import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Work site from a Google Maps link (Sep 30): pasting reads the link right
// away through the API, the result says how exact the point is, a map-view-
// only link is flagged, a big move from the saved point is called out, and
// the fence check reports recent punches without any names.

vi.mock('../api', () => ({ api: { resolveWorkSiteLink: vi.fn(), workSiteFenceCheck: vi.fn() } }));
const { api } = await import('../api');
const WorkSiteLinkPanel = (await import('./WorkSiteLinkPanel')).default;
const WorkSiteFenceCheck = (await import('./WorkSiteFenceCheck')).default;

const LINK = 'https://maps.app.goo.gl/AbC123';
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe('WorkSiteLinkPanel', () => {
  it('reads a pasted link at once and hands back the exact point', async () => {
    api.resolveWorkSiteLink.mockResolvedValue({ lat: 38.3733338, lng: -122.916713, precision: 'place', label: '469 Bohemian Hwy',
      address: '469 Bohemian Hwy, Sebastopol, CA 95472', placeName: '' });
    const onResolved = vi.fn();
    render(<WorkSiteLinkPanel link="" point={null} savedPoint={null} onResolved={onResolved} />);
    fireEvent.paste(screen.getByLabelText('Google Maps link or coordinates'), { clipboardData: { getData: () => LINK } });
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(api.resolveWorkSiteLink).toHaveBeenCalledWith(LINK);
    expect(onResolved.mock.calls[0][0]).toEqual({ link: LINK, point: { lat: 38.3733338, lng: -122.916713, precision: 'place', label: '469 Bohemian Hwy',
      address: '469 Bohemian Hwy, Sebastopol, CA 95472', placeName: '' } });
  });

  it('shows why a link could not be used', async () => {
    api.resolveWorkSiteLink.mockRejectedValue(new Error('Only Google Maps links are accepted (google.com/maps or maps.app.goo.gl).'));
    render(<WorkSiteLinkPanel link="" point={null} savedPoint={null} onResolved={vi.fn()} />);
    const box = screen.getByLabelText('Google Maps link or coordinates');
    fireEvent.change(box, { target: { value: 'https://evil.example.com/x' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Only Google Maps links are accepted');
  });

  it('marks an exact place green and a map-view-only link amber', () => {
    const { rerender } = render(<WorkSiteLinkPanel link={LINK} point={{ lat: 38.37, lng: -122.91, precision: 'place', label: '' }} savedPoint={null} onResolved={vi.fn()} />);
    expect(screen.getByTestId('link-result')).toHaveTextContent('Exact Place');
    rerender(<WorkSiteLinkPanel link={LINK} point={{ lat: 38.37, lng: -122.91, precision: 'view', label: '' }} savedPoint={null} onResolved={vi.fn()} />);
    expect(screen.getByTestId('link-result')).toHaveTextContent('Map View Only');
    expect(screen.getByRole('link', { name: /Check This Point in Google Maps/ })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=38.37,-122.91');
  });

  it('calls out a big move from where the site is saved', () => {
    render(<WorkSiteLinkPanel link={LINK} point={{ lat: 38.3733, lng: -122.9167, precision: 'place', label: '' }}
      savedPoint={[33.5186, -117.155]} onResolved={vi.fn()} />);
    expect(screen.getByTestId('link-result')).toHaveTextContent(/moves the location \d[\d.]* km from where it is saved now/);
    expect(screen.getByTestId('link-result')).toHaveTextContent('Make sure it is the right building');
  });
});

describe('WorkSiteFenceCheck', () => {
  it('counts punches inside the proposed fence and warns about ones it would lose', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.workSiteFenceCheck.mockResolvedValue({ days: 30, near: 5, inside: 1, people: 1, savedInside: 4,
      points: [{ lat: 38.37, lng: -122.91, accuracyM: 10, distanceM: 5, inside: true }] });
    const onPoints = vi.fn();
    render(<WorkSiteFenceCheck lat="38.37" lng="-122.91" radiusM={150} siteId="s1" moved onPoints={onPoints} />);
    await act(async () => { vi.advanceTimersByTime(700); });
    const box = await screen.findByTestId('fence-check');
    expect(api.workSiteFenceCheck).toHaveBeenCalledWith({ lat: 38.37, lng: -122.91, radiusM: 150, siteId: 's1' });
    expect(box).toHaveTextContent('1 punch from 1 person fall inside this fence');
    expect(box).toHaveTextContent('3 punches inside the saved fence would become Out of Location');
    expect(onPoints).toHaveBeenCalledWith([{ lat: 38.37, lng: -122.91, accuracyM: 10, distanceM: 5, inside: true }]);
  });

  it('renders nothing until the site has a point', () => {
    const { container } = render(<WorkSiteFenceCheck lat="" lng="" radiusM={150} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.workSiteFenceCheck).not.toHaveBeenCalled();
  });
});
