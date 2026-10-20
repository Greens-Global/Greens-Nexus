// The Site Map's one search (Oct 20 2026): units here match instantly, Cubby
// hits arrive grouped, Enter on an exact unit opens it, and the not-found
// messages show inside the popover.
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SiteMapSearch } from './SiteMapSearch.jsx';
import { normalizeQuery } from './unitQuery.js';

const units = [{ n: 'C214', w: 10, d: 15 }, { n: 'C215', w: 10, d: 15 }, { n: 'A015', w: 11, d: 30 }];
const box = () => screen.getByRole('combobox', { name: 'Find a unit or tenant' });
const type = (v) => fireEvent.change(box(), { target: { value: v } });
const enter = () => fireEvent.submit(box().closest('form'));

describe('SiteMapSearch', () => {
  it('reads a unit the way the model spells it', () => {
    expect(normalizeQuery('c 21')).toBe('C021');
    expect(normalizeQuery('C-214')).toBe('C214');
    expect(normalizeQuery('b211a')).toBe('B211A');
  });

  it('matches units here by prefix and opens one on Enter', () => {
    const onPickUnit = vi.fn(() => true);
    render(<SiteMapSearch units={units} placeName="Escondido" onPickUnit={onPickUnit} />);
    type('c2');
    expect(screen.getByText('Units at Escondido')).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.querySelector('b').textContent)).toEqual(['C214', 'C215']);
    type('c-214'); enter();
    expect(onPickUnit).toHaveBeenCalledWith('C214');
    expect(box().value).toBe('');   // cleared once the unit opens
  });

  it('groups Cubby hits under Tenants and Other Facilities and hands other facilities back', async () => {
    const remoteSearch = vi.fn(async () => [
      { facilityId: 'f2', facility: 'Vista', unit: 'B102', tenant: 'Pat Other', status: 'rented' },
      { facilityId: 'f1', facility: 'Escondido', unit: 'C214', tenant: 'Pat Here', status: 'rented', here: true },
    ]);
    const onRemoteHit = vi.fn(); const onPickUnit = vi.fn(() => true);
    render(<SiteMapSearch units={units} placeName="Escondido" onPickUnit={onPickUnit} remoteSearch={remoteSearch} onRemoteHit={onRemoteHit} />);
    type('pat');
    expect(await screen.findByText('Pat Other')).toBeTruthy();
    expect(screen.getByText('Tenants and Other Facilities')).toBeTruthy();
    expect(remoteSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Pat Other'));
    expect(onRemoteHit).toHaveBeenCalledWith(expect.objectContaining({ facilityId: 'f2', unit: 'B102' }));
    type('pat');
    fireEvent.click(await screen.findByText('Pat Here'));
    expect(onPickUnit).toHaveBeenCalledWith('C214');
  });

  it('says inside the popover when a unit is not here or not on the map yet', () => {
    render(<SiteMapSearch units={units} placeName="Escondido" onPickUnit={() => false} unplaced={[{ n: 'Q001' }]} />);
    type('Z999'); enter();
    expect(screen.getByRole('status').textContent).toBe('No unit Z999 at Escondido.');
    type('q1'); enter();
    expect(screen.getByRole('status').textContent).toMatch(/Unit Q001 is here but not on the map yet/);
  });

  it('moves through the results with the arrow keys', () => {
    const onPickUnit = vi.fn(() => true);
    render(<SiteMapSearch units={units} onPickUnit={onPickUnit} />);
    type('c2');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-activedescendant')).toBeTruthy();
    enter();
    expect(onPickUnit).toHaveBeenCalledWith('C215');
  });
});
