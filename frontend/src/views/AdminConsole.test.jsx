import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';

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
// Who is looking: an IT Admin by default. `grants` = Access Group grants by
// module ({ hr: 'editor' }); `hrScope` = the companies their People access is
// limited to (null = company-wide); `hrTeam` = the manager tier (own team).
const LEVELS = { employee: 1, supervisor: 2, manager: 3, administrator: 4, owner: 5 };
const RANKS = { viewer: 1, editor: 2, full: 3, owner: 4 };
const roleState = { role: 'administrator', grants: {}, hrScope: null, hrTeam: false };
const asRole = (role, extra = {}) => Object.assign(roleState, { role, grants: {}, hrScope: null, hrTeam: false }, extra);
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: (min) => LEVELS[roleState.role] >= (LEVELS[min] ?? 1),
    canAccessModule: (m, minRole, lvl = 'viewer') => LEVELS[roleState.role] >= (LEVELS[minRole] ?? 1)
      || (RANKS[roleState.grants[m]] ?? 0) >= (RANKS[lvl] ?? 1),
    hrScope: roleState.hrScope, hrTeam: roleState.hrTeam,
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
  ShiftSettingsPanel: ({ company, part }) => <div>Shift settings panel{part ? ` ${part}` : ''}{company ? ` ${company}` : ''}</div>,
  ShiftTypesPanel: () => <div>Shift types panel</div>,
  ShiftGroupsPanel: () => <div>Groups panel</div>,
  TimeOffReasons: () => <div>Time-off reasons panel</div>,
}));
// The weather panel can stand in for any form with unsaved changes: it
// reports `dirtyState.weather` through the shared hook (lib/groupDirty.js).
const dirtyState = { weather: false };
vi.mock('../components/shifts/WeatherSettings', async () => {
  const { useGroupDirty } = await import('../lib/groupDirty');
  return { default: function WeatherPanel({ company }) { useGroupDirty(dirtyState.weather); return <div>Weather panel{company ? ` ${company}` : ''}</div>; } };
});
// With a company fixed, the export codes say the company has names of its own.
vi.mock('../components/PayrollExportCodes', async () => {
  const { useEffect } = await import('react');
  return { default: function ExportCodes({ company, onOverride }) {
    useEffect(() => { if (company) onOverride?.(true); }, [company, onOverride]);
    return <div>Export codes panel{company ? ` ${company}` : ''}</div>;
  } };
});
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
// Phase 3: the strays, borrowed from their home modules.
vi.mock('../components/PayrollReadiness', () => ({ ReadinessThresholds: ({ company }) => <div>Readiness panel{company ? ` ${company}` : ''}</div> }));
vi.mock('../components/CaReview', () => ({ MinWageForm: () => <div>Minimum wage panel</div> }));
vi.mock('../components/LeaveBalances', () => ({ LeaveSetup: () => <div>Leave policies panel</div> }));
vi.mock('../components/IntacctEmployeeCodes', () => ({ IntacctNightlySync: ({ company }) => <div>Intacct panel{company ? ` ${company}` : ''}</div> }));
vi.mock('../components/DocumentTemplates', () => ({ LetterheadsPanel: () => <div>Letterheads panel</div> }));
vi.mock('./SettingsPanels', () => ({
  TicketPropertyRulesPanel: () => <div>Property rules panel</div>,
  UnitRulesPanel: () => <div>Unit rules panel</div>,
  AppRatingsPanel: () => <div>App ratings panel</div>,
}));
vi.mock('../components/EmployeeCustomFieldsSettings', () => ({ default: ({ company }) => <div>More details panel{company ? ` ${company}` : ''}</div> }));

const AdminConsole = (await import('./AdminConsole')).default;

