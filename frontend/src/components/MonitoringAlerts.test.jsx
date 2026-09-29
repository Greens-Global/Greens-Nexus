import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Render-smoke for the monitoring alerts after they moved off the Time screen
// (Charmi, Sep 25): the Time screen keeps one line that leads to Workforce
// Analytics; the list itself is folded there until it is opened.

const alerts = [
  { email: 'a@greensglobal.com', name: 'Arnav Kapoor', reason: 'Agent stopped reporting', detail: 'Last checked in 5995 min ago', severity: 'medium' },
  { email: 'b@greensglobal.com', name: 'Amy Bolanos', reason: 'No agent reporting', detail: 'Clocked in with no enrolled agent and no recent capture.', severity: 'high' },
];
vi.mock('../api', () => ({ api: { timeMonitoringAlerts: vi.fn(async () => ({ alerts })) } }));

import { MonitoringAlertsLine, MonitoringAlertsPanel } from './MonitoringAlerts';
import { api } from '../api';

beforeEach(() => { vi.clearAllMocks(); api.timeMonitoringAlerts.mockResolvedValue({ alerts }); });

describe('monitoring alerts', () => {
  it('is one line on the Time screen and leads to Workforce Analytics', async () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    render(<MonitoringAlertsLine />);
    expect(await screen.findByText('2 monitoring alerts')).toBeTruthy();
    // Nobody is listed here: the list is what took half the screen.
    expect(screen.queryByText('Arnav Kapoor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View in Workforce Analytics' }));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'employee-tracking', sub: 'coverage' }]);
  });

  it('lists everyone on Workforce Analytics once it is opened', async () => {
    render(<MonitoringAlertsPanel />);
    const head = await screen.findByRole('button', { name: /Monitoring Alerts/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Arnav Kapoor')).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText('Arnav Kapoor')).toBeTruthy();
    expect(screen.getByText('No agent reporting')).toBeTruthy();
  });

  it('draws nothing when all is well', async () => {
    api.timeMonitoringAlerts.mockResolvedValue({ alerts: [] });
    const { container } = render(<><MonitoringAlertsLine /><MonitoringAlertsPanel /></>);
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });
});
