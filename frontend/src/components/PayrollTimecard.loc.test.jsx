import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// The timecard's Loc cell (Charmi, Sep 29): Ashley punched in Temecula from a
// desktop with only a rough location, and the cell printed the nearest site's
// name - "Menifee" - as if that were where she was.

vi.mock('../api', () => ({ api: {} }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));

const { LocCell } = await import('./PayrollTimecard');
const text = (seg) => render(<LocCell seg={seg} />).container.textContent.replace(/\s+/g, ' ').trim();

describe('LocCell', () => {
  it('a rough (no-GPS) location never shows a site name as the location', () => {
    const { container } = render(<LocCell seg={{ geo: 'low_accuracy', workSite: 'Menifee', out: '' }} />);
    expect(container.textContent.trim()).toBe('Approx. Location');
    expect(container.textContent).not.toContain('Menifee');
    expect(container.querySelector('[title]').getAttribute('title')).toContain('Nearest work site to that rough point: Menifee');
  });

  it('inside an allowed site shows that site', () => {
    expect(text({ geo: 'in_fence', workSite: 'GS Temecula', out: '' })).toBe('GS Temecula');
  });

  it('outside every allowed site is Out of Location, not the nearest name', () => {
    expect(text({ geo: 'out_of_fence', workSite: 'Menifee', distance: 21000, out: '' })).toBe('Out of Location');
  });

  it('no GPS at all is Location off', () => {
    expect(text({ geo: 'no_location', workSite: '', out: '' })).toBe('Location off');
  });

  it('a rough out-punch is called out without a site name', () => {
    const t = text({ geo: 'in_fence', workSite: 'GS Temecula', out: '2026-09-25T17:40:00', geoOut: 'low_accuracy', workSiteOut: 'Menifee' });
    expect(t).toBe('GS Temecula Out: approx.');
  });
});
