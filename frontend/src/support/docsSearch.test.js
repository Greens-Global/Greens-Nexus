import { describe, it, expect } from 'vitest';
import {
  searchDocs, suggestForTicket, resultPath, stem, words, withinOneEdit, buildSections,
  docForView, sectionDomId, walkthroughAnchor, SYNONYM_GROUPS, DOC_KEYWORDS, MIN_SCORE,
} from './docsSearch';
import { DOCS } from './docsContent';

// The help search (header "?" menu, Documentation tab, ticket Suggested
// Articles). Real employee phrasings must land on the page that answers them;
// junk must return nothing at all rather than a list of weak guesses.

const top = (q, opts) => searchDocs(q, opts).map(resultPath);

describe('text handling', () => {
  it('stems plurals, -ing and -ed to the same root', () => {
    expect(stem('requests')).toBe(stem('request'));
    expect(stem('requesting')).toBe(stem('request'));
    expect(stem('requested')).toBe(stem('request'));
    expect(stem('approving')).toBe(stem('approve'));
    expect(stem('approved')).toBe(stem('approve'));
    expect(stem('policies')).toBe(stem('policy'));
    expect(stem('punches')).toBe(stem('punch'));
    expect(stem('stopped')).toBe(stem('stop'));
    // Short words and numbers are left alone.
    expect(stem('pto')).toBe('pto');
    expect(stem('2026')).toBe('2026');
  });

  it('splits on punctuation and folds apostrophes', () => {
    expect(words("Can't log-in to Wi-Fi!")).toEqual(['cant', 'log', 'in', 'to', 'wi', 'fi']);
    expect(words('I don’t know')).toEqual(['i', 'dont', 'know']);
    expect(words('')).toEqual([]);
    expect(words(null)).toEqual([]);
  });

  it('allows exactly one typo', () => {
    expect(withinOneEdit('vacation', 'vacaton')).toBe(true);   // deletion
    expect(withinOneEdit('password', 'passwrod')).toBe(true);  // swap
    expect(withinOneEdit('laptop', 'laptap')).toBe(true);      // substitution
    expect(withinOneEdit('laptop', 'lapotp')).toBe(true);      // swap
    expect(withinOneEdit('laptop', 'labtap')).toBe(false);
    expect(withinOneEdit('time', 'timesheet')).toBe(false);
  });
});

describe('index', () => {
  it('has a section for every walkthrough, feature and tip, with its anchor', () => {
    const sections = buildSections();
    for (const d of DOCS) {
      expect(sections.some((s) => s.docId === d.id && s.kind === 'module')).toBe(true);
      for (const w of d.walkthroughs) {
        const s = sections.find((x) => x.docId === d.id && x.kind === 'walkthrough' && x.title === w.title);
        expect(s, `${d.id} > ${w.title}`).toBeTruthy();
        expect(s.anchor).toBe(walkthroughAnchor(w.title));
        expect(s.body).toEqual(w.steps);
      }
      expect(sections.filter((x) => x.docId === d.id && x.kind === 'feature')).toHaveLength(d.features.length);
      expect(sections.filter((x) => x.docId === d.id && x.kind === 'tip')).toHaveLength((d.tips || []).length);
    }
  });

  it('indexes new and changed content with no extra work', () => {
    const docs = [{
      id: 'parking', name: 'Parking', group: 'Modules', tagline: 'Book a space in the garage.',
      purpose: 'Reserve parking.', gains: [], walkthroughs: [{ title: 'Book a Space', steps: ['Open Parking.', 'Pick a spot.'] }],
      features: [{ name: 'Visitor Passes', desc: 'Print a pass for a guest.' }], tips: [],
    }];
    expect(searchDocs('book a space', { docs }).map((r) => r.title)).toContain('Book a Space');
    expect(searchDocs('visitor pass', { docs })[0].title).toBe('Visitor Passes');
  });

  it('keeps DOC_KEYWORDS and synonyms pointed at real pages, in American English', () => {
    const ids = new Set(DOCS.map((d) => d.id));
    Object.keys(DOC_KEYWORDS).forEach((id) => expect(ids.has(id), id).toBe(true));
    const all = JSON.stringify([SYNONYM_GROUPS, DOC_KEYWORDS]);
    expect(all).not.toMatch(/colour|behaviour|organis|licence|cancelled/);
    expect(all).not.toMatch(/\u2014/);
  });

  it('gives section ids SupportDocs can scroll to', () => {
    expect(sectionDomId('workday')).toBe('doc-workday');
    expect(sectionDomId('workday', walkthroughAnchor('Request Time Off'))).toBe('doc-workday--w-request-time-off');
  });

  it('maps a view id to its guide page', () => {
    expect(docForView('myhr').id).toBe('workday');
    expect(docForView('inventory').id).toBe('item-management');
    expect(docForView('nope')).toBeNull();
    expect(docForView(undefined)).toBeNull();
  });
});

