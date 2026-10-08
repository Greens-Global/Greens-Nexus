import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Marketing > Reputation / Business Profile on real Google
// data (Neil call of 10/01): not connected -> the sample page with the
// connection bar above it; connected -> the Replied / Unreplied split with
// who answered, a reply posted in place, and the listing cards with their
// review link. Google itself is never called - the API is mocked.

vi.mock('../../api', () => ({
  api: {
    getGbpStatus: vi.fn(),
    getGbpLocations: vi.fn(),
    getGbpReviews: vi.fn(),
    replyGbpReview: vi.fn(),
    startGbpConnect: vi.fn(),
    getGbpPerformance: vi.fn(),
    getGbpPosts: vi.fn(),
    getGbpPhotos: vi.fn(),
    createGbpPost: vi.fn(),
  },
}));
vi.mock('../../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, canAccessModule: () => true }),
}));

import { api } from '../../api';
import GbpTab from './GbpTab';

const tabBarProps = { onNavigate: () => {}, alerts: [], insights: [], onClearAlert: () => {} };
const location = {
  id: 'locations/222', key: '222', title: 'Greens Storage Fresno', address: '100 Main St, Fresno, CA 93721',
  phone: '(559) 555-0100', website: 'https://greensstorage.com', placeId: 'ChIJplace',
  reviewLink: 'https://search.google.com/local/writereview?placeid=ChIJplace', facility: '',
  reviewCount: 2, avgRating: 3.5, syncedAt: '2026-10-06T12:00:00Z', description: 'Self storage',
  regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 9 }, closeDay: 'MONDAY', closeTime: { hours: 17 } }] },
  specialHours: {}, pendingGoogleReview: false,
};
const unreplied = {
  id: 'rv1', locationId: 'locations/222', location: 'Greens Storage Fresno', reviewer: 'Mark T', rating: 2,
  comment: 'The gate was broken.', createdAt: '2026-10-05T10:00:00Z', replied: false, reply: '', repliedBy: '', repliedByName: '', repliedAt: '',
};
const connected = {
  configured: true, connected: true, accountEmail: 'nexus@kadakia.com', accountLabel: 'Greens Storage', locationCount: 1,
  lastSyncAt: '2026-10-06T12:00:00Z', lastError: '', needsReconnect: false, redirectUri: 'https://api/marketing/gbp/oauth/callback',
};

const day = (date, n) => ({ date, mapsViews: n, searchViews: n, websiteClicks: 1, callClicks: 2, directionRequests: 0 });
const photo = { id: 'm1', url: 'https://lh3.googleusercontent.com/p/m1', thumbnailUrl: 'https://lh3.googleusercontent.com/p/m1', category: 'EXTERIOR', createdAt: '2026-10-01T10:00:00Z', views: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  api.getGbpPerformance.mockResolvedValue({
    rows: [day('2026-10-04', 50), day('2026-10-05', 70)], prevRows: [day('2026-10-02', 30), day('2026-10-03', 30)],
    keywords: [{ keyword: 'storage fresno', impressions: 320, belowThreshold: false }, { keyword: 'rv storage', impressions: 15, belowThreshold: true }],
    keywordMonths: ['2026-09'], firstDate: '2025-04-01', syncedAt: '2026-10-06T12:00:00Z', error: '',
  });
  api.getGbpPosts.mockResolvedValue([{ id: 'p1', summary: 'Fall special: first month free', state: 'LIVE', ctaType: 'LEARN_MORE', ctaUrl: 'https://greensstorage.com', createdAt: '2026-10-01T10:00:00Z', imageUrl: '', searchUrl: '' }]);
  api.getGbpPhotos.mockResolvedValue([photo]);
  api.getGbpLocations.mockResolvedValue([location]);
  api.getGbpReviews.mockResolvedValue({ total: 1, counts: { all: 2, unreplied: 1, replied: 1 }, reviews: [unreplied] });
});

