import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Render-smoke for Marketing > Google Ads on real Google Ads data (plan
// Phase 3, read-only): not connected -> the sample page with the connect bar;
// connected -> the server's figures, read-only campaign statuses, the
// campaign-to-property mapping and budgets saved on the server. Google is
// never called - the API is mocked.

vi.mock('../../api', () => ({
  api: {
    getAdsStatus: vi.fn(),
    getAdsReport: vi.fn(),
    getAdsCampaigns: vi.fn(),
    mapAdsCampaigns: vi.fn(),
    startAdsConnect: vi.fn(),
  },
}))
vi.mock('../../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => true, canAccessModule: () => true }),
}))

import { api } from '../../api'
import GoogleAdsPage from './GoogleAdsPage'
import { suggestFacility } from '../shared/facilities'
import { computeAlerts } from '../shared/alerts'

const range = { start: '2026-10-01', end: '2026-10-06' }
const budgets = { 'Greens Valley Center': 1000, 'Greens Escondido': 0, 'Greens Temecula': 0, 'Greens Fairfield': 0, 'Greens Georgetown': 0 }
const baseProps = {
  range, onRangeChange: () => {}, property: 'All Properties', onPropertyChange: () => {}, onNavigate: () => {},
  alerts: [], insights: [], onClearAlert: () => {}, monthlyBudgetByProperty: budgets, onChangeMonthlyBudget: () => {},
  action: null, onClearAction: () => {},
}
const connected = {
  configured: true, connected: true, accountEmail: 'nexus@kadakia.com', accountLabel: 'Greens Global MCC',
  lastSyncAt: '2026-10-06T12:00:00Z', lastError: '', needsReconnect: false, accounts: [{ id: '100', name: 'Greens Storage' }],
  campaignCount: 2, unmappedCount: 1,
}
const day = (date, spend) => ({ date, impressions: 1000, clicks: 40, conversions: 3, spend })
const report = {
  rows: [day('2026-10-05', 120.5), day('2026-10-06', 80)], prevRows: [day('2026-10-03', 50), day('2026-10-04', 50)],
  campaigns: [
    { id: '100|1', name: 'Valley Center - Brand', platform: 'Google Search', facility: 'Greens Valley Center', status: 'Active', spend: 150.5, clicks: 60, conversions: 4, impressions: 1500 },
    { id: '100|2', name: 'Escondido - Local', platform: 'Google Local', facility: 'Unassigned', status: 'Paused', spend: 50, clicks: 20, conversions: 2, impressions: 500 },
  ],
  geoRows: [{ location: 'Greens Valley Center', impressions: 1500, clicks: 60, conversions: 4, spend: 150.5 },
            { location: 'Unassigned', impressions: 500, clicks: 20, conversions: 2, spend: 50 }],
  keywordRows: [{ keyword: 'storage near me', clicks: 30, impressions: 800, conversions: 2, spend: 70 }],
  monthSpend: 200.5, firstDate: '2025-08-01', currency: 'USD', syncedAt: '2026-10-06T12:00:00Z', error: '',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getAdsReport.mockResolvedValue(report)
  api.getAdsCampaigns.mockResolvedValue([
    { id: '100|1', name: 'Valley Center - Brand', facility: 'Greens Valley Center', status: 'Active', platform: 'Google Search', account: 'Greens Storage' },
    { id: '100|2', name: 'Escondido - Local', facility: '', status: 'Paused', platform: 'Google Local', account: 'Greens Storage' },
  ])
})

describe('GoogleAdsPage', () => {
  it('keeps the sample page, with the connect bar, until Google Ads is connected', async () => {
    api.getAdsStatus.mockResolvedValue({ ...connected, connected: false })
    render(<GoogleAdsPage {...baseProps} />)
    expect(await screen.findByText('Google Ads Is Not Connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Connect Google/ })).toBeTruthy()
    expect(screen.getByText('Storage - Branded')).toBeTruthy()          // a sample campaign
    expect(api.getAdsReport).not.toHaveBeenCalled()
  })

  it('shows the real figures once connected, with read-only campaign statuses', async () => {
    api.getAdsStatus.mockResolvedValue(connected)
    render(<GoogleAdsPage {...baseProps} />)
    expect(await screen.findByText('Valley Center - Brand')).toBeTruthy()
    expect(api.getAdsReport).toHaveBeenCalledWith({ start: '2026-10-01', end: '2026-10-06', facility: '' })
    expect(screen.queryByText('Storage - Branded')).toBeNull()
    expect(screen.getByText(/Connected to Google/)).toBeTruthy()
    expect(screen.getByText(/1 campaign is not mapped to a property yet/)).toBeTruthy()
    expect(screen.getByText('storage near me')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open Google Ads/ })).toBeTruthy()
  })

  it('a property asks the server for that property only', async () => {
    api.getAdsStatus.mockResolvedValue(connected)
    render(<GoogleAdsPage {...baseProps} property="Greens Valley Center" />)
    await waitFor(() => expect(api.getAdsReport).toHaveBeenCalledWith({ start: '2026-10-01', end: '2026-10-06', facility: 'Greens Valley Center' }))
  })

  it('maps an unmapped campaign to its suggested property', async () => {
    api.getAdsStatus.mockResolvedValue(connected)
    api.mapAdsCampaigns.mockResolvedValue([])
    render(<GoogleAdsPage {...baseProps} />)
    fireEvent.click(await screen.findByRole('button', { name: /Map Campaigns/ }))
    const select = await screen.findByLabelText('Property for Escondido - Local')
    expect(select.value).toBe('Greens Escondido')
    expect(screen.getByText(/Suggested/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Save 1 Change/ }))
    await waitFor(() => expect(api.mapAdsCampaigns).toHaveBeenCalledWith([{ id: '100|2', facility: 'Greens Escondido' }]))
  })

  it('Create Campaign points to Google Ads instead of a local form', async () => {
    api.getAdsStatus.mockResolvedValue(connected)
    render(<GoogleAdsPage {...baseProps} action="create-campaign" />)
    expect(await screen.findByText(/Campaigns are created, edited and paused in Google Ads/)).toBeTruthy()
  })

  it('Set Budget saves every property through the server', async () => {
    api.getAdsStatus.mockResolvedValue(connected)
    const onSaveBudgets = vi.fn().mockResolvedValue(undefined)
    render(<GoogleAdsPage {...baseProps} action="set-budget" onSaveBudgets={onSaveBudgets} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(onSaveBudgets).toHaveBeenCalledWith(budgets))
  })
})

describe('Google Ads helpers', () => {
  it('suggests a property from the campaign name', () => {
    expect(suggestFacility('Storage - Valley Center Brand')).toBe('Greens Valley Center')
    expect(suggestFacility('Brand awareness')).toBe('')
  })

  it('budget alerts use the real spend once Google Ads is connected', () => {
    const over = computeAlerts({ monthlyBudget: 100, leadGoal: 0, ads: { connected: true, monthSpend: 150 } })
    expect(over.find((a) => a.id === 'budget-over')?.message).toContain('$150')
    const fine = computeAlerts({ monthlyBudget: 1000, leadGoal: 0, ads: { connected: true, monthSpend: 150 } })
    expect(fine.find((a) => a.id.startsWith('budget'))).toBeUndefined()
  })
})
