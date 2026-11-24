import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import esign from './ESign.jsx?raw';
import toReview from './TimesheetsToReview.jsx?raw';
import reviewPanel from './TimesheetReviewPanel.jsx?raw';

// EVERY file that hosts the signing screen, not a list kept by hand: on
// 11/23/2026 the Workday door (DocumentsToSign - where the signing email and
// the bell land) still opened the pad behind it; only the two Time Sheet
// doors had been fixed and tested.
const SRC = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(path.join(dir, e.name))
    : e.name.endsWith('.jsx') && !e.name.endsWith('.test.jsx') ? [path.join(dir, e.name)] : []));
const hosts = walk(SRC).map((f) => [f.split(path.sep).join('/'), fs.readFileSync(f, 'utf8')])
  .filter(([, src]) => /<SignModal\b/.test(src) && /zIndex:\s*\d+/.test(src))
  // A host in a fixed layer of its own (ESign's inbox shows it in place).
  .filter(([, src]) => hostedLayers(src).length > 0);

// Miranda, 11/04/2026: "I clicked sign on my timesheet ... I'm trying to click
// sign and nothing is happening." Workday shows the signing screen in its own
// full-page layer (z 4000); the signature pad opened at z 1400 - BEHIND it.
// Any host that puts SignModal in a fixed layer must pass a `layer` that lifts
// the pad (1400 + layer) and the other popups above that layer.

const PAD_BASE = 1400;

function hostedLayers(src) {
  // Every `zIndex: N` wrapper followed (within a few lines) by <SignModal ...>.
  const out = [];
  const re = /zIndex:\s*(\d+)[^\n]*\n(?:[^\n]*\n){0,2}?[^\n]*<SignModal([^>]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const layer = /layer=\{(\d+)\}/.exec(m[2]);
    out.push({ host: Number(m[1]), layer: layer ? Number(layer[1]) : 0 });
  }
  return out;
}

describe('the signing screen inside a high layer', () => {
  it.each([['TimesheetsToReview', toReview], ['TimesheetReviewPanel', reviewPanel]])(
    '%s lifts the signature pad above its own layer', (_name, src) => {
      const hosts = hostedLayers(src);
      expect(hosts.length).toBeGreaterThan(0);
      for (const { host, layer } of hosts) expect(PAD_BASE + layer).toBeGreaterThan(host);
    });

  it('finds the hosts it guards', () => {
    const names = hosts.map(([p]) => p.split('/').pop());
    for (const n of ['DocumentsToSign.jsx', 'TimesheetsToReview.jsx', 'TimesheetReviewPanel.jsx', 'HiringPacket.jsx']) {
      expect(names).toContain(n);
    }
  });

  it.each(hosts.map(([p, src]) => [p.split('/').pop(), src]))(
    '%s lifts the signature pad above its own fixed layer', (_name, src) => {
      const found = hostedLayers(src);
      expect(found.length).toBeGreaterThan(0);
      for (const { host, layer } of found) expect(PAD_BASE + layer).toBeGreaterThan(host);
    });

  it('the missed-break report opens above the signing screen too', () => {
    expect(esign).toMatch(/<BreakAttestModal[^>]*zIndex=\{layer \? 1400 \+ layer : undefined\}/);
  });

  it('SigningDoc applies the layer to the pad and every popup it opens', () => {
    expect(esign).toMatch(/<SignaturePad[^>]*zIndex=\{1400 \+ layer\}/);
    expect(esign).toMatch(/<HistoryPanel[^>]*zIndex=\{1450 \+ layer\}/);
    const unlifted = esign.match(/<Modal zIndex=\{14\d\d\}/g) || [];
    // Only HistoryPanel's own default sits at 1450 as a literal; the signing
    // popups (paper, decline) must all carry the layer.
    expect(unlifted.filter(s => !s.includes('1450'))).toEqual([]);
    expect(esign).toMatch(/fieldError=\{fieldError\} layer=\{layer\}/);
  });
});