afterEach(() => { cleanup(); vi.restoreAllMocks(); asRole('administrator'); dirtyState.weather = false; });

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
    expect(screen.getByLabelText('Applies To')).toHaveValue('');
    const names = within(rail()).getAllByRole('button').map(b => b.textContent);
    expect(names).toEqual(['Companies', 'Locations', 'People & Access', 'Security', 'Branding & Email', 'Emails & Reminders',
      'Tickets', 'Time & Pay', 'Workforce Analytics', 'Shifts & Scheduling', 'Hiring & Onboarding', 'Performance', 'Items & Equipment', 'Operations', 'Workflows']);
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
    expect(screen.queryByLabelText('Applies To')).not.toBeInTheDocument();
  });

  it('keeps every scheduled email in Emails & Reminders, open, and Ticket Manager under Tickets', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="emails" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Emails & Reminders' })).toBeInTheDocument();
    for (const t of ['Task Notifications', 'Daily Briefing', 'Weekly Digest', 'Workforce Scorecard', 'HR & Compliance Reminders', 'Equipment Reminders']) {
      expect(screen.getByRole('region', { name: t })).toBeInTheDocument();
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

    // The manager tier (own team, no grants): the groups a manager may save -
    // task emails, the ticket desk, item types, app ratings, unit rules - and
    // nothing that is a People route or an administrator's.
    asRole('manager', { hrTeam: true, hrScope: [] });
    render(<AdminConsole activeSub="access" onSubChange={() => {}} />);
    for (const name of ['People & Access', 'Security', 'Branding & Email', 'Time & Pay', 'Companies', 'Locations', 'Hiring & Onboarding', 'Shifts & Scheduling']) {
      expect(within(rail()).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    for (const name of ['Emails & Reminders', 'Tickets', 'Items & Equipment', 'Workforce Analytics', 'Operations']) {
      expect(within(rail()).getByRole('button', { name })).toBeInTheDocument();
    }
    // Falls back to the first subject it can show, with only its open group
    // (a lone group renders bare under the subject heading).
    expect(screen.getByRole('heading', { name: 'Emails & Reminders' })).toBeInTheDocument();
    expect(await find('Task notify panel')).toBeInTheDocument();
    expect(screen.queryByText('Daily Briefing')).not.toBeInTheDocument();
  });

  it('opens each group for exactly who its save route lets in (the registry gates, Oct 23)', async () => {
    // A supervisor with a People (hr) editor grant limited to Greens Global:
    // Companies, Locations, Shifts and Hiring are theirs - with their company
    // picked. At Every company the library, the shared records and the
    // tenant defaults are not, so the page says to pick the company.
    asRole('supervisor', { grants: { hr: 'editor' }, hrScope: ['c1'] });
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    // (Branding & Email stays: the company's Email Signature is a People route;
    // People & Access too: its More Details Fields are HR's, Oct 27 2026.)
    for (const name of ['Companies', 'Locations', 'People & Access', 'Shifts & Scheduling', 'Hiring & Onboarding', 'Branding & Email']) {
      expect(within(rail()).getByRole('button', { name })).toBeInTheDocument();
    }
    for (const name of ['Security', 'Tickets', 'Items & Equipment', 'Operations']) {
      expect(within(rail()).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/set per company for you - pick one in the Scope box/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Shift Types' })).not.toBeInTheDocument();
    cleanup();
    render(<AdminConsole activeSub="shifts@c1" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Shift Types' })).toBeInTheDocument();
    expect(await find('Shift settings panel basics c1')).toBeInTheDocument();
    // Weather Alerts are set for every company at once: company-wide access only.
    expect(screen.queryByRole('region', { name: 'Weather Alerts' })).not.toBeInTheDocument();
    cleanup();
    // People & Access for them is More Details Fields, with their company
    // picked - never the access groups, which are administrators' alone.
    render(<AdminConsole activeSub="access@c1" onSubChange={() => {}} />);
    expect(await find('More details panel c1')).toBeInTheDocument();
    expect(screen.queryByText('Access panel')).not.toBeInTheDocument();
    cleanup();

    // An Operations editor grant (any tier) opens Unit Rules, not Push to Cubby.
    asRole('employee', { grants: { operations: 'editor' } });
    render(<AdminConsole activeSub="operations" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Operations' })).toBeInTheDocument();
    expect(await find('Unit rules panel')).toBeInTheDocument();
    expect(screen.queryByText('Push to Cubby')).not.toBeInTheDocument();
    expect(within(rail()).queryByRole('button', { name: 'Tickets' })).not.toBeInTheDocument();
  });

  it('asks before leaving a group with unsaved changes - another subject, scope or top tab (one save pattern, Oct 23)', async () => {
    const { hasUnsavedWork } = await import('../lib/dialogGuard');
    dirtyState.weather = true;
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="shifts" onSubChange={onSubChange} />);
    expect(await find('Weather panel')).toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(true);   // the sidebar and the browser tab ask too
    fireEvent.click(within(rail()).getByRole('button', { name: 'Companies' }));
    expect(onSubChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
    expect(onSubChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Applies To'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    expect(onSubChange).toHaveBeenCalledWith('shifts@c1');
    cleanup();
    render(<AdminConsole activeSub="shifts" onSubChange={onSubChange} />);
    expect(await find('Weather panel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Tools$/ }));
    expect(onSubChange).not.toHaveBeenCalledWith('tools');
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    expect(onSubChange).toHaveBeenCalledWith('tools');
    cleanup();
    expect(hasUnsavedWork()).toBe(false);   // unmounted: nothing left to guard
  });

  it('has Shifts & Scheduling with the settings, shift types, groups and weather, all open (Charmi, 09/30)', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="shifts" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Shifts & Scheduling' })).toBeInTheDocument();
    // Oct 25: the one long Shift Settings card is six groups, each a slice of the same panel.
    for (const t of ['Schedule Basics', 'Requests & Visibility', 'Attendance', 'Overtime Alerts', 'Rules', 'Sharing', 'Shift Types', 'Groups', 'Weather Alerts']) {
      expect(screen.getByRole('region', { name: t })).toBeInTheDocument();
    }
    expect(await find('Shift settings panel rules')).toBeInTheDocument();
    expect(await find('Shift types panel')).toBeInTheDocument();
    // The Location Trail moved to Workforce Analytics.
    expect(screen.queryByRole('region', { name: 'Location Trail' })).not.toBeInTheDocument();
    // The filter finds them too, from the words a manager would type.
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'swap' } });
    expect(screen.getByRole('region', { name: 'Requests & Visibility' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weather Alerts' })).not.toBeInTheDocument();
  });

  it('lands the old shift-settings link on Schedule Basics, and the rail jumps to a group', () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="shifts:shift-settings" onSubChange={onSubChange} />);
    expect(screen.getByRole('region', { name: 'Schedule Basics' })).toHaveAttribute('data-highlight', 'true');
    const links = within(rail()).getByLabelText('Shifts & Scheduling settings');
    expect(within(links).getByRole('button', { name: 'Schedule Basics' })).toHaveAttribute('aria-current', 'location');
    // A jump scrolls and marks the link; it adds no history entry.
    fireEvent.click(within(links).getByRole('button', { name: 'Rules' }));
    expect(within(links).getByRole('button', { name: 'Rules' })).toHaveAttribute('aria-current', 'location');
    expect(onSubChange).not.toHaveBeenCalled();
    // A subject with one group lists nothing under it.
    cleanup();
    render(<AdminConsole activeSub="items" onSubChange={() => {}} />);
    expect(within(rail()).queryByLabelText('Items & Equipment settings')).not.toBeInTheDocument();
  });

  it('puts the Location Trail under Workforce Analytics, for every company and for one', async () => {
    const { rerender } = render(<AdminConsole activeSub="analytics" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Location Trail' })).toBeInTheDocument();
    expect(await find('Shift settings panel trail')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="analytics@c1" onSubChange={() => {}} />);
    expect(await find('Shift settings panel trail c1')).toBeInTheDocument();
  });

  it('lists the companies and where each stands for a per-company setting, instead of a select in the panel', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="pay" onSubChange={onSubChange} />);
    const codes = screen.getByRole('region', { name: 'Payroll Export Codes' });
    expect(within(codes).queryByText('Export codes panel')).not.toBeInTheDocument();
    expect(await within(codes).findAllByText('Default Codes', {}, { timeout: 5000 })).toHaveLength(2);
    expect(await within(screen.getByRole('region', { name: /Shift Differentials/ })).findAllByText('Off')).toHaveLength(2);
    fireEvent.click(within(codes).getByRole('button', { name: /Greens India/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('pay:payroll-export-codes@c2');
    // A layered setting keeps its default editor and says who has their own.
    expect(await within(screen.getByRole('region', { name: 'Pay Rules' })).findByText('Every company follows this default.', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('says what a picked company does differently in the subject, with jump links', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="pay@c1" onSubChange={onSubChange} />);
    const line = (await screen.findByText(/Different for Greens Global/, {}, { timeout: 5000 })).parentElement;
    fireEvent.click(within(line).getByRole('button', { name: 'Payroll Export Codes' }));
    expect(within(within(rail()).getByLabelText('Time & Pay settings')).getByRole('button', { name: 'Payroll Export Codes' })).toHaveAttribute('aria-current', 'location');
    // Its own group's chip says so too: a per-company setting reads Custom, not Overridden.
    expect(within(screen.getByRole('region', { name: 'Payroll Export Codes' })).getByText('Custom')).toBeInTheDocument();
  });

  it('picks a company in the scope box and shows its own faces', async () => {
    const onSubChange = vi.fn();
    const { rerender } = render(<AdminConsole activeSub="hiring" onSubChange={onSubChange} />);
    await screen.findByRole('option', { name: 'Greens Global' }, { timeout: 5000 });
    fireEvent.change(screen.getByLabelText('Applies To'), { target: { value: 'c1' } });
    expect(onSubChange).toHaveBeenLastCalledWith('hiring@c1');

    rerender(<AdminConsole activeSub="hiring@c1" onSubChange={onSubChange} />);
    await waitFor(() => expect(screen.getByLabelText('Applies To')).toHaveValue('c1'));   // the company list loads on its own
    expect(screen.getByRole('heading', { name: 'Hiring & Onboarding' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to every company' })).toBeInTheDocument();
    expect(await find('Company page c1: checklists')).toBeInTheDocument();
    // The organization-wide groups of the subject are one line of links.
    expect(screen.getByText('Set for every company:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Checklist Library' }));
    expect(onSubChange).toHaveBeenLastCalledWith('hiring:checklist-library');
    // Subjects with nothing per company stay in place, marked, and switch the scope back.
    expect(within(rail()).getByRole('button', { name: 'Security' })).toHaveAttribute('title', 'Set for every company - opens at Every company');
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
    expect(await find('Shift settings panel basics c1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shifts & Scheduling' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Applies To')).toHaveValue('c1'));   // the company list loads on its own
    expect(await find('Weather panel c1')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="pay@c1" onSubChange={() => {}} />);
    // Pay Rules are per company too since phase 4 - the group stays, with the company's own.
    expect(screen.getByRole('heading', { name: 'Pay Rules' })).toBeInTheDocument();
    expect(await find('Export codes panel c1')).toBeInTheDocument();
    expect(await find('Premiums panel c1')).toBeInTheDocument();
    expect(within(screen.getByText('Set for every company:').parentElement).queryByRole('button', { name: 'Pay Rules' })).not.toBeInTheDocument();

    rerender(<AdminConsole activeSub="pay" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Pay Rules' })).toBeInTheDocument();

    rerender(<AdminConsole activeSub="tickets@c1" onSubChange={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /Routing & Escalation/ })).toBeInTheDocument();
    expect(screen.getByText('Desk panel c1')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="branding@c1" onSubChange={() => {}} />);
    // The signature is the lone group with a company picked, so it renders bare under the subject heading.
    expect(await screen.findByRole('heading', { name: 'Branding & Email' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Brand Color' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Brand Color' })).toBeInTheDocument();
  });

  it('brings the strays home: readiness, minimum wage, leave, time-off reasons, Intacct, letterheads, property rules, unit rules, ratings (phase 3)', async () => {
    const { rerender } = render(<AdminConsole activeSub="pay" onSubChange={() => {}} />);
    for (const t of ['Pay Rules', 'Payroll Readiness', 'California Minimum Wage', 'Leave Policies', 'Time-Off Reasons', 'Intacct Nightly Sync']) {
      expect(screen.getByRole('heading', { name: t })).toBeInTheDocument();
    }
    expect(await find('Readiness panel')).toBeInTheDocument();
    expect(await find('Time-off reasons panel')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="pay@c1" onSubChange={() => {}} />);
    expect(await find('Readiness panel c1')).toBeInTheDocument();
    expect(await find('Intacct panel c1')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'California Minimum Wage' })).not.toBeInTheDocument();

    rerender(<AdminConsole activeSub="branding:letterheads" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Letterheads' })).toHaveAttribute('data-highlight', 'true');
    expect(await find('Letterheads panel')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="tickets" onSubChange={() => {}} />);
    expect(await find('Property rules panel')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="operations" onSubChange={() => {}} />);
    expect(await find('Unit rules panel')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="analytics" onSubChange={() => {}} />);
    expect(await find('App ratings panel')).toBeInTheDocument();
    // The per-company policy is reached through the scope box, not a picker here.
    expect(screen.queryByText(/is set per company/)).not.toBeInTheDocument();
  });

  it('opens a company from the list, and offers the companies for a per-company subject', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="companies" onSubChange={onSubChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Greens India' }, { timeout: 5000 }));
    expect(onSubChange).toHaveBeenLastCalledWith('companies@c2');
    cleanup();

    render(<AdminConsole activeSub="analytics@c1" onSubChange={onSubChange} />);
    expect(await find('Company page c1: monitoring')).toBeInTheDocument();
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

  it('opens on a list of the subjects on phones, and a subject has a way back', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: true, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    }));
    const onSubChange = vi.fn();
    const { rerender } = render(<AdminConsole activeSub="settings" onSubChange={onSubChange} />);
    expect(screen.queryByRole('navigation', { name: 'Settings subjects' })).not.toBeInTheDocument();
    for (const sec of ['Organization', 'Communication', 'Workforce', 'Operations']) expect(screen.getByRole('group', { name: sec })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Emails & Reminders/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('emails');

    rerender(<AdminConsole activeSub="emails" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Emails & Reminders' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /All Settings/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('settings');
  });
});
