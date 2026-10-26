import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { TASKS_PERSON_PAGE } from '../lib/personTasksNav';

// A person opened in Tasks from search elsewhere is a page of its own: no
// Tasks tabs in the phone bottom bar either (Sagar, Oct 27).

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const MobileNav = (await import('./MobileNav')).default;
const labels = () => [...document.querySelectorAll('.mobile-nav-item span')].map((s) => s.textContent);
const signal = (outside) => act(() => { window.dispatchEvent(new CustomEvent(TASKS_PERSON_PAGE, { detail: { outside } })); });

afterEach(cleanup);

describe('Tasks bottom bar and a person page', () => {
  it('drops the Tasks tabs while a person opened from outside shows, and brings them back after', () => {
    render(<MobileNav activeView="tasks" activeSub="home" />);
    expect(labels()).toContain('Projects');
    signal(true);
    expect(document.querySelector('.mobile-nav')).toBeNull();
    signal(false);
    expect(labels()).toContain('Projects');
  });
});
