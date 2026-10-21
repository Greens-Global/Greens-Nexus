import { describe, it, expect } from 'vitest';
import { assetSub, parseAssetSub } from './navigation.js';

describe('asset deep links', () => {
  it('round-trips id and view in one segment', () => {
    expect(assetSub('x1a2b3c', 'maintenance')).toBe('a:x1a2b3c:maintenance');
    expect(parseAssetSub('a:x1a2b3c:maintenance')).toEqual({ id: 'x1a2b3c', view: 'maintenance', item: '' });
    expect(parseAssetSub('a:x1a2b3c')).toEqual({ id: 'x1a2b3c', view: 'property', item: '' });
    expect(parseAssetSub('a:x1a2b3c:inspections:r%3A9')).toEqual({ id: 'x1a2b3c', view: 'inspections', item: 'r:9' });
  });
  it('encodes ids the shell could not carry as one segment', () => {
    const sub = assetSub('GS Escondido/South', 'records');
    expect(sub).not.toContain('/');
    expect(parseAssetSub(sub)).toEqual({ id: 'GS Escondido/South', view: 'records', item: '' });
  });
  it('is null for the portfolio and for ticket subs', () => {
    expect(assetSub(null, 'property')).toBeNull();
    expect(parseAssetSub('tickets:x1:t9')).toBeNull();
    expect(parseAssetSub(null)).toBeNull();
  });
});
