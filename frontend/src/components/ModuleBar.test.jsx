import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ModuleTabs, { HeaderTabsProvider, ModuleBar, ModuleActions } from './ModuleTabs';
import { PageTrailProvider } from './PageTrail';

// One page header (11/05/2026): every module reads the same way - its name
// on the left, its tabs, its actions on the right, one hairline under it.
// The shell draws the bar (App.jsx); a module only declares its tabs and,
// when it has any, its actions.

afterEach(cleanup);

const shell = (children, label = 'People') => render(
  <HeaderTabsProvider>
    <PageTrailProvider view="hr" label={label} onNavigate={() => {}}>
      <ModuleBar />
      <div className="viewport">{children}</div>
    </PageTrailProvider>
  </HeaderTabsProvider>,
);

describe('the module bar', () => {
  it("names the module and draws the module's tabs, the active one lit", () => {
    const onChange = vi.fn();
    shell(<ModuleTabs tabs={[{ key: 'a', label: 'People' }, { key: 'b', label: 'Hiring', badge: 3 }]} active="a" onChange={onChange} />);
    const bar = document.querySelector('.module-bar');
    expect(bar).toBeTruthy();
    expect(bar.querySelector('.page-trail--bar').textContent).toBe('People');
    const tabs = bar.querySelectorAll('.hdr-tabs .hdr-tab');
    expect([...tabs].map((t) => t.textContent)).toEqual(['People', 'Hiring3']);
    expect(tabs[0].getAttribute('aria-current')).toBe('page');
    fireEvent.click(tabs[1]);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it("puts a module's actions at the bar's right end", () => {
    shell(
      <>
        <ModuleTabs tabs={[{ key: 'a', label: 'People' }]} active="a" onChange={() => {}} />
        <ModuleActions><button type="button">Add Person</button></ModuleActions>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Add Person' }).closest('.module-bar-actions')).toBeTruthy();
  });

  it('shows the name alone for a module with no tabs, and nothing when no module publishes', () => {
    shell(<ModuleTabs tabs={[]} active="" onChange={() => {}} />, 'Asset Management');
    expect(document.querySelector('.module-bar .page-trail--bar').textContent).toBe('Asset Management');
    expect(document.querySelector('.module-bar .hdr-tabs')).toBeNull();
    expect(document.querySelector('.module-tabs-inline')).toBeNull();
    cleanup();
    shell(<p>No tabs here</p>);
    expect(document.querySelector('.module-bar')).toBeNull();
  });

  it('shows no strip for a single tab: it would only repeat the module (Neil, 11/06/2026)', () => {
    shell(<ModuleTabs tabs={[{ key: 'help', label: 'Help Center' }]} active="help" onChange={() => {}} />, 'Help Center');
    expect(document.querySelector('.module-bar .page-trail--bar').textContent).toBe('Help Center');
    expect(document.querySelector('.module-bar .hdr-tabs')).toBeNull();
    expect(document.querySelector('.module-tabs-inline')).toBeNull();
  });

  it('rides in the top header on a computer and under it on a phone - one at a time', () => {
    const real = window.matchMedia;
    const at = (phone) => {
      window.matchMedia = (q) => ({ matches: phone && /max-width:\s*900px/.test(q), media: q,
        addEventListener() {}, removeEventListener() {} });
      return render(
        <HeaderTabsProvider>
          <PageTrailProvider view="hr" label="People" onNavigate={() => {}}>
            <header><ModuleBar where="header" /></header>
            <ModuleBar where="below" />
            <ModuleTabs tabs={[{ key: 'a', label: 'People' }, { key: 'b', label: 'Hiring' }]} active="a" onChange={() => {}} />
            <ModuleActions><button type="button">Add Person</button></ModuleActions>
          </PageTrailProvider>
        </HeaderTabsProvider>,
      );
    };
    try {
      at(false);
      expect(document.querySelectorAll('.module-bar')).toHaveLength(1);
      expect(document.querySelector('header .module-bar--header nav.hdr-tabs').textContent).toContain('Hiring');
      expect(screen.getByRole('button', { name: 'Add Person' }).closest('header')).toBeTruthy();
      cleanup();
      at(true);
      expect(document.querySelectorAll('.module-bar')).toHaveLength(1);
      expect(document.querySelector('header .module-bar')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add Person' }).closest('.module-bar-actions')).toBeTruthy();
    } finally {
      window.matchMedia = real;
    }
  });

  it('renders actions in place when there is no shell (a module rendered alone)', () => {
    render(<ModuleActions><button type="button">Add Asset</button></ModuleActions>);
    expect(screen.getByRole('button', { name: 'Add Asset' })).toBeTruthy();
  });
});
