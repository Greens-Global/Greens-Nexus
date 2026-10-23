import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

// Settings (AdminConsole, one tab since Oct 23 2026): a rail of subjects, a
// scope picker (Every company / one company), every group open, old links
// still landing somewhere sensible, and the filter searching every subject.

// Every api call resolves empty, except the companies the scope picker lists.
const COMPANIES = [{ id: 'c1', name: 'Greens Global' }, { id: 'c2', name: 'Greens India' }];
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (
    k === 'getEntities' ? () => Promise.resolve(COMPANIES)
      : k === 'getEntitySignatureTemplates' ? () => Promise.resolve({ templates: [], template: 'classic' })
        : vi.fn(() => Promise.resolve([]))) }),
}));
const roleState = { admin: true };
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: (min) => (min === 'administrator' ? roleState.admin : true),
    myGrantedModules: new Set(), actingAs: null,
    startActAs: vi.fn(), stopActAs: vi.fn(),
  }),
}));
// HR.jsx is huge; the company page only needs to prove it mounts with what
// the shell asked for.
vi.mock('./HR', () => ({
  CompanySetupPage: ({ entityId, tabs, onOpen }) => (
    <div>
      {entityId ? `Company page ${entityId}: ${(tabs || []).join(' ')}` : 'Company list'}
      {onOpen && <button onClick={() => onOpen('c2')}>Edit Greens India</button>}
    </div>
  ),
  WorkSiteLibrary: () => <div>Site list</div>,
}));
vi.mock('../tickets/TicketDeskSettings', () => ({ default: ({ company }) => <div>Desk panel{company ? ` ${company}` : ''}</div> }));
vi.mock('../tickets/TicketNotifySettings', () => ({ default: () => <div>Notify panel</div> }));
vi.mock('../tickets/TicketTaxonomySettings', () => ({ default: () => <div>SLA panel</div> }));
vi.mock('./RolesAccess', () => ({ default: () => <div>Access panel</div> }));
vi.mock('./SecuritySettings', () => ({ default: () => <div>Sessions panel</div> }));
vi.mock('./BrandingPoliciesSettings', () => ({
  BrandColorPanel: () => <div>Brand color panel</div>,
  EmailAppearancePanel: () => <div>Email appearance panel</div>,
  SignInPolicyPanel: () => <div>Sign-in policy panel</div>,
}));
vi.mock('../components/shifts/ShiftSettingsSections', () => ({
  ShiftSettingsPanel: ({ company }) => <div>Shift settings panel{company ? ` ${company}` : ''}</div>,
  ShiftTypesPanel: () => <div>Shift types panel</div>,
  ShiftGroupsPanel: () => <div>Groups panel</div>,
}));
vi.mock('../components/shifts/WeatherSettings', () => ({ default: ({ company }) => <div>Weather panel{company ? ` ${company}` : ''}</div> }));
vi.mock('../components/PayrollExportCodes', () => ({ default: ({ company }) => <div>Export codes panel{company ? ` ${company}` : ''}</div> }));
vi.mock('../components/PayPremiums', () => ({ default: ({ company }) => <div>Premiums panel{company ? ` ${company}` : ''}</div> }));
vi.mock('../components/DailyBriefingSettings', () => ({ default: () => <div>Briefing panel</div> }));
vi.mock('../components/WeeklyDigestSettings', () => ({ default: () => <div>Digest panel</div> }));
vi.mock('../components/WorkforceScorecardSettings', () => ({ default: () => <div>Scorecard panel</div> }));
vi.mock('../components/HrReminderSettings', () => ({ default: () => <div>HR reminders panel</div> }));
vi.mock('../components/EquipmentReminderSettings', () => ({ default: () => <div>Equipment reminders panel</div> }));
vi.mock('../tasks/TaskNotifySettings', () => ({ default: () => <div>Task notify panel</div> }));
vi.mock('../tasks/TasksContext', () => ({ TasksProvider: ({ children }) => <div>{children}</div> }));
vi.mock('./SettingsTools', () => ({ default: () => <div>Tools panel</div> }));
vi.mock('../components/HrChecklists', () => ({ ChecklistLibrary: () => <div>Checklist library panel</div> }));

const AdminConsole = (await import('./AdminConsole')).default;

afterEach(() => { cleanup(); vi.restoreAllMocks(); roleState.admin = true; });

const rail = () => screen.getByRole('navigation', { name: 'Settings subjects' });
// Lazy panels on a slow machine: give a find a little longer than the default second.
const find = (text) => screen.findByText(text, {}, { timeout: 5000 });

