// A guided tour for every screen that has no hand-built one (Neil, Oct 14
// 2026: "build tours for the other pages that are missing them and
// dynamically update them as needed").
//
// Nothing here is written per screen. When the tour starts it is built from
// two things that are always current:
//   - the screen's Help entry (support/docsContent.js): its name, purpose,
//     features and how-to titles - the same words the Help panel shows, so
//     a doc edit is a tour edit;
//   - the page as it is right now: a feature is spotlighted only if the
//     control it names is on screen (a tab, a heading, a button), and the
//     tab strip is read off the page.
// So a renamed or removed control drops out of the tour by itself, and a
// new documented feature joins it as soon as it is on the page.

const MAX_FEATURE_STEPS = 7;
const TAG = 'data-tour';
const PREFIX = 'auto-';

// Lower case, '&' as 'and', punctuation gone, plurals folded ("Requests"
// matches "Request") - doc names and screen labels drift in small ways.
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
const visible = (el) => {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  return !cs || (cs.visibility !== 'hidden' && cs.display !== 'none');
};
// The element's own words (a button's label, a tab's name) - not a whole
// card's text, so "Leads" matches the Leads tab, not a paragraph mentioning leads.
const ownText = (el) => norm(el.getAttribute('aria-label') || el.textContent).slice(0, 80);
// A card's title: its first line of text ("Check Out an Item" over the
// card's description).
const titleText = (el) => {
  // Down through single wrappers to the first of several text blocks.
  let n = el;
  for (let d = 0; d < 5; d += 1) {
    const kids = [...n.children].filter((c) => (c.textContent || '').trim());
    if (!kids.length) return '';
    if (kids.length > 1) return norm(kids[0].textContent).slice(0, 60);
    n = kids[0];
  }
  return '';
};
// Never the app's own frame: the header, the Help panel, an open dialog.
const FRAME = '.top-header, header, [data-auto-tour-skip], .help-widget, [role="dialog"], .sbclock, .sbclock-rail';

const CANDIDATES = 'h1, h2, h3, h4, [role="tab"], [role="button"], button, a, .scroll-tabs > *, label, summary, th';

/** The element on the page a documented feature names, or null. `names`
 *  is the feature's name, or its Help entry's `tour` labels when the screen
 *  words it differently. */
export function findFeature(root, names) {
  const wants = (Array.isArray(names) ? names : [names]).map(norm).filter(Boolean);
  if (!wants.length || !root) return null;
  let best = null;
  for (const el of root.querySelectorAll(CANDIDATES)) {
    if (el.closest(FRAME)) continue;
    const t = ownText(el);
    if (!t) continue;
    const head = titleText(el);
    let score = 0;
    for (const want of wants) {
      // Exact; a card whose title is the name; a label that starts with it
      // ("Leads 12", which tabs with counts carry); a short label holding
      // every word of it.
      const s1 = t === want ? 4 : head === want ? 3 : t.startsWith(`${want} `) ? 2
        : (t.length <= 40 && want.split(' ').every((w) => ` ${t} `.includes(` ${w} `)) ? 1 : 0);
      score = Math.max(score, s1);
    }
    if (score && visible(el) && (!best || score > best.score)) best = { el, score };
    if (best?.score === 4) break;
  }
  return best?.el || null;
}

/** The screen's tab strip, if it has one: { el, labels }. */
function findTabs(root) {
  const strips = [...root.querySelectorAll('[role="tablist"], .scroll-tabs, .nx-module-tabs')].filter((el) => visible(el) && !el.closest(FRAME));
  for (const el of strips) {
    const labels = [...el.querySelectorAll('[role="tab"], button, a')].filter(visible)
      .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean);
    if (labels.length >= 2) return { el, labels: [...new Set(labels)].slice(0, 8) };
  }
  return null;
}

/** Remove the spotlight marks a previous auto tour left. */
export function clearAutoTourTags(doc = document) {
  doc.querySelectorAll(`[${TAG}^="${PREFIX}"]`).forEach((el) => el.removeAttribute(TAG));
}

const listText = (items) => (items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * GuidedTour steps for `entry` (a Help doc), from the page under `root`.
 * Marks the spotlighted elements with data-tour="auto-N" (cleared first).
 */
export function buildAutoTour(entry, root = document.querySelector('main') || document.body) {
  if (!entry) return [];
  clearAutoTourTags(root.ownerDocument || document);
  let n = 0;
  const mark = (el) => { const key = `${PREFIX}${n += 1}`; el.setAttribute(TAG, key); return key; };
  const steps = [{
    target: null,
    title: entry.name,
    body: [entry.purpose || entry.tagline, entry.access ? `Who can use it: ${entry.access}` : ''].filter(Boolean).join('\n\n'),
  }];

  const tabs = findTabs(root);
  if (tabs) {
    steps.push({
      target: mark(tabs.el),
      title: 'Where Things Are',
      body: `${entry.name} is split into ${listText(tabs.labels)}. Pick one to switch; your place is kept as you move around.`,
    });
  }

  const seen = new Set(tabs ? [tabs.el] : []);
  for (const f of entry.features || []) {
    if (steps.length - 1 - (tabs ? 1 : 0) >= MAX_FEATURE_STEPS) break;
    const el = findFeature(root, f.tour || f.name);
    if (!el || seen.has(el)) continue;
    seen.add(el);
    steps.push({ target: mark(el), title: f.name, body: f.desc });
  }

  // Too little of the page could be named: what the module is for, over
  // the page itself, so every tour shows the person something.
  if (steps.length <= 2 && (entry.gains || []).length) {
    const area = [...root.children].find((c) => visible(c) && !c.matches(FRAME) && !c.querySelector('.top-header'))
      || [...root.querySelectorAll(':scope > * > *')].find((c) => visible(c) && !c.closest(FRAME));
    steps.push({ target: area ? mark(area) : null, title: 'What You Can Do Here', body: entry.gains.slice(0, 4).map((g) => `- ${g}`).join('\n') });
  }

  const how = (entry.walkthroughs || []).map((w) => w.title).filter(Boolean).slice(0, 4);
  steps.push({
    target: null,
    title: 'Going Further',
    body: how.length
      ? `Step-by-step guides for ${entry.name}: ${listText(how)}. Open Help (the ? at the top) and choose Help with This Page.`
      : `Open Help (the ? at the top) and choose Help with This Page for the full guide to ${entry.name}.`,
  });
  return steps;
}