describe('GbpTab', () => {
  it('keeps the sample page, with the connect bar, until Google is connected', async () => {
    api.getGbpStatus.mockResolvedValue({ ...connected, connected: false, locationCount: 0 });
    render(<GbpTab tab="reputation" tabBarProps={tabBarProps} renderSample={(bar) => <div>{bar}<p>SAMPLE PAGE</p></div>} />);
    expect(await screen.findByText('SAMPLE PAGE')).toBeTruthy();
    expect(screen.getByText('Google Business Profile Is Not Connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect Google/ })).toBeTruthy();
  });

  it('shows real reviews once connected, and a posted reply records who answered', async () => {
    api.getGbpStatus.mockResolvedValue(connected);
    api.replyGbpReview.mockImplementation(async (id, text) => ({
      ...unreplied, replied: true, reply: text, repliedBy: 'amy@greensglobal.com', repliedByName: 'Amy Lee', repliedAt: '2026-10-06T13:00:00Z',
    }));
    render(<GbpTab tab="reputation" tabBarProps={tabBarProps} renderSample={() => <p>SAMPLE PAGE</p>} />);
    expect(await screen.findByText('The gate was broken.')).toBeTruthy();
    expect(screen.queryByText('SAMPLE PAGE')).toBeNull();
    expect(screen.getByText(/Connected to Google/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Suggest Reply/ }));
    const box = screen.getByPlaceholderText(/Write a reply/);
    expect(box.value).toContain('(559) 555-0100');           // the location's phone, not the template's
    fireEvent.change(box, { target: { value: 'Sorry about the gate - it is fixed.' } });
    fireEvent.click(screen.getByRole('button', { name: /Post Reply/ }));
    await waitFor(() => expect(api.replyGbpReview).toHaveBeenCalledWith('rv1', 'Sorry about the gate - it is fixed.'));
    expect(await screen.findByText(/Replied by Amy Lee/)).toBeTruthy();
  });

  it('shows each listing with its review link on Business Profile', async () => {
    api.getGbpStatus.mockResolvedValue(connected);
    render(<GbpTab tab="listings" tabBarProps={tabBarProps} renderSample={() => <p>SAMPLE PAGE</p>} />);
    expect(await screen.findByText('Greens Storage Fresno', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy Review Link/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Edit Listing/ })).toBeTruthy();
    expect(screen.getByText('9:00 AM - 5:00 PM')).toBeTruthy();
    // Performance from Google, against the period before: 240 views vs 120.
    expect(await screen.findByText('240')).toBeTruthy();
    expect(screen.getByText('storage fresno')).toBeTruthy();
    expect(screen.getByText('over 15')).toBeTruthy();
  });

  it('lists posts and publishes a new one with a location photo', async () => {
    api.getGbpStatus.mockResolvedValue(connected);
    api.createGbpPost.mockImplementation(async (key, d) => ({ id: 'p2', state: 'PROCESSING', createdAt: '2026-10-06T10:00:00Z', imageUrl: d.photoUrl, ...d }));
    render(<GbpTab tab="listings" tabBarProps={tabBarProps} renderSample={() => <p>SAMPLE PAGE</p>} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Posts' }));
    expect(await screen.findByText('Fall special: first month free')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New Post/ }));
    fireEvent.change(screen.getByLabelText('Post text'), { target: { value: 'Holiday hours this week' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Use this photo' }));
    fireEvent.click(screen.getByRole('button', { name: /Publish to Google/ }));
    await waitFor(() => expect(api.createGbpPost).toHaveBeenCalledWith('222', {
      summary: 'Holiday hours this week', ctaType: '', ctaUrl: 'https://greensstorage.com', photoUrl: photo.url,
    }));
    expect(await screen.findByText('Holiday hours this week')).toBeTruthy();
  });

  it('shows the photos with the paste hint for adding one', async () => {
    api.getGbpStatus.mockResolvedValue(connected);
    render(<GbpTab tab="listings" tabBarProps={tabBarProps} renderSample={() => <p>SAMPLE PAGE</p>} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Photos' }));
    expect(await screen.findByAltText('Exterior photo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add Photo/ }));
    expect(screen.getByText(/press Ctrl\+V to paste an image/)).toBeTruthy();
  });
});
