import { describe, it, expect } from 'vitest';
import { codesFor } from './KeyTips';

// Word's KeyTips (11/11/2026): one letter where it is unique, two where
// buttons share a first letter, and never a code that starts another.
describe('KeyTips codes', () => {
  it('gives unique first letters alone and shared ones two letters', () => {
    const codes = codesFor(['Page Break', 'Blank Page', 'Picture', 'Table', 'Text Box', 'Signature', 'Shapes']);
    expect(codes[1]).toBe('B');
    expect(codes[3]).toBe('TA');
    expect(codes[4]).toBe('TB');
    expect(new Set(codes).size).toBe(codes.length);
    for (const a of codes) for (const b of codes) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });
});
