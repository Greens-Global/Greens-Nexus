import { describe, it, expect } from 'vitest';
import { apnSet, matchSiteModel } from './SiteModelSection.jsx';

// The site models' APNs (backend/site_models/*.json) against the Asset
// Management properties as they are written on prod (Oct 20).
const MODELS = [
  { id: 'greens-storage-austin', name: 'Greens Storage Austin', apn: 'R569024' },
  { id: 'greens-storage-escondido', name: 'Greens Storage Escondido', apn: '187-170-63-00' },
  { id: 'greens-storage-fairfield', name: 'Greens Storage Fairfield', apn: '0166-080-040, 0166-080-030' },
  { id: 'greens-storage-temecula', name: 'Greens Storage Temecula', apn: '918-200-025, 918-200-027' },
  { id: 'greens-storage-valley-center', name: 'Greens Storage Valley Center', apn: '188-250-45-00' },
];
const m = (p) => matchSiteModel(MODELS, p)?.id || null;

describe('matchSiteModel', () => {
  it('reads APN lists and shorthand', () => {
    expect([...apnSet('0166-080-030 & 040')]).toEqual(['0166080030', '0166080040']);
    expect([...apnSet('918-200-025, 027')]).toEqual(['918200025', '918200027']);
  });
  it('links Fairfield (East) through its shorthand APN', () => {
    expect(m({ id: 'greens-fairfield', name: 'Greens Storage, Fairfield (East)', apn: '0166-080-030 & 040' })).toBe('greens-storage-fairfield');
  });
  it('still links the others and leaves unrelated parcels alone', () => {
    expect(m({ id: 'greens-rainbow', name: 'Greens Storage, Temecula', apn: '918-200-025, 027' })).toBe('greens-storage-temecula');
    expect(m({ id: 'greens-escondido-south', name: 'Greens Storage, Escondido (South)', apn: '187-170-63-00' })).toBe('greens-storage-escondido');
    expect(m({ id: 'greens-austin', name: 'Greens Storage, Austin', apn: '' })).toBe('greens-storage-austin');
    expect(m({ id: 'greens-escondido-north', name: 'Greens Storage, Escondido (North)', apn: '187-170-64 & 62' })).toBeNull();
    expect(m({ id: 'xvvshoso', name: 'Greens Storage, Fairfield (West)', apn: '' })).toBeNull();
    expect(m({ id: 'valley-center-east', name: 'Greens Storage, Valley Center (East)', apn: '188-250-13-00' })).toBeNull();
  });
});