describe('AdminConsole', () => {
  it('has one Settings tab beside Tools and Logs - no Global or Company Settings tabs', () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    for (const name of ['Settings', 'Tools', 'Logs']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}$`) })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Global Settings|Company Settings|Audit Logs/ })).not.toBeInTheDocument();
  });

  it('opens on Companies at Every company, with every subject in the rail', async () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Companies' })).toBeInTheDocument();
    expect(await find('Company list')).toBeInTheDocument();
    expect(screen.getByLabelText('Scope')).toHaveValue('');
    const names = within(rail()).getAllByRole('button').map(b => b.textContent);
    expect(names).toEqual(['Companies', 'Locations', 'People & Access', 'Security', 'Branding & Email', 'Emails & Reminders',
      'Tickets', 'Time & Pay', 'Workforce Analytics', 'Shifts & Scheduling', 'Hiring & Onboarding', 'Items & Equipment', 'Operations']);
    expect(screen.queryByText('For every company')).not.toBeInTheDocument();
  });

  it.each([
    ['settings', 'Companies'], ['global', 'Companies'], ['company', 'Companies'],
    ['global-notifications', 'Emails & Reminders'], ['global-service-desk', 'Tickets'], ['global-tasks', 'Emails & Reminders'],
    ['global-timeclock', 'Time & Pay'], ['global-branding', 'Branding & Email'], ['global-hiring', 'Hiring & Onboarding'],
    ['global-shifts', 'Shifts & Scheduling'], ['access', 'People & Access'], ['global-access', 'People & Access'],
    ['nonsense', 'Companies'],
  ])('lands the old "%s" link on %s', (sub, heading) => {
    render(<AdminConsole activeSub={sub} onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('opens Tools from an old actas link', async () => {
    render(<AdminConsole activeSub="actas" onSubChange={() => {}} />);
    expect(await find('Tools panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Scope')).not.toBeInTheDocument();
  });

  it('keeps every scheduled email in Emails & Reminders, open, and Ticket Manager under Tickets', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="emails" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Emails & Reminders' })).toBeInTheDocument();
    for (const t of ['Task Notifications', 'Daily Briefing', 'Weekly Digest', 'Workforce Scorecard', 'HR & Compliance Reminders', 'Equipment Reminders']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    // Nothing to expand: the panels are already there.
    expect(await find('Briefing panel')).toBeInTheDocument();
    expect(await find('HR reminders panel')).toBeInTheDocument();
    expect(screen.queryByText('Ticket Manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.click(within(rail()).getByRole('button', { name: 'Tickets' }));
    expect(onSubChange).toHaveBeenLastCalledWith('tickets');
    fireEvent.click(within(rail()).getByRole('button', { name: 'Companies' }));
    expect(onSubChange).toHaveBeenLastCalledWith('companies');
  });

  it('switches Ticket Manager panels with tabs, keeping an opened panel mounted', () => {
    render(<AdminConsole activeSub="tickets" onSubChange={() => {}} />);
    expect(screen.getByRole('tab', { name: /Routing & Escalation/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Desk panel')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /SLA & Ticket Types/ }));
    expect(screen.getByText('SLA panel')).toBeVisible();
    // Still mounted (unsaved edits survive), just hidden.
    expect(screen.getByText('Desk panel')).not.toBeVisible();
    expect(screen.queryByText('Notify panel')).not.toBeInTheDocument();
  });

  it('puts the Sign-In Policy under Security and highlights the group a link points at', () => {
    render(<AdminConsole activeSub="security:signin-policy" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sign-In & Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sign-In Policy' })).toHaveAttribute('data-highlight', 'true');
    expect(screen.getByRole('region', { name: 'Sign-In & Sessions' })).not.toHaveAttribute('data-highlight');
  });

  it('shows People & Access whole, and hides the administrator-only subjects from everyone else', async () => {
    render(<AdminConsole activeSub="access" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'People & Access' })).toBeInTheDocument();
    expect(await find('Access panel')).toBeInTheDocument();
    cleanup();

    roleState.admin = false;
    render(<AdminConsole activeSub="access" onSubChange={() => {}} />);
    for (const name of ['People & Access', 'Security', 'Branding & Email', 'Time & Pay']) {
      expect(within(rail()).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // Falls back to the first subject it can show.
    expect(screen.getByRole('heading', { name: 'Companies' })).toBeInTheDocument();
  });

  it('has Shifts & Scheduling with the settings, shift types, groups and weather, all open (Charmi, 09/30)', async () => {
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Shifts & Scheduling' })).toBeInTheDocument();
    for (const t of ['Shift Settings', 'Shift Types', 'Groups', 'Weather Alerts']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(await find('Shift types panel')).toBeInTheDocument();
    // The filter finds them too, from the words a manager would type.
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'swap' } });
    expect(screen.getByText('Shift Settings')).toBeInTheDocument();
    expect(screen.queryByText('Weather Alerts')).not.toBeInTheDocument();
  });

  it('picks a company in the scope box and shows its own faces', async () => {
    const onSubChange = vi.fn();
    const { rerender } = render(<AdminConsole activeSub="hiring" onSubChange={onSubChange} />);
    await screen.findByRole('option', { name: 'Greens Global' }, { timeout: 5000 });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'c1' } });
    expect(onSubChange).toHaveBeenLastCalledWith('hiring@c1');

    rerender(<AdminConsole activeSub="hiring@c1" onSubChange={onSubChange} />);
    expect(screen.getByLabelText('Scope')).toHaveValue('c1');
    expect(screen.getByRole('heading', { name: /Hiring & Onboarding · Greens Global/ })).toBeInTheDocument();
    expect(await find('Company page c1: checklists')).toBeInTheDocument();
    // The organization-wide groups of the subject are one line of links.
    expect(screen.getByText('For every company:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Checklist Library' }));
    expect(onSubChange).toHaveBeenLastCalledWith('hiring:checklist-library');
    // Subjects with nothing per company sit under "For every company" and switch the scope back.
    expect(within(rail()).getByText('For every company')).toBeInTheDocument();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Security' }));
    expect(onSubChange).toHaveBeenLastCalledWith('security');
  });

  it('spreads the old company page over the subjects: profile under Companies, sites under Locations, roles under People & Access', async () => {
    const onSubChange = vi.fn();
    const { rerender } = render(<AdminConsole activeSub="companies@c1" onSubChange={onSubChange} />);
    expect(await find('Company page c1: overview departments holidays')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="locations@c1" onSubChange={onSubChange} />);
    expect(await find('Company page c1: sites')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="access@c1" onSubChange={onSubChange} />);
    expect(await find('Company page c1: roles')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="analytics@c1" onSubChange={onSubChange} />);
    expect(await find('Company page c1: monitoring')).toBeInTheDocument();
  });

  it('hands the picked company to the per-company panels: shifts, pay, tickets, signature (phase 2)', async () => {
    const { rerender } = render(<AdminConsole activeSub="shifts@c1" onSubChange={() => {}} />);
    expect(await find('Shift settings panel c1')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Shifts & Scheduling · Greens Global/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(await find('Weather panel c1')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="pay@c1" onSubChange={() => {}} />);
    expect(screen.queryByRole('heading', { name: 'Pay Rules' })).not.toBeInTheDocument();
    expect(await find('Export codes panel c1')).toBeInTheDocument();
    expect(await find('Premiums panel c1')).toBeInTheDocument();
    // Pay Rules are for every company: a link line, not a group.
    expect(screen.getByRole('button', { name: 'Pay Rules' })).toBeInTheDocument();

    rerender(<AdminConsole activeSub="pay" onSubChange={() => {}} />);
    expect(screen.getByText('Pay Rules')).toBeInTheDocument();
    expect(await find('Export codes panel')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="tickets@c1" onSubChange={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /Routing & Escalation/ })).toBeInTheDocument();
    expect(screen.getByText('Desk panel c1')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="branding@c1" onSubChange={() => {}} />);
    // The signature is the lone group with a company picked, so it renders bare under the subject heading.
    expect(await screen.findByRole('heading', { name: /Branding & Email · Greens Global/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Brand Color' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Brand Color' })).toBeInTheDocument();
  });

  it('opens a company from the list, and offers the companies for a per-company subject', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="companies" onSubChange={onSubChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Greens India' }, { timeout: 5000 }));
    expect(onSubChange).toHaveBeenLastCalledWith('companies@c2');
    cleanup();

    render(<AdminConsole activeSub="analytics" onSubChange={onSubChange} />);
    expect(screen.getByText(/Workforce Analytics Policy is set per company/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Greens Global' }, { timeout: 5000 }));
    expect(onSubChange).toHaveBeenLastCalledWith('analytics:company-policy@c1');
  });

  it('filters groups across every subject', () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Filter settings');

    fireEvent.change(box, { target: { value: 'notifications' } });
    expect(screen.getByText('Ticket Manager')).toBeInTheDocument();
    expect(screen.getByText('Task Notifications')).toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'geofence' } });
    expect(screen.getByText('Location Library')).toBeInTheDocument();
    expect(screen.queryByText('Task Notifications')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'visa expiry' } });
    expect(screen.getByText('HR & Compliance Reminders')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'permissions' } });
    expect(screen.getByRole('heading', { name: 'People & Access' })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'nothing like this' } });
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filter' }));
    expect(screen.getByRole('heading', { name: 'Companies' })).toBeInTheDocument();
  });

  it('swaps the subject rail for a select on phones', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: true, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="companies" onSubChange={onSubChange} />);
    expect(screen.queryByRole('navigation', { name: 'Settings subjects' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'emails' } });
    expect(onSubChange).toHaveBeenLastCalledWith('emails');
  });
});
