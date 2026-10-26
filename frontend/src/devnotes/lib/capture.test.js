import { describe, it, expect, beforeEach } from 'vitest';
import { selectorFor, textOf, headingsFor, sourceOf, describeTarget, isOwn, commonAncestor } from './capture';

// What a pin records about its element: a selector that finds it again, its
// text, the headings above it and (dev builds) the JSX source location.

beforeEach(() => {
  document.body.innerHTML = `
    <header><div class="breadcrumb"><span class="breadcrumb-current">Tasks</span></div>
      <nav><button class="hdr-tab active"><span>Home</span></button></nav></header>
    <main>
      <section class="tasks-home" data-nx-src="src/tasks/Home.jsx:40:5">
        <h2>Updates</h2>
        <div class="list">
          <button class="secondary-btn is-active" data-nx-src="src/tasks/Home.jsx:142:11">Mark  All\n Read</button>
          <button class="secondary-btn">Other</button>
        </div>
        <div class="other"><input aria-label="Search tasks" placeholder="Search" /></div>
      </section>
      <div data-nx-devnotes="1"><button class="bm-tool">Pin</button></div>
    </main>`;
});

describe('capture', () => {
  it('selectorFor finds exactly that element again and skips state classes', () => {
    const el = document.querySelector('.secondary-btn');
    const sel = selectorFor(el);
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(el);
    expect(sel).not.toContain('is-active');
    expect(sel).toContain(':nth-of-type(1)');
    const second = document.querySelectorAll('.secondary-btn')[1];
    expect(document.querySelector(selectorFor(second))).toBe(second);
  });

  it('textOf collapses whitespace and reads a field by its label', () => {
    expect(textOf(document.querySelector('.secondary-btn'))).toBe('Mark All Read');
    expect(textOf(document.querySelector('input'))).toBe('Search');
    expect(textOf(document.querySelector('.secondary-btn'), 4)).toBe('Mark');
  });

  it('textOf never ships what is typed in a field, and masks a sensitive one', () => {
    document.querySelector('.other').innerHTML = `
      <input id="q" placeholder="Search tasks" value="payroll june" />
      <label for="ssn">Social Security Number</label><input id="ssn" value="123-45-6789" />
      <input type="password" placeholder="Password" value="hunter2" />
      <input name="routing_number" aria-label="Routing" value="021000021" />
      <input autocomplete="cc-number" value="4111111111111111" />
      <input data-sensitive aria-label="Note" value="private" />
      <textarea aria-label="Comment">typed text</textarea>`;
    expect(textOf(document.querySelector('#q'))).toBe('Search tasks');
    expect(textOf(document.querySelector('#ssn'))).toBe('***');
    expect(textOf(document.querySelector('[type="password"]'))).toBe('***');
    expect(textOf(document.querySelector('[name="routing_number"]'))).toBe('***');
    expect(textOf(document.querySelector('[autocomplete="cc-number"]'))).toBe('***');
    expect(textOf(document.querySelector('[data-sensitive]'))).toBe('***');
    expect(textOf(document.querySelector('textarea'))).toBe('Comment');
    const t = describeTarget(document.querySelector('[type="password"]'));
    expect(t.text).toBe('***');
    expect(JSON.stringify(t)).not.toContain('hunter2');
  });

  it('headingsFor goes page title, module tab, then the containers\' headings', () => {
    expect(headingsFor(document.querySelector('.secondary-btn'))).toEqual(['Tasks', 'Home', 'Updates']);
  });

  it('headingsFor never takes a sibling card\'s heading - only ancestors and their header rows', () => {
    document.querySelector('main').innerHTML = `
      <div class="grid">
        <section class="card"><div class="card-head"><h2>Updates</h2><button>Mark All Read</button></div><ul><li>one</li><li>two</li><li>three long update lines here</li></ul></section>
        <section class="card"><div class="card-head"><h2>Bookmarks</h2><span>3</span></div><ul><li><a id="bm">Payroll calendar</a></li></ul></section>
      </div>`;
    expect(headingsFor(document.querySelector('#bm'))).toEqual(['Tasks', 'Home', 'Bookmarks']);
    expect(headingsFor(document.querySelectorAll('h2')[1])).toEqual(['Tasks', 'Home', 'Bookmarks']);   // the heading itself
  });

  it('sourceOf reads the nearest data-nx-src stamp', () => {
    expect(sourceOf(document.querySelector('.secondary-btn'))).toEqual({ file: 'src/tasks/Home.jsx', line: 142, col: 11, self: true });
    expect(sourceOf(document.querySelector('input'))).toEqual({ file: 'src/tasks/Home.jsx', line: 40, col: 5, self: false });
    document.querySelector('section').removeAttribute('data-nx-src');
    expect(sourceOf(document.querySelector('input'))).toBeNull();
  });

  it('describeTarget assembles the block the contract names', () => {
    const t = describeTarget(document.querySelector('.secondary-btn'));
    expect(t.tag).toBe('button');
    expect(t.text).toBe('Mark All Read');
    expect(t.classes).toEqual(['secondary-btn', 'is-active']);
    expect(t.mode).toBe('element');
    expect(t.breadcrumb).toBe('Tasks > Home');
    expect(t.html.startsWith('<button')).toBe(true);
    expect(t.components).toEqual([]);                       // no React fiber on a plain DOM node
    expect(t.record).toEqual({ ids: [], keys: [], queryKeys: [] });
    expect(t.source.line).toBe(142);
    expect(t.rect).toEqual(expect.objectContaining({ x: 0, y: 0, pageX: 0, pageY: 0 }));
  });

  it('isOwn and commonAncestor', () => {
    expect(isOwn(document.querySelector('.bm-tool'))).toBe(true);
    expect(isOwn(document.querySelector('.secondary-btn'))).toBe(false);
    const [a, b] = document.querySelectorAll('.secondary-btn');
    expect(commonAncestor([a, b])).toBe(document.querySelector('.list'));
    expect(commonAncestor([a, document.querySelector('input')])).toBe(document.querySelector('section'));
  });
});
