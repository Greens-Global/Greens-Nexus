import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Render-smoke for Marketing > Insights. Not connected to Google -> the
// review card is the sample one on the page's range; connected -> it is the
// real Google rating as of today, compared with last calendar month, and says
// so. The rest of the page stays on its samples either way.

vi.mock('../../api', () => ({ api: { getGbpReviewFeed: vi.fn() } }));

import { api } from '../../api';
import InsightsPage from './InsightsPage';
import { thisMonth } from '../shared/utils';
import { ALL_PROPERTIES } from '../shared/facilities';

const props = {
  range: thisMonth(), onRangeChange: () => {}, property: ALL_PROPERTIES, onPropertyChange: () => {},
  onNavigate: () => {}, alerts: [], onClearAlert: () => {}, leadGoalByProperty: {}, onChangeLeadGoal: () => {},
  monthlyBudgetByProperty: {}, action: null, onClearAction: () => {},
};

const now = new Date();
const ym = (d) => d.toISOString().slice(0, 7);
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10));
const review = (id, rating, createdAt) => ({ id, facility: 'Greens Storage Fresno', reviewer: 'A', rating, text: 'ok', createdAt, replied: true, repliedAt: createdAt });

beforeEach(() => vi.clearAllMocks());

describe('InsightsPage', () => {
  it('keeps the sample review rating until Google is connected', async () => {
    api.getGbpReviewFeed.mockResolvedValue({ connected: false, reviews: [] });
    render(<InsightsPage {...props} />);
    expect(screen.getByText('Review Rating (Avg.)')).toBeTruthy();
    await waitFor(() => expect(api.getGbpReviewFeed).toHaveBeenCalled());
    expect(screen.queryByText('Google, as of today')).toBeNull();
  });

  it('shows the real Google rating as of today once connected', async () => {
    api.getGbpReviewFeed.mockResolvedValue({
      connected: true,
      reviews: [review('a', 5, `${ym(now)}-01T10:00:00Z`), review('b', 4, `${ym(now)}-01T09:00:00Z`), review('c', 2, `${ym(lastMonth)}-10T10:00:00Z`)],
    });
    render(<InsightsPage {...props} />);
    expect(await screen.findByText('Google, as of today')).toBeTruthy();
    // (5 + 4 + 2) / 3 = 3.7 today; 2.0 at the end of last month.
    expect(screen.getByText('3.7')).toBeTruthy();
    const [y, m] = [lastMonth.getUTCFullYear(), String(lastMonth.getUTCMonth() + 1).padStart(2, '0')];
    expect(screen.getByText(`vs ${m}/${y}`)).toBeTruthy();
  });
});
