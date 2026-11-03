import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TileCard } from './TileCard.jsx';

// The fleet face of the portfolio tile (Neil, 11/02/2026): vehicles and equipment.
const recent = new Date(Date.now() - 5 * 60e3).toISOString();

const van = {
  id: 'v1', kind: 'vehicle', assetType: 'Vehicle', name: 'Ford Transit 250', plate: 'KLM 4821',
  devStage: 'In Service', manager: 'Ana Ruiz', odometer: '11880', address: 'Austin, TX', _rev: recent,
};
const vanStore = {
  vservice: [{ propertyId: 'v1', date: '2026-08-01', type: 'Oil Change', mileage: '8000', nextMileage: '13000' }],
  odometer: [], logs: [],
};
const loader = {
  id: 'e1', kind: 'equipment', assetType: 'Heavy Equipment', name: 'Bobcat S650 Loader', serialNumber: 'B3N8 11402',
  devStage: 'In Repair', hours: '1204', address: 'Georgetown, TX',
};

describe('TileCard fleet face', () => {
  it('renders a vehicle card: plate, status, driver, updated, the miles track and facts', () => {
    const open = vi.fn();
    const { container } = render(<TileCard pr={van} openProperty={open} store={vanStore} />);
    expect(screen.getByRole('heading', { name: 'Ford Transit 250' })).toBeTruthy();
    expect(screen.getByText('KLM 4821')).toBeTruthy();
    expect(screen.getByText('In Service')).toBeTruthy();
    expect(screen.getByText('Ana Ruiz')).toBeTruthy();
    expect(screen.getByText('AR')).toBeTruthy();
    expect(screen.getByText('Updated 5 min ago')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuetext')).toBe('1,120 mi to next service');
    expect(container.querySelector('.nx-track').className).toContain('is-live');
    expect(screen.getByText('11,880 mi')).toBeTruthy();
    expect(container.querySelector('.fleet-sil[data-kind="vehicle"]')).toBeTruthy();
    // No property tile pieces on the fleet face.
    expect(screen.queryByText('Owner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Ford Transit 250' }));
    expect(open).toHaveBeenCalledWith('v1');
  });

  it('turns the track red once the service is past due', () => {
    const { container } = render(<TileCard pr={{ ...van, odometer: '13410' }} openProperty={() => {}} store={vanStore} />);
    expect(container.querySelector('.nx-track').className).toContain('is-overdue');
    expect(screen.getByText('410 mi past due')).toBeTruthy();
  });

  it('renders an equipment card: serial, slate status, hours, no track without service data', () => {
    const { container } = render(<TileCard pr={loader} openProperty={() => {}} store={{ vservice: [], logs: [] }} />);
    expect(screen.getByText('Serial B3N8 11402')).toBeTruthy();
    expect(screen.getByText('In Repair')).toBeTruthy();
    expect(screen.getByText('1,204 hrs')).toBeTruthy();
    expect(screen.getByText('Georgetown, TX')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.querySelector('.fleet-sil[data-kind="equipment"]')).toBeTruthy();
    // Nobody assigned and no change stamp: no person row at all.
    expect(container.querySelector('.fleet-who')).toBeNull();
  });

  it('shows the photo when there is one', () => {
    const { container } = render(<TileCard pr={{ ...loader, images: ['https://x.supabase.co/storage/v1/object/public/asset-files/a.jpg'] }} openProperty={() => {}} store={{}} />);
    expect(container.querySelector('.fleet-photo img').getAttribute('src')).toContain('asset-files/a.jpg');
    expect(container.querySelector('.fleet-sil')).toBeNull();
  });

  it('outlines the selected card and marks it current', () => {
    const { container } = render(<TileCard pr={loader} openProperty={() => {}} store={{}} selected />);
    const card = container.querySelector('.fleet-card');
    expect(card.className).toContain('is-selected');
    expect(card.getAttribute('aria-current')).toBe('true');
  });

  it('keeps the property tile for a property', () => {
    const { container } = render(<TileCard pr={{ id: 'p1', name: 'Greens Austin', devStage: 'Stabilized', entity: 'Greens LLC' }} openProperty={() => {}} store={{}} selected />);
    expect(container.querySelector('.fleet-card')).toBeNull();
    expect(screen.getByText('Owner')).toBeTruthy();
  });
});
