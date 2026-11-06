import { describe, it, expect } from 'vitest';
import { canonicalStage, VNORM } from './dataNormalization.js';

// 11/05/2026 flat sweep: a compound stage is joined with a plain hyphen (the
// form's spelling) - the tiles printed the em dash as is.
describe('canonicalStage', () => {
  it('turns an em or en dash joiner into " - "', () => {
    expect(canonicalStage('Stabilized \u2014 Renovation')).toBe('Stabilized - Renovation');
    expect(canonicalStage('Stabilized\u2013Expansion')).toBe('Stabilized - Expansion');
    expect(canonicalStage('Stabilized - Renovation')).toBe('Stabilized - Renovation');
    expect(canonicalStage(undefined)).toBe(undefined);
  });

  it('VNORM fixes the stage and leaves a clean workspace untouched', () => {
    const clean = { properties: [{ id: 'a', devStage: 'Stabilized' }] };
    expect(VNORM(clean)).toBe(clean);
    const out = VNORM({ properties: [{ id: 'b', devStage: 'Stabilized \u2014 Renovation' }] });
    expect(out.properties[0].devStage).toBe('Stabilized - Renovation');
  });
});
