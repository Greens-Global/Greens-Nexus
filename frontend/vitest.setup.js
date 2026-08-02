// Vitest global setup: jest-dom matchers + stubs for browser APIs that jsdom
// lacks but components touch on mount (so a render-smoke test doesn't throw on
// an unrelated missing API and mask a real crash).
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

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
