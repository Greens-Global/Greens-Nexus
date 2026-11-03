import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { qrPayload, matrixPath, createQrMaker } from './qr';

// Items phase 4: a tag's QR code is the item's own link on the app origin,
// built in the browser by the self-hosted qrcode package. The round trip
// below draws the code we would print and reads it back with jsqr - the
// same decoder an iPhone uses - so a tag that will not scan fails here.

const ORIGIN = 'https://nexus.example.com';

// Paint the module path the way the tag's SVG does, then hand the pixels to jsqr.
function decodePath({ size, path }, scale = 6, quiet = 4) {
  const dim = (size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(dim * dim * 4).fill(255);
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  let m;
  while ((m = re.exec(path))) {
    const x0 = Number(m[1]), y = Number(m[2]), run = Number(m[3]);
    for (let x = x0; x < x0 + run; x++) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          px[o] = 0; px[o + 1] = 0; px[o + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, dim, dim)?.data || '';
}

describe('the QR payload', () => {
  it('is the item link on the given origin - no token in it', () => {
    expect(qrPayload('it-42', ORIGIN)).toBe('https://nexus.example.com/itemmanagement/item/it-42');
    expect(qrPayload('it-42', ORIGIN)).not.toMatch(/[?#]/);
  });

  it('draws dark modules as runs', () => {
    const grid = [[1, 1, 0], [0, 1, 0], [1, 0, 1]];
    expect(matrixPath(3, (r, c) => grid[r][c] === 1)).toBe('M0 0h2v1h-2zM1 1h1v1h-1zM0 2h1v1h-1zM2 2h1v1h-1z');
  });

  it('prints a code that scans back to the same link', async () => {
    const make = await createQrMaker();
    const link = qrPayload('3f0c2d64-9a0e-4c1b-8d1f-2b7f0a9e1c55', ORIGIN);
    const qr = make(link);
    expect(qr.size).toBeGreaterThan(20);
    expect(decodePath(qr)).toBe(link);
  });

  it('loads the library through the given loader only', async () => {
    let loads = 0;
    const real = await import('qrcode');
    const make = await createQrMaker({ load: async () => { loads += 1; return real.default || real; } });
    make('a'); make('b');
    expect(loads).toBe(1);
  });
});
