import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Settings (AdminConsole): Global Settings, Company Settings and Tools render
// as separate areas, Access is a Global Settings category (admins only), old
// links still land somewhere sensible, and the filter narrows the org-wide
// sections.

// Every api call resolves empty - no section that renders here needs data.
vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve([])) }),
}));
const roleState = { admin: true };
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: (min) => (min === 'administrator' ? roleState.admin : true),
    myGrantedModules: new Set(), actingAs: null,
    startActAs: vi.fn(), stopActAs: vi.fn(),
  }),
}));
// HR.jsx is huge; Company Settings only needs to prove it mounts the page.
vi.mock('./HR', () => ({
  CompanySetupPage: () => <div>Company list</div>,
  WorkSiteLibrary: () => <div>Site list</div>,
}));
vi.mock('../tickets/TicketDeskSettings', () => ({ default: () => <div>Desk panel</div> }));
vi.mock('../tickets/TicketNotifySettings', () => ({ default: () => <div>Notify panel</div> }));
vi.mock('../tickets/TicketTaxonomySettings', () => ({ default: () => <div>SLA panel</div> }));
vi.mock('./RolesAccess', () => ({ default: () => <div>Access panel</div> }));
vi.mock('./SettingsTools', () => ({ default: () => <div>Tools panel</div> }));

const AdminConsole = (await import('./AdminConsole')).default;

afterEach(() => { cleanup(); vi.restoreAllMocks(); roleState.admin = true; });

describe('AdminConsole', () => {
  it('has Global Settings, Company Settings, Tools and Audit Logs tabs, and no Access tab', () => {
    render(<AdminConsole activeSub="global" onSubChange={() => {}} />);
    for (const name of ['Global Settings', 'Company Settings', 'Tools', 'Audit Logs']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    // The only "Access" left is the Global Settings rail entry.
    expect(screen.getAllByRole('button', { name: /Access/ })).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Global settings categories' })).toContainElement(
      screen.getByRole('button', { name: /Access/ }));
  });

  it('shows Global Settings with the Organization category by default', () => {
    render(<AdminConsole activeSub="global" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to every company.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByText('Email Signature')).toBeInTheDocument();
    expect(screen.getByText('Work Site Library')).toBeInTheDocument();
    expect(screen.queryByText('Service Desk')).not.toBeInTheDocument();
  });

  it('lands an old "settings" sub on Global Settings', () => {
    render(<AdminConsole activeSub="settings" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to every company.')).toBeInTheDocument();
    expect(screen.getByText('Email Signature')).toBeInTheDocument();
  });

  it('keeps ticket, task and briefing emails in one Notifications & Communications category', () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="global-notifications" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Notifications & Communications' })).toBeInTheDocument();
    for (const t of ['Service Desk', 'Task Notifications', 'Daily Briefing']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    // Routing, ticket email and SLAs are one Service Desk section now.
    expect(screen.queryByText('Ticket Notifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Items/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('global-items');
    fireEvent.click(screen.getByRole('button', { name: /Organization/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('global');
  });

  it('switches Service Desk panels with tabs, keeping an opened panel mounted', () => {
    render(<AdminConsole activeSub="global-notifications" onSubChange={() => {}} />);
    fireEvent.click(screen.getByText('Service Desk'));
    expect(screen.getByRole('tab', { name: /Routing & Escalation/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Desk panel')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /SLA & Ticket Types/ }));
    expect(screen.getByText('SLA panel')).toBeVisible();
    // Still mounted (unsaved edits survive), just hidden.
    expect(screen.getByText('Desk panel')).not.toBeVisible();
    expect(screen.queryByText('Notify panel')).not.toBeInTheDocument();
  });

  it.each(['global-service-desk', 'global-tasks', 'global-communications'])(
    'sends the retired %s link to Notifications & Communications', (sub) => {
      render(<AdminConsole activeSub={sub} onSubChange={() => {}} />);
      expect(screen.getByRole('heading', { name: 'Notifications & Communications' })).toBeInTheDocument();
    });

  it('shows Access as a Global Settings category, and old access links land on it', async () => {
    render(<AdminConsole activeSub="access" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to every company.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Access' })).toBeInTheDocument();
    expect(await screen.findByText('Access panel')).toBeInTheDocument();
  });

  it('hides the Access category from non-admins', () => {
    roleState.admin = false;
    render(<AdminConsole activeSub="global-access" onSubChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /Access/ })).not.toBeInTheDocument();
    // Falls back to the first category it can show.
    expect(screen.getByRole('heading', { name: 'Organization' })).toBeInTheDocument();
  });

  it('shows Company Settings as its own per-company area', async () => {
    render(<AdminConsole activeSub="company" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to one company at a time.')).toBeInTheDocument();
    expect(await screen.findByText('Company list')).toBeInTheDocument();
    expect(screen.queryByText('Applies to every company.')).not.toBeInTheDocument();
  });

  it('opens Tools from an old actas link', async () => {
    render(<AdminConsole activeSub="actas" onSubChange={() => {}} />);
    expect(await screen.findByText('Tools panel')).toBeInTheDocument();
    expect(screen.queryByText('Applies to every company.')).not.toBeInTheDocument();
  });

  it('filters sections across every category and opens a lone match', () => {
    render(<AdminConsole activeSub="global" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Filter settings');

    fireEvent.change(box, { target: { value: 'notifications' } });
    expect(screen.getByText('Service Desk')).toBeInTheDocument();
    expect(screen.getByText('Task Notifications')).toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'geofence' } });
    expect(screen.getByText('Work Site Library')).toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'permissions' } });
    expect(screen.getByRole('heading', { name: 'Access' })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'nothing like this' } });
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filter' }));
    expect(screen.getByText('Email Signature')).toBeInTheDocument();
  });

  it('swaps the category rail for a select on phones', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: true, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="global" onSubChange={onSubChange} />);
    expect(screen.queryByRole('navigation', { name: 'Global settings categories' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'notifications' } });
    expect(onSubChange).toHaveBeenLastCalledWith('global-notifications');
  });
});
