import { describe, it, expect } from 'vitest';
import { computeAlerts } from '../shared/alerts';
import { buildAccountWideInsightInput } from '../insights/buildAccountWideInsightInput';

// Once Google Business Profile is connected, the alerts bell and the AI
// Analyst read the real review summary (GET /marketing/gbp/summary) instead
// of the sample reviews - and drop Q&A, which Google retired.

const gbp = {
  connected: true, reviewCount: 120, unreplied: 4, lowStarUnreplied: 1, overdueUnreplied: 3,
  rating: { current: 4.6, previous: 4.4 }, positivePct: { current: 88, previous: 80 },
  recentPositiveTexts: ['Clean units'], recentNegativeTexts: ['Gate broke'],
  platformRatings: [{ platform: 'Google', rating: 4.6, reviews: 120 }], stalePhotoLocations: ['Greens Escondido'],
};
const byId = (alerts) => Object.fromEntries(alerts.map((a) => [a.id, a]));

describe('alerts and insights on real Google data', () => {
  it('counts the real backlog and drops Q&A', () => {
    const a = byId(computeAlerts({ monthlyBudget: 18000, leadGoal: 300, gbp }));
    expect(a['low-rating-pending'].message).toMatch(/^1 review at 2★ or below is still unanswered/);
    expect(a['pending-aging'].message).toMatch(/^3 reviews have been waiting over 48 hours/);
    expect(a['qna-unanswered']).toBeUndefined();
    expect(a['photos-stale'].message).toMatch(/^1 property hasn't added/);
  });

  it('keeps the sample alerts while Google is not connected', () => {
    const real = byId(computeAlerts({ monthlyBudget: 18000, leadGoal: 300, gbp: { ...gbp, lowStarUnreplied: 37 } }));
    const sample = byId(computeAlerts({ monthlyBudget: 18000, leadGoal: 300, gbp: { connected: false } }));
    expect(real['low-rating-pending'].message).toMatch(/^37 reviews/);
    expect(sample['low-rating-pending'].message).not.toMatch(/^37 reviews/);
  });

  it('feeds the real rating and backlog to the insight rules', () => {
    const input = buildAccountWideInsightInput({ monthlyBudgetByProperty: { A: 1 }, leadGoalByProperty: { A: 1 }, gbp });
    expect(input.reviewRating).toEqual({ current: 4.6, previous: 4.4 });
    expect(input.reviewBacklog).toEqual({ agingCount: 3 });
    expect(input.gbp).toEqual({ unansweredQuestions: 0, stalePhotoProperties: ['Greens Escondido'] });
    expect(input.recentNegativeReviewTexts).toEqual(['Gate broke']);
  });
});
