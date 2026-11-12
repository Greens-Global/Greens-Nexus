import { describe, it, expect, vi, afterEach } from 'vitest';

// Point At It (11/12/2026): the Where line a ticket carries, and the layer
// that lets a person click one thing. The server reads the line back with
// build_mode_tickets.parse_where - the shapes here are its test's shapes.
vi.mock('../devnotes/lib/screenshot', () => ({
  AREA_PAD: 96,
  grabAreaFrame: vi.fn(() => Promise.resolve({ width: 10, height: 10 })),
  makeShots: vi.fn(() => Promise.resolve({ page: null, element: new Blob(['x'], { type: 'image/png' }) })),
}));
const shots = await import('../devnotes/lib/screenshot');
const { whatOf, whereLine, withWhere, pointAtIt } = await import('./pointAtIt');

afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('the Where line', () => {
  it('says the module, the page, the thing, and the source file when the build carries one', () => {
    const target = { tag: 'button', text: 'Add Task', breadcrumb: 'Home', attrs: {}, source: { file: 'src/tasks/Home.jsx', line: 120 } };
    expect(whereLine(target, '/tasks/home')).toBe('Where: Tasks > Home (/tasks/home) - button "Add Task" [src/tasks/Home.jsx:120]');
    expect(whereLine({ tag: 'div', text: '', breadcrumb: '', attrs: {} }, '/nowhere/x')).toBe('Where: Nexus (/nowhere/x) - area');
  });

  it('never carries the marks the line itself is read by', () => {
    expect(whatOf({ tag: 'a', text: 'Open (3) [new]\n"now"', attrs: {} })).toBe('link "Open 3 new now"');
    expect(whereLine({ tag: 'td', text: 'x', breadcrumb: 'Rent (Roll) [Q4]', attrs: {} }, '/leasing')).not.toMatch(/\(Roll\)|\[Q4\]/);
  });

  it('is one paragraph at the end of the description; pointing again replaces it', () => {
    const one = withWhere('<p>It is broken.</p>', 'Where: Tasks > Home (/tasks/home) - button "Add"');
    expect(one).toBe('<p>It is broken.</p><p>Where: Tasks &gt; Home (/tasks/home) - button "Add"</p>');
    const two = withWhere(one, 'Where: Tickets (/tickets) - row "T-1"');
    expect(two).toBe('<p>It is broken.</p><p>Where: Tickets (/tickets) - row "T-1"</p>');
    expect(withWhere('', 'Where: Nexus (/) - area')).toBe('<p>Where: Nexus (/) - area</p>');
  });
});

describe('pointAtIt', () => {
  const page = () => {
    const btn = document.createElement('button');
    btn.textContent = 'Add Task';
    document.body.appendChild(btn);
    document.elementsFromPoint = () => [btn];
    return btn;
  };

  it('a click on the page gives the picture, the line and takes the layer away', async () => {
    page();
    const p = pointAtIt();
    const layer = document.querySelector('[data-testid="point-at-it"]');
    expect(layer).toBeTruthy();
    expect(document.body.textContent).toContain('Click the thing that is wrong.');
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    const got = await p;
    expect(got.where).toMatch(/^Where: .* - button "Add Task"$/);
    expect(got.file.name).toMatch(/^pointed-\d+\.png$/);
    expect(got.file.type).toBe('image/png');
    expect(shots.makeShots.mock.calls[0][0].markup.items[0].type).toBe('rect');      // the thing is outlined in the picture
    expect(document.querySelector('[data-testid="point-at-it"]')).toBeNull();
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('Browse First lets the page take clicks until Point; Escape cancels', async () => {
    page();
    const p = pointAtIt();
    const layer = document.querySelector('[data-testid="point-at-it"]');
    const [browse] = document.querySelectorAll('[role="toolbar"] button');
    browse.click();
    expect(layer.style.pointerEvents).toBe('none');
    expect(browse.textContent).toBe('Point');
    browse.click();
    expect(layer.style.pointerEvents).toBe('auto');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBeNull();
    expect(document.querySelector('[data-testid="point-at-it"]')).toBeNull();
  });

  it('a source mark becomes its file path, and one that cannot be read is left out', async () => {
    const btn = page();
    btn.setAttribute('data-nx-src', '7:120:4');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => null });
    let p = pointAtIt();
    document.querySelector('[data-testid="point-at-it"]').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    expect((await p).where).toMatch(/- button "Add Task"$/);                 // no table: no bracket, never "file #7"
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ['a.jsx', 'b.jsx', 'c.jsx', 'd.jsx', 'e.jsx', 'f.jsx', 'g.jsx', 'src/tasks/Home.jsx'] });
    p = pointAtIt();
    document.querySelector('[data-testid="point-at-it"]').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    expect((await p).where).toMatch(/- button "Add Task" \[src\/tasks\/Home\.jsx:120\]$/);
    fetchSpy.mockRestore();
  });

  it('no picture is still an answer - the line alone', async () => {
    page();
    shots.grabAreaFrame.mockResolvedValueOnce(null);
    const p = pointAtIt();
    document.querySelector('[data-testid="point-at-it"]').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    const got = await p;
    expect(got.file).toBeNull();
    expect(got.where).toContain('Where: ');
  });
});