describe('real questions land on the right answer', () => {
  it('"how do i request pto" -> Workday > Request Time Off', () => {
    expect(top('how do i request pto')[0]).toBe('Workday > Request Time Off');
  });

  it('"my laptop is broken" -> Item Management', () => {
    expect(top('my laptop is broken')[0]).toBe('Item Management');
  });

  it('"forgot to clock out" -> Workday', () => {
    const r = searchDocs('forgot to clock out');
    expect(r[0].docId).toBe('workday');
  });

  it('"cant log in" -> Getting Started (sign in with your work account)', () => {
    expect(top('cant log in')[0]).toBe('Getting Started');
  });

  it('a typo still finds it', () => {
    expect(searchDocs('vacaton ')[0].docId).toBe('workday');
    expect(searchDocs('pasword reset ')[0].docId).toBe('credential-vault');
  });

  it('matches the word still being typed', () => {
    expect(searchDocs('punc').map((r) => r.docId)).toContain('workday');
    expect(top('request time')[0]).toBe('Workday > Request Time Off');
  });

  it('finds walkthroughs and tips, not just modules', () => {
    expect(top('add a new employee')[0]).toBe('People > Add a New Employee');
    expect(top('how to approve leave')[0]).toBe('People > Approve Leave');
    expect(top('report a bug')[0]).toBe('Support > Report a Bug in Nexus');
    expect(top('how do i change my photo')[0]).toBe('Getting Started > Set Up Your Profile');
    expect(top('my punch did not record')[0]).toBe('Workday > Good To Know');
    expect(top('cant see a module')[0]).toBe('Getting Started > Good To Know');
  });

  it('understands company words the guide does not use', () => {
    expect(searchDocs('wifi')[0].docId).toBe('it');
    expect(searchDocs('where do i find the handbook')[0].docId).toBe('knowledge-base');
    expect(searchDocs('i am sick today')[0].docId).toBe('workday');
    expect(searchDocs('extend my checkout')[0].docId).toBe('item-management');
  });

  it('only returns pages the person can open', () => {
    const allow = (id) => id !== 'people';
    expect(searchDocs('add a new employee', { allow }).every((r) => r.docId !== 'people')).toBe(true);
  });

  it('every result clears the relevance floor', () => {
    for (const q of ['how do i request pto', 'wifi', 'tickets', 'time']) {
      searchDocs(q).forEach((r) => expect(r.score).toBeGreaterThanOrEqual(MIN_SCORE));
    }
  });
});

describe('junk returns nothing', () => {
  it.each([
    'asdf qwerty', 'banana smoothie recipe', 'hello', 'the', 'how to', 'xyz', 'pizza',
    'lorem ipsum dolor sit amet', 'weather forecast', 'screen is blank', 'printer jammed', '', '   ', '???',
  ])('%s', (q) => {
    expect(searchDocs(q)).toEqual([]);
  });
});

describe('speed', () => {
  it('answers in well under a few milliseconds once built', () => {
    searchDocs('warm up');
    const qs = ['how do i request pto', 'my laptop is broken', 'forgot to clock out', 'cant log in', 'vacaton', 'asdf qwerty'];
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) qs.forEach((q) => searchDocs(q));
    const per = (performance.now() - t0) / (20 * qs.length);
    expect(per).toBeLessThan(5);
  });
});

describe('ticket suggestions', () => {
  const titles = (s, d) => suggestForTicket(s, d).map(resultPath);

  it('suggests articles for a matching ticket', () => {
    expect(titles('Forgot to punch out yesterday', 'I left at 5pm but forgot to clock out')[0]).toBe('Workday');
    expect(titles('Need PTO next week', '')).toContain('Workday > Request Time Off');
    expect(titles('Need access to Accounting module', '')).toContain('Settings > Give Someone Access to a Module');
    expect(titles('Laptop screen cracked', 'It will not turn on')[0]).toBe('Item Management');
  });

  it('suggests nothing for junk, or for too little text', () => {
    expect(suggestForTicket('asdf', 'lorem ipsum dolor')).toEqual([]);
    expect(suggestForTicket('Printer jammed on 3rd floor', '')).toEqual([]);
    expect(suggestForTicket('hi', '')).toEqual([]);
    expect(suggestForTicket('', '')).toEqual([]);
  });

  it('never suggests raising a ticket to someone raising one', () => {
    for (const s of ['submit a ticket', 'follow up on my ticket', 'help desk issue']) {
      suggestForTicket(s, '').forEach((r) => {
        expect(r.docId === 'support' && /\btickets?\b/i.test(r.title)).toBe(false);
        expect(r.docId === 'tickets' && r.kind === 'module').toBe(false);
      });
    }
  });

  it('returns at most three', () => {
    expect(suggestForTicket('laptop monitor password vpn time off', 'wifi paystub sick vacation').length).toBeLessThanOrEqual(3);
  });
});
