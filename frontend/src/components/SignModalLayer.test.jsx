import { describe, it, expect } from 'vitest';
import esign from './ESign.jsx?raw';
import toReview from './TimesheetsToReview.jsx?raw';
import reviewPanel from './TimesheetReviewPanel.jsx?raw';

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
