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
