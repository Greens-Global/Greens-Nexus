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

  it('headingsFor goes page title, module tab, then the containers\' headings', () => {
    expect(headingsFor(document.querySelector('.secondary-btn'))).toEqual(['Tasks', 'Home', 'Updates']);
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
