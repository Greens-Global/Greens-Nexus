// Vitest global setup: jest-dom matchers + stubs for browser APIs that jsdom
// lacks but components touch on mount (so a render-smoke test doesn't throw on
// an unrelated missing API and mask a real crash).
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// findBy* / waitFor give up after 1 s by default. The full suite runs ~900
// files in parallel, and on a loaded CI runner a screen whose data lands in
// 1.2 s failed a different, unrelated test on each run (11/11/2026: Workday,
// Credential Vault and a Preventive Maintenance test on three runs of one PR;
// #1118 needed three attempts). 5 s is patience, not leniency - a wait that
// never resolves still fails, and a passing test is no slower.
configure({ asyncUtilTimeout: 5000 });

// IntersectionObserver - used by the task list's incremental-render sentinel.
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

// matchMedia - read by LoginPage (reduced-motion) and responsive hooks.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

// ResizeObserver - some chart/layout components attach one.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// requestAnimationFrame - the column-resize path schedules via rAF.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

// Quiet the expected React error-boundary console noise in crash tests.
vi.spyOn(console, 'error').mockImplementation(() => {});

// The TanStack query cache is one module-level client (lib/queryClient), and
// hooks such as lib/useTimeStatus read it without a provider. Empty it after
// every test so one test's cached answer (or a request it left hanging) can
// never be what the next test renders.
import { afterEach } from 'vitest';
import { queryClient } from './src/lib/queryClient';
afterEach(() => { queryClient.clear(); });
// The planner's in-memory week cache (components/shifts/weekCache.js) must
// not carry one test's schedule into the next.
import { clearWeeks } from './src/components/shifts/weekCache';
afterEach(() => { clearWeeks(); });

// The Excalidraw engine (Notes boards, Neil 11/02/2026) cannot run under
// jsdom (canvas, ResizeObserver, pointer events) and its dev build imports
// `roughjs/bin/rough` with no extension, which Node's resolver refuses. Any
// suite that renders NotesPage reaches it through the Board's lazy import,
// so it is replaced here for every test; Board.test.jsx installs its own,
// richer mock on top (a test file's vi.mock wins over this one).
vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react');
  const pass = ({ children }) => React.createElement('div', null, children);
  const MainMenu = pass;
  MainMenu.Item = ({ children, onSelect }) => React.createElement('button', { type: 'button', onClick: onSelect }, children);
  MainMenu.ItemCustom = pass;
  MainMenu.Separator = () => null;
  MainMenu.DefaultItems = { ChangeCanvasBackground: () => null, ClearCanvas: () => null };
  return {
    Excalidraw: (props) => React.createElement('div', { 'data-testid': 'engine' }, props.children),
    MainMenu,
    THEME: { LIGHT: 'light', DARK: 'dark' },
    CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
    exportToBlob: async () => new Blob(),
    exportToSvg: async () => ({ outerHTML: '<svg/>' }),
    exportToClipboard: async () => {},
    reconcileElements: (local) => local,
    restoreElements: (els) => els,
    getSceneVersion: () => 0,
  };
});
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));

// ProseMirror measures the selection to scroll it into view after a focus
// (`coordsAtPos` -> `Range.getClientRects`), and jsdom has no layout: without
// these the Insert Board test left an uncaught TypeError on CI's Node 20 and
// failed the whole run with every test green.
if (typeof Range !== 'undefined') {
  const emptyRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } });
  const emptyRects = () => { const list = []; list.item = () => null; return list; };
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect;
}
