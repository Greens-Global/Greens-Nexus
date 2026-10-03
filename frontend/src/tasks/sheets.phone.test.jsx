import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { Modal, PersonSelect, SearchSelect, DateField } from './components';
import MobileTaskBar, { BottomSheet } from './MobileTaskBar';
import { scrollLockCount } from '../lib/useScrollLock';
import { __resetBackToClose } from '../lib/useBackToClose';

// Phone pass on the shared sheets and dropdowns (Tickets uses them, and so do
// the Task screens): dropdowns that do not zoom iOS or hide behind the
// keyboard, sheets that follow the visible viewport, lock the page behind
// them, hold focus, and close on the phone's Back button.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

function setViewport(isMobile) {
  window.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

function fakeVisualViewport(height, offsetTop = 0, width = 390) {
  const listeners = {};
  const vv = {
    height, offsetTop, offsetLeft: 0, width,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type) { (listeners[type] || []).forEach((f) => f()); },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

const people = [
  { email: 'pragya@greensglobal.com', name: 'Pragya Nautiyal' },
  { email: 'pranshu@greensglobal.com', name: 'Pranshu Pandey' },
];

// Wait for a history traversal (jsdom runs back()/go() asynchronously).
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

beforeEach(() => {
  window.scrollTo = vi.fn();
});
afterEach(() => {
  delete window.visualViewport;
  setViewport(false);
});

describe('dropdowns on a phone', () => {
  it('PersonSelect: 16px search box, no autofocus, 40px rows', () => {
    setViewport(true);
    render(<PersonSelect value={null} onChange={() => {}} people={people} />);
    fireEvent.click(screen.getByText('Unassigned'));
    const search = screen.getByPlaceholderText('Search people…');
    expect(search.style.fontSize).toBe('16px');
    expect(document.activeElement).not.toBe(search);
    expect(screen.getByText('Pranshu Pandey').parentElement.style.minHeight).toBe('40px');
  });

  it('PersonSelect on desktop is unchanged: 13px and focused on open', () => {
    setViewport(false);
    render(<PersonSelect value={null} onChange={() => {}} people={people} />);
    fireEvent.click(screen.getByText('Unassigned'));
    const search = screen.getByPlaceholderText('Search people…');
    expect(search.style.fontSize).toBe('13px');
    expect(document.activeElement).toBe(search);
    expect(screen.getByText('Pranshu Pandey').parentElement.style.minHeight).toBe('');
  });

  it('SearchSelect: 16px, no autofocus, 40px rows on a phone', () => {
    setViewport(true);
    render(<SearchSelect options={[{ id: 1, label: 'Alpha' }]} onPick={() => {}} placeholder="Move To..." />);
    fireEvent.click(screen.getByText('Move To...'));
    const search = screen.getByPlaceholderText('Search...');
    expect(search.style.fontSize).toBe('16px');
    expect(document.activeElement).not.toBe(search);
    expect(screen.getByText('Alpha').parentElement.style.minHeight).toBe('40px');
  });

  it('opens above the field when the keyboard leaves no room below it', () => {
    setViewport(true);
    // Keyboard up: only the top 400px are visible.
    fakeVisualViewport(400);
    render(<PersonSelect value={null} onChange={() => {}} people={people} />);
    const trigger = screen.getByText('Unassigned').closest('div[style]');
    trigger.getBoundingClientRect = () => ({ top: 340, bottom: 376, left: 16, right: 300, width: 284, height: 36 });
    fireEvent.click(screen.getByText('Unassigned'));
    const menu = screen.getByPlaceholderText('Search people…').parentElement;
    expect(menu.style.transform).toBe('translateY(-100%)');
    expect(parseFloat(menu.style.top)).toBe(336);               // its bottom edge sits on the field
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(340);
  });
});

describe('Modal on a phone', () => {
  it('is a labelled modal dialog that the generic sheet CSS skips', () => {
    setViewport(true);
    render(<Modal title="Ticket #000003" onClose={() => {}} footer={<button>Done</button>}><p>body</p></Modal>);
    const dlg = screen.getByRole('dialog', { name: 'Ticket #000003' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.className).toContain('nx-sheet');
    expect(dlg.className).toContain('nx-modal-sheet');
  });

  it('follows the visual viewport so the footer stays above the keyboard', () => {
    setViewport(true);
    const vv = fakeVisualViewport(800);
    render(<Modal title="Ticket" onClose={() => {}} footer={<button>Done</button>}><input /></Modal>);
    const overlay = document.querySelector('.nx-tasks-portal');
    const panel = screen.getByRole('dialog');
    expect(overlay.style.height).toBe('800px');
    act(() => { vv.height = 420; vv.offsetTop = 120; vv.fire('resize'); });
    expect(overlay.style.top).toBe('120px');
    expect(overlay.style.height).toBe('420px');
    expect(panel.style.height).toBe('420px');
    const body = panel.children[1];
    expect(body.style.overscrollBehavior).toBe('contain');
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('desktop keeps the 86vh card and the full-window overlay', () => {
    setViewport(false);
    fakeVisualViewport(800, 0, 1400);
    render(<Modal title="Ticket" onClose={() => {}}><p>body</p></Modal>);
    const overlay = document.querySelector('.nx-tasks-portal');
    expect(screen.getByRole('dialog').style.maxHeight).toBe('86vh');
    expect(overlay.style.height).toBe('');
    expect(scrollLockCount()).toBe(0);
  });

  it('locks the page behind it, ref-counted, and puts the scroll position back', () => {
    setViewport(true);
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
    function Two() {
      const [inner, setInner] = useState(true);
      const [outer, setOuter] = useState(true);
      return (
        <>
          {outer && <Modal title="Outer" onClose={() => setOuter(false)}><button onClick={() => setOuter(false)}>Close Outer</button></Modal>}
          {inner && <BottomSheet title="Inner" onClose={() => setInner(false)}><button onClick={() => setInner(false)}>Close Inner</button></BottomSheet>}
        </>
      );
    }
    render(<Two />);
    expect(scrollLockCount()).toBe(2);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-640px');
    fireEvent.click(screen.getByText('Close Inner'));
    expect(document.body.style.position).toBe('fixed');      // still one open
    fireEvent.click(screen.getByText('Close Outer'));
    expect(scrollLockCount()).toBe(0);
    expect(document.body.style.position).toBe('');
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 640 }));
    delete window.scrollY;
  });

  it('moves focus in on open, keeps Tab inside, and gives it back on close', () => {
    setViewport(true);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open It</button>
          {open && (
            <Modal title="Edit" onClose={() => setOpen(false)} footer={<button onClick={() => setOpen(false)}>Done</button>}>
              <input aria-label="Field" />
            </Modal>
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByText('Open It');
    opener.focus();
    fireEvent.click(opener);
    const dlg = screen.getByRole('dialog');
    expect(dlg.contains(document.activeElement)).toBe(true);
    // Tab from the last control (Done) wraps to the first (Close).
    const done = screen.getByText('Done');
    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
    fireEvent.click(done);
    expect(document.activeElement).toBe(opener);
  });
});

describe('Back closes the top sheet on a phone', () => {
  // Stand-in for App.jsx's own popstate listener: it must never hear a pop
  // that only closed a sheet (it would re-run its view/back bookkeeping).
  let appPop;
  beforeEach(async () => {
    // Earlier tests' sheets unmounted on cleanup and are still stepping
    // history back; let that land first.
    await settle();
    __resetBackToClose();
    appPop = vi.fn();
    window.addEventListener('popstate', appPop);
    window.history.replaceState({ depth: 3, fromLabel: 'Home' }, '', '/tickets');
  });
  afterEach(() => window.removeEventListener('popstate', appPop));

  function Stack({ dirty = false }) {
    const [drawer, setDrawer] = useState(false);
    const [dialog, setDialog] = useState(false);
    return (
      <>
        <button onClick={() => setDrawer(true)}>Open Drawer</button>
        {drawer && (
          <Modal title="Drawer" onClose={() => setDrawer(false)} isDirty={dirty}>
            <button onClick={() => setDialog(true)}>Open Dialog</button>
            <button onClick={() => setDrawer(false)}>Close Drawer</button>
          </Modal>
        )}
        {dialog && <Modal title="Dialog" onClose={() => setDialog(false)}><p>inner</p></Modal>}
      </>
    );
  }

  it('unwinds nested sheets one per Back without touching the screen', async () => {
    setViewport(true);
    render(<Stack />);
    fireEvent.click(screen.getByText('Open Drawer'));
    fireEvent.click(screen.getByText('Open Dialog'));
    expect(window.history.state.nxSheet.idx).toBe(2);   // one entry per open sheet
    // App's bookkeeping survives in the sheet entries.
    expect(window.history.state.depth).toBe(3);
    expect(window.history.state.nxSheet).toBeTruthy();

    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Dialog' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Drawer' })).toBeInTheDocument();

    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Drawer' })).toBeNull();
    expect(window.history.state).toEqual({ depth: 3, fromLabel: 'Home' });
    expect(window.location.pathname).toBe('/tickets');
    expect(appPop).not.toHaveBeenCalled();
  });

  it('a sheet closed by its own button takes its history entry with it', async () => {
    setViewport(true);
    render(<Stack />);
    fireEvent.click(screen.getByText('Open Drawer'));
    expect(window.history.state.nxSheet).toBeTruthy();
    fireEvent.click(screen.getByText('Close Drawer'));
    await settle();
    expect(window.history.state).toEqual({ depth: 3, fromLabel: 'Home' });
    expect(appPop).not.toHaveBeenCalled();
  });

  it('with unsaved changes Back asks first and the sheet stays open', async () => {
    setViewport(true);
    render(<Stack dirty />);
    fireEvent.click(screen.getByText('Open Drawer'));
    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.getByRole('dialog', { name: 'Drawer' })).toBeInTheDocument();
    expect(screen.getByText('Save your changes?')).toBeInTheDocument();
    // Its entry is back, so the next Back still lands on the sheet.
    expect(window.history.state.nxSheet).toBeTruthy();
    fireEvent.click(screen.getByText('Discard'));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Drawer' })).toBeNull();
    expect(window.history.state).toEqual({ depth: 3, fromLabel: 'Home' });
    expect(appPop).not.toHaveBeenCalled();
  });

  it('BottomSheet: Back steps out of a drill-in level first', async () => {
    setViewport(true);
    function Drill() {
      const [level, setLevel] = useState('detail');
      const [open, setOpen] = useState(true);
      if (!open) return null;
      return (
        <BottomSheet title={level === 'detail' ? 'Status' : 'Filter'} onClose={() => setOpen(false)}
          onBack={level === 'detail' ? () => setLevel('root') : undefined}><p>{level}</p></BottomSheet>
      );
    }
    render(<Drill />);
    expect(screen.getByRole('dialog', { name: 'Status' })).toBeInTheDocument();
    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.getByRole('dialog', { name: 'Filter' })).toBeInTheDocument();
    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(appPop).not.toHaveBeenCalled();
  });

  // A cut-down App.jsx: view <-> URL, with its popstate listener and its
  // push-on-change effect (the `fromPopstate` flag is the part a stray
  // popstate would wedge: the next move would then never reach the URL).
  function MiniApp() {
    const [view, setView] = useState(() => window.location.pathname.slice(1));
    const fromPop = React.useRef(false);
    const [sheet, setSheet] = useState(false);
    React.useEffect(() => {
      const onPop = (e) => { appPop(e); fromPop.current = true; setView(window.location.pathname.slice(1)); };
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }, []);
    React.useEffect(() => {
      if (fromPop.current) { fromPop.current = false; return; }
      if (window.location.pathname !== `/${view}`) {
        window.history.pushState({ depth: (window.history.state?.depth || 0) + 1 }, '', `/${view}`);
      }
    }, [view]);
    return (
      <div>
        <span data-testid="view">{view}</span>
        <button onClick={() => setView('tasks')}>Go Tasks</button>
        <button onClick={() => setSheet(true)}>Open Sheet</button>
        {view === 'tickets' && sheet && (
          <Modal title="Sheet" onClose={() => setSheet(false)}>
            <button onClick={() => { setSheet(false); setView('tasks'); }}>Open In Tasks</button>
          </Modal>
        )}
      </div>
    );
  }

  it('with a real view router: Back closes the sheet, the next Back changes screens', async () => {
    setViewport(true);
    render(<MiniApp />);
    fireEvent.click(screen.getByText('Open Sheet'));
    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('view').textContent).toBe('tickets');
    expect(appPop).not.toHaveBeenCalled();
    // App's own navigation still reaches the address bar afterwards.
    fireEvent.click(screen.getByText('Go Tasks'));
    expect(window.location.pathname).toBe('/tasks');
    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.getByTestId('view').textContent).toBe('tickets');
    expect(window.location.pathname).toBe('/tickets');
  });

  it('a sheet left by navigating away does not cost an extra Back later', async () => {
    setViewport(true);
    render(<MiniApp />);
    fireEvent.click(screen.getByText('Open Sheet'));
    // A link inside the sheet moves to another screen; App pushes /tasks over
    // the sheet's entry, which is now stale.
    fireEvent.click(screen.getByText('Open In Tasks'));
    await settle();
    expect(window.location.pathname).toBe('/tasks');
    // One Back: the previous screen, and the stale entry is stepped over.
    await act(async () => { window.history.back(); });
    await settle();
    expect(screen.getByTestId('view').textContent).toBe('tickets');
    expect(window.location.pathname).toBe('/tickets');
    expect(window.history.state?.nxSheet).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('desktop pushes nothing', () => {
    setViewport(false);
    const start = window.history.length;
    render(<Stack />);
    fireEvent.click(screen.getByText('Open Drawer'));
    expect(window.history.length).toBe(start);
    expect(window.history.state.nxSheet).toBeUndefined();
  });
});

