import { describe, it, expect } from 'vitest';
import { splitAddress, VNORM } from './dataNormalization.js';

describe('splitAddress', () => {
  it('peels a doubled city / state / zip tail off the street line', () => {
    const r = splitAddress({ address: '25260 N Centre City Parkway, Escondido, CA 92026, Escondido, CA, 92026', city: 'Escondido', state: 'CA', zip: '92026' });
    expect(r.address).toBe('25260 N Centre City Parkway');
    expect([r.city, r.state, r.zip]).toEqual(['Escondido', 'CA', '92026']);
  });
  it('fills empty city / state / zip from the tail', () => {
    const r = splitAddress({ address: '918 S El Camino Real, San Clemente, CA 92672', city: '', state: '', zip: '' });
    expect(r).toMatchObject({ address: '918 S El Camino Real', city: 'San Clemente', state: 'CA', zip: '92672' });
  });
  it('keeps a county segment and "City of" city', () => {
    const r = splitAddress({ address: 'North Center City Northway North, County of San Diego, CA 92026, Escondido, CA, 92026', city: 'Escondido', state: 'CA', zip: '92026', county: '' });
    expect(r.address).toBe('North Center City Northway North');
    expect(r.county).toBe('San Diego');
    const f = splitAddress({ address: '5044 Peabody Road, City of Fairfield, CA, 94533', city: 'City of Fairfield', state: 'CA', zip: '94533' });
    expect(f.address).toBe('5044 Peabody Road');
  });
  it('mends a comma after the house number', () => {
    expect(splitAddress({ address: '11318, Highway 67, Lakeside, CA, 92040', city: 'Lakeside', state: 'CA', zip: '92040' }).address).toBe('11318 Highway 67');
  });
  it('leaves a city-only or foreign address alone and returns the same row', () => {
    const a = { address: 'Hyderabad, India', city: '', state: '', zip: '' };
    expect(splitAddress(a)).toBe(a);
    const b = { address: '123 Main St', city: 'Austin', state: 'TX', zip: '78729' };
    expect(splitAddress(b)).toBe(b);
  });
  it('keeps street quadrants, country codes, unit lines and a street named like its city', () => {
    expect(splitAddress({ address: '1600 Pennsylvania Ave, NW', city: '', state: '', zip: '' })).toMatchObject({ address: '1600 Pennsylvania Ave, NW', state: '' });
    expect(splitAddress({ address: '123 Main St, Austin, TX 78701, US', city: '', state: '', zip: '' })).toMatchObject({ address: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' });
    const uk = { address: '10 Downing St, London, UK', city: '', state: '', zip: '' };
    expect(splitAddress(uk)).toBe(uk);
    const india = { address: 'MG Road, Bengaluru, Karnataka, IN', city: '', state: '', zip: '', country: 'India' };
    expect(splitAddress(india)).toBe(india);
    expect(splitAddress({ address: '123 Main St, Building C, TX 78701', city: '', state: '', zip: '' })).toMatchObject({ address: '123 Main St, Building C', city: '' });
    expect(splitAddress({ address: 'Escondido, Escondido, CA 92026', city: 'Escondido', state: 'CA', zip: '92026' }).address).toBe('Escondido');
    expect(splitAddress({ address: '1 Oak St, San Diego County, CA 92026', city: '', state: '', zip: '' })).toMatchObject({ address: '1 Oak St', county: 'San Diego' });
  });
  it('a plain "City, ST" line with no city on the row fills the city', () => {
    expect(splitAddress({ address: 'Escondido, CA', city: '', state: '', zip: '' })).toMatchObject({ address: '', city: 'Escondido', state: 'CA' });
  });
  it('a city-only address with the city known becomes an empty street line', () => {
    expect(splitAddress({ address: 'Chicago, IL', city: 'Chicago', state: 'IL', zip: '' }).address).toBe('');
  });
  it('VNORM applies it to every property and is idempotent', () => {
    const s = { properties: [{ id: 'a', address: '8023 West Parmer Lane, Austin, TX, 78729', city: 'Austin', state: 'TX', zip: '78729' }] };
    const n = VNORM(s);
    expect(n.properties[0].address).toBe('8023 West Parmer Lane');
    expect(VNORM(n)).toBe(n);
  });
});
