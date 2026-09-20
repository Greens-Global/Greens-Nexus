import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The Documents module's tabs are the bottom bar on phones (Sagar, Sep 20),
// the same treatment the Task and Item modules already get. Documents.jsx
// stops drawing its in-page strip there, so this bar IS the navigation - if it
// stops listing a tab, that screen becomes unreachable on a phone.

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const MobileNav = (await import('./MobileNav')).default;

const labels = () => [...document.querySelectorAll('.mobile-nav-item span')].map(s => s.textContent);
const activeLabel = () => document.querySelector('.mobile-nav-item.active span')?.textContent;

afterEach(cleanup);

describe('Documents bottom bar', () => {
  it('lists every Documents tab, in the desktop strip order', () => {
    render(<MobileNav activeView="documents" activeSub="documents-browse" />);
    expect(labels()).toEqual(['Dashboard', 'My Docs', 'Templates', 'Sign', 'PDF Tools']);
  });

  it('marks the open tab, defaulting to the dashboard before any navigation', () => {
    const { unmount } = render(<MobileNav activeView="documents" activeSub="documents-templates" />);
    expect(activeLabel()).toBe('Templates');
    unmount();
    render(<MobileNav activeView="documents" activeSub="" />);
    expect(activeLabel()).toBe('Dashboard');
  });

  it('keeps the e-sign deep links on the Sign tab', () => {
    render(<MobileNav activeView="documents" activeSub="documents-esign-requests" />);
    expect(activeLabel()).toBe('Sign');
  });

  it('navigates on tap', () => {
    const onNav = vi.fn();
    window.addEventListener('nexus:navigate', onNav);
    render(<MobileNav activeView="documents" activeSub="documents-dashboard" />);
    fireEvent.click(screen.getByText('PDF Tools'));
    window.removeEventListener('nexus:navigate', onNav);
    expect(onNav.mock.calls[0][0].detail).toEqual({ view: 'documents', sub: 'documents-pdf' });
  });

  it('shows no bar on a module that has none', () => {
    render(<MobileNav activeView="dashboard" activeSub="" />);
    expect(document.querySelector('.mobile-nav')).toBeNull();
  });
});