describe('MobileTaskBar', () => {
  const views = [{ key: 'list', label: 'List', icon: () => null }];
  const bar = () => screen.getByLabelText(/Create/).parentElement;

  it('floats above the module bottom nav by default', () => {
    render(<MobileTaskBar views={views} view="list" setView={() => {}} onCreate={() => {}} filterSheet={() => null} />);
    expect(bar().style.bottom).toMatch(/82px|64px/);   // jsdom folds the calc's constants
    expect(screen.getByLabelText('Create task')).toBeInTheDocument();
  });

  it('sits just above the home indicator without one, with its own label', () => {
    render(<MobileTaskBar views={views} view="list" setView={() => {}} onCreate={() => {}} filterSheet={() => null}
      hasModuleNav={false} createLabel="Create Ticket" />);
    expect(bar().style.bottom).toMatch(/^calc\((16px \+ env\(safe-area-inset-bottom\)|env\(safe-area-inset-bottom\) \+ 16px)\)$/);
    expect(screen.getByTitle('Create Ticket')).toBeInTheDocument();
  });
});

describe('date popover on a phone', () => {
  it('stays inside the visible area above the keyboard', async () => {
    setViewport(true);
    fakeVisualViewport(500);
    render(<DateField value="2026-10-03" onChange={() => {}} />);
    const btn = screen.getByTitle('Set date');
    btn.getBoundingClientRect = () => ({ top: 450, bottom: 470, left: 20, right: 140, width: 120, height: 20 });
    fireEvent.click(btn);
    const pop = await waitFor(() => screen.getByText('Clear').closest('div[style*="position: fixed"]'));
    // 372px tall: it cannot fit below the field (keyboard), so it opens upward.
    expect(pop.style.transform).toBe('translateY(-100%)');
    expect(parseFloat(pop.style.top)).toBe(444);
  });

  it('pins itself inside the visible area when it fits neither way', async () => {
    setViewport(true);
    fakeVisualViewport(420, 100);
    render(<DateField value="2026-10-03" onChange={() => {}} />);
    const btn = screen.getByTitle('Set date');
    btn.getBoundingClientRect = () => ({ top: 300, bottom: 320, left: 20, right: 140, width: 120, height: 20 });
    fireEvent.click(btn);
    const pop = await waitFor(() => screen.getByText('Clear').closest('div[style*="position: fixed"]'));
    expect(pop.style.transform).toBe('');
    expect(parseFloat(pop.style.top)).toBe(140);   // 100 + 420 - 372 - 8: bottom edge above the keyboard
  });
});
