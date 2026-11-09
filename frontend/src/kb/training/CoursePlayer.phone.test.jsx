// Render-smoke for the lesson player on a phone (11/08/2026): the lesson reads
// first under a "Lesson N of M" strip, the list folds out of the strip, and
// Next and Complete and Continue share one row.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => true, default: () => true }));
vi.mock('../../lib/useActionCounts', () => ({ useActionCounts: () => ({}), tabCount: () => 0, moduleCount: () => 0, withBadges: (t) => t, DATA_WRITTEN: 'nexus:data-written' }));

const para = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const COURSE = {
  id: 'crs_1', title: 'Nexus Fundamentals', status: 'published', my_status: 'In Progress', my_pct: 25, est_minutes: 30, delivery: '',
  lessons: [
    { _id: 'l1', title: 'Welcome to Nexus', type: 'lesson', done: true, reading_minutes: 4, blocks: para('Welcome body.') },
    { _id: 'l2', title: 'Signing In', type: 'lesson', done: false, reading_minutes: 5, blocks: para('Signing in body.') },
    { _id: 'l3', title: 'Punching In', type: 'lesson', done: false, reading_minutes: 6, blocks: para('Punch body.') },
  ],
  quiz: { question_count: 10, draw: 5, pass_pct: 80, max_tries: 3, tries_used: 0, passed: false, locked: false },
  can_edit: false, teaches: [], tags: [], sessions: [],
};
vi.mock('../../api', () => {
  const named = { kbCourse: () => Promise.resolve(COURSE) };
  const api = new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) });
  return { api, default: api, saveBlob: () => {}, API_BASE: 'http://localhost:8000' };
});

const { default: CoursePlayer } = await import('./CoursePlayer');
const { ToastProvider } = await import('../components/Toast');
afterEach(cleanup);

describe('lesson player on a phone', () => {
  it('opens on the next lesson under its strip, body first, list folded, Next row compact', async () => {
    render(<ToastProvider><CoursePlayer id="crs_1" me={{}} /></ToastProvider>);
    expect((await screen.findByRole('button', { name: /Lesson 2 of 3/ })).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Signing in body.')).toBeTruthy();
    expect(document.querySelector('#kb-lesson-list')).toBeNull();   // the list waits behind the strip
    expect(document.querySelector('.kb-lesson-nav.compact')).toBeTruthy();
    expect(screen.getByText('Punching In', { exact: false })).toBeTruthy();   // "Next: Punching In"
    fireEvent.click(screen.getByRole('button', { name: /Lesson 2 of 3/ }));
    expect(document.querySelector('#kb-lesson-list')).toBeTruthy();
    expect(screen.getByText('Course Home')).toBeTruthy();
  });

  it('a link to one lesson opens on it', async () => {
    render(<ToastProvider><CoursePlayer id="crs_1" lesson="l3" me={{}} /></ToastProvider>);
    expect(await screen.findByRole('button', { name: /Lesson 3 of 3/ })).toBeTruthy();
    expect(screen.getByText('Punch body.')).toBeTruthy();
  });

  it('a link to another lesson of the course already open moves to it', async () => {
    const ui = (lesson) => <ToastProvider><CoursePlayer id="crs_1" lesson={lesson} me={{}} /></ToastProvider>;
    const { rerender } = render(ui('l3'));
    expect(await screen.findByRole('button', { name: /Lesson 3 of 3/ })).toBeTruthy();
    rerender(ui('l1'));
    expect(await screen.findByRole('button', { name: /Lesson 1 of 3/ })).toBeTruthy();
    expect(screen.getByText('Welcome body.')).toBeTruthy();
  });
});
