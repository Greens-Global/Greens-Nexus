import { describe, it, expect, beforeEach } from 'vitest';
import { buildAutoTour, findFeature, clearAutoTourTags } from './autoTour';
import { DOCS } from '../support/docsContent';

// Every screen without a hand-built tour gets one built from its Help entry
// and the page as it is (Neil, Oct 14 2026). jsdom has no layout, so the
// tests give the elements a size.
const sized = (el) => { el.getBoundingClientRect = () => ({ width: 80, height: 20, top: 0, left: 0 }); return el; };
const page = (html) => {
  document.body.innerHTML = `<main>${html}</main>`;
  document.querySelectorAll('main *').forEach(sized);
  return document.querySelector('main');
};
const ENTRY = {
  name: 'Marketing', purpose: 'Leads and listings in one place.', access: 'Marketing grant',
  features: [{ name: 'Leads', desc: 'Every lead.' }, { name: 'Business Profile', desc: 'Listings.' }, { name: 'Gone Feature', desc: 'Not on the page.' }],
  walkthroughs: [{ title: 'Log a Lead' }, { title: 'Set a Goal' }],
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('auto tour', () => {
  it('opens with the purpose, walks the tabs and the features on the page, and ends with the guides', () => {
    page(`<div role="tablist"><button role="tab">Leads 12</button><button role="tab">Business Profile</button><button role="tab">Ads</button></div>
          <h2>Leads</h2>`);
    const steps = buildAutoTour(ENTRY);
    expect(steps[0]).toMatchObject({ target: null, title: 'Marketing' });
    expect(steps[0].body).toContain('Leads and listings in one place.');
    expect(steps[1].title).toBe('Where Things Are');
    expect(steps[1].body).toContain('Leads 12, Business Profile and Ads');
    // features found on the page, the missing one skipped
    expect(steps.map((s) => s.title)).toEqual(['Marketing', 'Where Things Are', 'Leads', 'Business Profile', 'Going Further']);
    expect(steps.at(-1).body).toContain('Log a Lead and Set a Goal');
    // every spotlighted step points at a real, marked element
    for (const s of steps.filter((x) => x.target)) expect(document.querySelector(`[data-tour="${s.target}"]`)).toBeTruthy();
  });

  it('prefers an exact label, and ignores hidden ones and the Help panel', () => {
    const root = page(`<div class="help-widget"><button>Leads</button></div><button id="cnt">Leads 4</button><h3 id="exact">Leads</h3>`);
    expect(findFeature(root, 'Leads').id).toBe('exact');
    document.getElementById('exact').getBoundingClientRect = () => ({ width: 0, height: 0 });
    expect(findFeature(root, 'Leads').id).toBe('cnt');
  });

  it('folds plurals, reads a card by its title, skips the header, and takes the doc\'s own label', () => {
    const root = page(`<header class="top-header"><button>Leads</button></header>
      <button id="card"><div><span>Check Out an Item</span><span>Browse available equipment</span></div></button>
      <button id="req">Purchase Request</button>`);
    expect(findFeature(root, 'Purchase Requests').id).toBe('req');
    expect(findFeature(root, ['Browse Catalog', 'Check Out an Item']).id).toBe('card');
    expect(findFeature(root, 'Leads')).toBeNull();
  });

  it('a page with none of the documented controls still gets the intro and the guides', () => {
    page('<p>Nothing here</p>');
    expect(buildAutoTour(ENTRY).map((s) => s.title)).toEqual(['Marketing', 'Going Further']);
    // with the doc's "what you get" list, the page itself is shown with it
    const steps = buildAutoTour({ ...ENTRY, gains: ['See every lead.', 'Answer reviews.'] });
    expect(steps.map((s) => s.title)).toEqual(['Marketing', 'What You Can Do Here', 'Going Further']);
    expect(steps[1].body).toBe('- See every lead.\n- Answer reviews.');
  });

  it('clears its marks, and a rebuild never doubles them', () => {
    page('<h2>Leads</h2><h2>Business Profile</h2>');
    buildAutoTour(ENTRY); buildAutoTour(ENTRY);
    expect(document.querySelectorAll('[data-tour^="auto-"]')).toHaveLength(2);
    clearAutoTourTags();
    expect(document.querySelectorAll('[data-tour^="auto-"]')).toHaveLength(0);
  });

  it('every documented module builds a tour', () => {
    page('<p></p>');
    for (const d of DOCS.filter((x) => x.view)) {
      const steps = buildAutoTour(d);
      expect(steps.length, d.id).toBeGreaterThanOrEqual(2);
      expect(steps[0].body, d.id).toBeTruthy();
    }
  });
});
