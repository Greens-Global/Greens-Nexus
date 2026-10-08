import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
    expect(container.querySelector('[title]').getAttribute('title')).toContain('Nearest location to that rough point: Menifee');
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

  // Sep 30: "Still not able to click on locations" - the cell was a tooltip only.
  describe('clickable chip', () => {
    const cases = [
      ['a plain site name', { geo: 'in_fence', workSite: 'GS Temecula', out: '' }, 'GS Temecula'],
      ['Out of Location with a different Out site', { geo: 'out_of_fence', workSite: 'Menifee', out: '2026-09-25T17:40:00', geoOut: 'in_fence', workSiteOut: 'GS Temecula' }, 'Out of Location GS Temecula'],
      ['Location off', { geo: 'no_location', workSite: '', out: '' }, 'Location off'],
      ['Approx. Location', { geo: 'low_accuracy', workSite: 'Menifee', out: '' }, 'Approx. Location'],
      ['an Out-punch tail alone', { geo: '', workSite: '', out: '2026-09-25T17:40:00', geoOut: 'out_of_fence', workSiteOut: 'Menifee' }, 'Out of Location'],
    ];
    it.each(cases)('%s is a button that opens the punch map', (_, seg, label) => {
      const onOpen = vi.fn();
      render(<LocCell seg={seg} onOpen={onOpen} />);
      const btn = screen.getByRole('button', { name: /open the punch location map/i });
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.style.cursor).toBe('pointer');
      expect(btn.textContent.replace(/\s+/g, ' ').trim()).toBe(label);
      fireEvent.click(btn);
      expect(onOpen).toHaveBeenCalledWith(seg);
    });

    it('an empty day stays a plain dash', () => {
      render(<LocCell seg={{ geo: '', workSite: '', out: '' }} onOpen={vi.fn()} />);
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});
