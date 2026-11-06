import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ModuleTabs, { HeaderTabsProvider, ModuleBar, ModuleActions, ModuleActionsSlot } from './ModuleTabs';
import { PageTrailProvider } from './PageTrail';

// One page header (11/05/2026): every module reads the same way - its name
// and its tabs in the top header (11/06/2026), its buttons at the right end of
// the page's first row, never in the header. The shell draws both (TopHeader,
// App.jsx); a module only declares its tabs and, when it has any, its actions.

afterEach(cleanup);

const shell = (children, label = 'People') => render(
  <HeaderTabsProvider>
    <PageTrailProvider view="hr" label={label} onNavigate={() => {}}>
      <header><ModuleBar /></header>
      <div className="viewport"><ModuleActionsSlot />{children}</div>
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
    const tabs = bar.querySelectorAll('nav.hdr-tabs .hdr-tab');
    expect([...tabs].map((t) => t.textContent)).toEqual(['People', 'Hiring3']);
    expect(tabs[0].getAttribute('aria-current')).toBe('page');
    fireEvent.click(tabs[1]);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it("puts a module's actions in the page, never in the header (Neil, 11/06/2026)", () => {
    shell(
      <>
        <ModuleTabs tabs={[{ key: 'a', label: 'People' }]} active="a" onChange={() => {}} />
        <ModuleActions><button type="button">Add Person</button></ModuleActions>
      </>,
    );
    const btn = screen.getByRole('button', { name: 'Add Person' });
    expect(btn.closest('.viewport .module-actions-row')).toBeTruthy();
    expect(btn.closest('header')).toBeNull();
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

  it('rides in the top header on a computer only; the buttons stay in the page at every width', () => {
    const real = window.matchMedia;
    const at = (phone) => {
      window.matchMedia = (q) => ({ matches: phone && /max-width:\s*900px/.test(q), media: q,
        addEventListener() {}, removeEventListener() {} });
      return shell(
        <>
          <ModuleTabs tabs={[{ key: 'a', label: 'People' }, { key: 'b', label: 'Hiring' }]} active="a" onChange={() => {}} />
          <ModuleActions><button type="button">Add Person</button></ModuleActions>
        </>,
      );
    };
    try {
      at(false);
      expect(document.querySelector('header .module-bar--header nav.hdr-tabs').textContent).toContain('Hiring');
      expect(screen.getByRole('button', { name: 'Add Person' }).closest('.module-actions-row')).toBeTruthy();
      cleanup();
      at(true);
      expect(document.querySelector('.module-bar')).toBeNull();
      expect(document.querySelector('.module-tabs-inline').textContent).toContain('Hiring');
      expect(screen.getByRole('button', { name: 'Add Person' }).closest('.module-actions-row')).toBeTruthy();
    } finally {
      window.matchMedia = real;
    }
  });

  it('renders actions in place when there is no shell (a module rendered alone)', () => {
    render(<ModuleActions><button type="button">Add Asset</button></ModuleActions>);
    expect(screen.getByRole('button', { name: 'Add Asset' })).toBeTruthy();
  });
});
