import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';

// Settings (AdminConsole, one tab since Oct 23 2026): a rail of subjects, a
// scope picker (Every company / one company), every group open, old links
// still landing somewhere sensible, and the filter searching every subject.

// Every api call resolves empty, except the companies the scope picker lists.
// `apiOverrides` lets a test answer one call its own way (reset after each).
const COMPANIES = [{ id: 'c1', name: 'Greens Global' }, { id: 'c2', name: 'Greens India' }];
// `entities`: how the company list answers ('ok', 'denied' = a 403 from People,
// 'error' = a failed load); the Workforce Analytics fallback list answers
// `trackingCompanies` (or 403 when null). `apiOverrides` lets a test answer
// one call its own way (reset after each).
const apiState = { entities: 'ok', trackingCompanies: null, added: [] };
const apiOverrides = {};
const refusal = () => Object.assign(new Error('Forbidden'), { status: 403 });
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (
    k in apiOverrides ? apiOverrides[k]
    : k === 'getEntitiesFresh' ? () => Promise.resolve([...COMPANIES, ...apiState.added])
    : k === 'getEntities' ? () => (apiState.entities === 'ok' ? Promise.resolve(COMPANIES)
      : Promise.reject(apiState.entities === 'denied' ? refusal() : Object.assign(new Error('Network'), { status: 502 })))
      : k === 'timeMonitoringCompanies' ? () => (apiState.trackingCompanies ? Promise.resolve(apiState.trackingCompanies) : Promise.reject(refusal()))
        : k === 'getMyTicketAccess' ? () => Promise.resolve({ canManageDesk: roleState.desk ?? (LEVELS[roleState.role] >= 3) })
          : k === 'getEntitySignatureTemplates' ? () => Promise.resolve({ templates: [], template: 'classic' })
            : vi.fn(() => Promise.resolve([]))) }),
}));
// Who is looking: an Administrator by default. `grants` = Access Group grants by
// module ({ hr: 'editor' }); `hrScope` = the companies their People access is
// limited to (null = company-wide); `hrTeam` = the manager tier (own team);
// `manageCompanies` = the companies whose shift / pay settings they may change
// (null = company-wide, /roles/me); `companyWalled` = a company wall confines
// them; `desk` = a ticket desk supervisor (by default the manager tier and up).
const LEVELS = { employee: 1, supervisor: 2, manager: 3, administrator: 4, owner: 5 };
const RANKS = { viewer: 1, editor: 2, full: 3, owner: 4 };
const ROLE_DEFAULTS = { grants: {}, hrScope: null, hrTeam: false, manageCompanies: null, manageCompanyRows: [], companyWalled: false, isGlobalAdmin: false, hrContactFor: [], desk: undefined };
// The default viewer is an Administrator in a group flagged is_global_admin: a
// Super Administrator's reach, so every group opens (asRole resets it).
const roleState = { role: 'administrator', ...ROLE_DEFAULTS, isGlobalAdmin: true };
const asRole = (role, extra = {}) => Object.assign(roleState, { role, ...ROLE_DEFAULTS }, extra);
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: (min) => LEVELS[roleState.role] >= (LEVELS[min] ?? 1),
    canAccessModule: (m, minRole, lvl = 'viewer') => LEVELS[roleState.role] >= (LEVELS[minRole] ?? 1)
      || (RANKS[roleState.grants[m]] ?? 0) >= (RANKS[lvl] ?? 1),
    hrScope: roleState.hrScope, hrTeam: roleState.hrTeam,
    manageCompanies: roleState.manageCompanies, manageCompanyRows: roleState.manageCompanyRows,
    companyWalled: roleState.companyWalled, isGlobalAdmin: roleState.isGlobalAdmin, hrContactFor: roleState.hrContactFor,
    myGrantedModules: new Map(Object.entries(roleState.grants)), actingAs: null,
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
  ShiftSettingsPanel: ({ company, part, onOpenLeave }) => (
    <div>Shift settings panel{part ? ` ${part}` : ''}{company ? ` ${company}` : ''}
      {onOpenLeave && <button onClick={onOpenLeave}>Open Time Off & Leave</button>}</div>
  ),
  ShiftTypesPanel: () => <div>Shift types panel</div>,
  ShiftGroupsPanel: () => <div>Groups panel</div>,
  TimeOffReasons: () => <div>Time-off reasons panel</div>,
}));
// The weather panel can stand in for any form with unsaved changes: it
// reports `dirtyState.weather` through the shared hook (lib/groupDirty.js).
const dirtyState = { weather: false };
// Its "Weather note" box is a typed draft of its own, to prove a draft
// survives the filter and that Discard really drops it.
vi.mock('../components/shifts/WeatherSettings', async () => {
  const { useGroupDirty } = await import('../lib/groupDirty');
  const { useState } = await import('react');
  return { default: function WeatherPanel({ company }) {
    const [note, setNote] = useState('');
    useGroupDirty(dirtyState.weather || note !== '');
    return <div>Weather panel{company ? ` ${company}` : ''}<input aria-label="Weather note" value={note} onChange={e => setNote(e.target.value)} /></div>;
  } };
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
vi.mock('../holidays/HolidayPoliciesPanel', () => ({ default: () => <div>Holiday policies panel</div> }));
vi.mock('../components/EmployeeCustomFieldsSettings', () => ({ default: ({ company }) => <div>More details panel{company ? ` ${company}` : ''}</div> }));

const AdminConsole = (await import('./AdminConsole')).default;

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); asRole('administrator', { isGlobalAdmin: true }); dirtyState.weather = false;
  Object.assign(apiState, { entities: 'ok', trackingCompanies: null, added: [] });
  for (const k of Object.keys(apiOverrides)) delete apiOverrides[k];
});

const rail = () => screen.getByRole('navigation', { name: 'Settings subjects' });
// Lazy panels on a slow machine: give a find a little longer than the default second.
const find = (text) => screen.findByText(text, {}, { timeout: 5000 });

describe('AdminConsole', () => {
  it('holds the company list with a skeleton until the companies are in - never "No companies yet" first', async () => {
    let answer;
    apiOverrides.getEntities = () => new Promise((r) => { answer = r; });
    const { container } = render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    expect(rail()).toBeInTheDocument();                       // the frame is there at once
    expect(screen.queryByText('Company list')).not.toBeInTheDocument();
    expect(container.querySelector('.nx-skel')).toBeTruthy();
    await act(async () => { answer(COMPANIES); });
    expect(await find('Company list')).toBeInTheDocument();
  });

  it('has one General tab beside Tools and Logs - no Global or Company Settings tabs', () => {
    // "General", not "Settings": the bar already names the module (Neil, 11/06/2026).
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    for (const name of ['General', 'Tools', 'Logs']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}$`) })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Global Settings|Company Settings|Audit Logs/ })).not.toBeInTheDocument();
  });

  it('opens on Companies at Every company, with every subject in the rail', async () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Companies', level: 3 })).toBeInTheDocument();
    expect(await find('Company list')).toBeInTheDocument();
    // Holiday Policies moved to Time Off & Leave (11/02/2026): the list is
    // the lone group, so it renders bare and the rail lists no jump links -
    // "Companies" is said once, not three times.
    expect(screen.queryByRole('region', { name: 'Holiday Policies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Companies', level: 4 })).not.toBeInTheDocument();
    expect(within(rail()).queryByRole('group', { name: 'Companies settings' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Applies To')).toHaveValue('');
    const names = within(rail()).getAllByRole('button').filter(b => b.classList.contains('nx-set-rail-item')).map(b => b.textContent);
    expect(names).toEqual(['Companies', 'Locations', 'People & Access', 'Security', 'Branding & Email', 'Emails & Reminders',
      'Tickets', 'Time & Pay', 'Time Off & Leave', 'Workforce Analytics', 'Shifts & Scheduling', 'Hiring & Onboarding', 'Performance', 'Items & Equipment', 'Operations', 'Workflows', 'Notes & Boards']);
    expect(screen.queryByText('For every company')).not.toBeInTheDocument();
  });

  it.each([
    ['settings', 'Companies'], ['global', 'Companies'], ['company', 'Companies'],
    ['global-notifications', 'Emails & Reminders'], ['global-service-desk', 'Tickets'], ['global-tasks', 'Emails & Reminders'],
    ['global-timeclock', 'Time & Pay'], ['global-branding', 'Branding & Email'], ['global-hiring', 'Hiring & Onboarding'],
    ['global-shifts', 'Shifts & Scheduling'], ['access', 'People & Access'], ['global-access', 'People & Access'],
    ['nonsense', 'Companies'],
    // The leave groups and Holiday Policies moved (11/02/2026): their old links land on Time Off & Leave.
    ['pay', 'Time & Pay'], ['pay:leave-policies', 'Time Off & Leave'], ['pay:time-off-reasons', 'Time Off & Leave'],
    ['pay:leave-year-end', 'Time Off & Leave'], ['pay:timeoff-approval', 'Time Off & Leave'],
    ['companies:holiday-policies', 'Time Off & Leave'], ['pay:payroll-readiness', 'Time & Pay'],
  ])('lands the old "%s" link on %s', (sub, heading) => {
    render(<AdminConsole activeSub={sub} onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: heading, level: 3 })).toBeInTheDocument();
  });

  it.each([
    ['pay:leave-policies', 'Leave Policies', ''],
    ['pay:time-off-reasons@c1', 'Time Off Reasons', 'c1'],
    ['pay:timeoff-approval@c2', 'Time Off Approval', 'c2'],
    ['pay:leave-year-end@c1', 'Leave Year-End', 'c1'],
    ['companies:holiday-policies', 'Holiday Policies', ''],
  ])('lands "%s" on its group in Time Off & Leave, with the company kept', async (sub, group, company) => {
    render(<AdminConsole activeSub={sub} onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Time Off & Leave', level: 3 })).toBeInTheDocument();
    // (A company's panels mount once the company list has it.)
    expect(await screen.findByRole('region', { name: group }, { timeout: 5000 })).toHaveAttribute('data-highlight', 'true');
    await waitFor(() => expect(screen.getByLabelText('Applies To')).toHaveValue(company));
  });

  it('has Time Off & Leave with the leave groups and Holiday Policies, in order; Time & Pay keeps the pay groups', async () => {
    const { rerender } = render(<AdminConsole activeSub="leave" onSubChange={() => {}} />);
    const links = within(rail()).getByLabelText('Time Off & Leave settings');
    expect(within(links).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Leave Policies', 'Time Off Reasons', 'Time Off Approval', 'Leave Year-End', 'Holiday Policies']);
    expect(await find('Leave policies panel')).toBeInTheDocument();
    expect(await find('Holiday policies panel')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="pay" onSubChange={() => {}} />);
    expect(within(within(rail()).getByLabelText('Time & Pay settings')).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Pay Rules', 'Payroll Export Codes', 'Shift Differentials & Call-Back Pay', 'India Contractor Policy', 'Payroll Readiness', 'California Minimum Wage', 'Intacct Nightly Sync']);

    // With a company picked: its own time off reasons, year end and approval;
    // the organization-wide groups are one line of links.
    rerender(<AdminConsole activeSub="leave@c1" onSubChange={() => {}} />);
    for (const t of ['Time Off Reasons', 'Time Off Approval', 'Leave Year-End']) expect(screen.getByRole('heading', { name: t })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Leave Policies' })).not.toBeInTheDocument();
    const also = screen.getByText('Set for every company:').parentElement;
    expect(within(also).getByRole('button', { name: 'Leave Policies' })).toBeInTheDocument();
    expect(within(also).getByRole('button', { name: 'Holiday Policies' })).toBeInTheDocument();
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

  it('switches Ticket Manager panels with tabs, keeping an opened panel mounted', async () => {
    render(<AdminConsole activeSub="tickets" onSubChange={() => {}} />);
    // The desk role arrives from /task-tickets/my-access, a beat after the page.
    expect(await screen.findByRole('tab', { name: /Routing & Escalation/ })).toHaveAttribute('aria-selected', 'true');
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
    // task emails, the ticket desk, item types, unit rules - and nothing that
    // is a People route, an administrator's, or Workforce Analytics' (app
    // ratings take its full grant since Oct 29 2026 - monitoring data is for
    // its grant holders only).
    asRole('manager', { hrTeam: true, hrScope: [], manageCompanies: [] });
    render(<AdminConsole activeSub="access" onSubChange={() => {}} />);
    expect(await within(rail()).findByRole('button', { name: 'Tickets' })).toBeInTheDocument();
    for (const name of ['People & Access', 'Security', 'Branding & Email', 'Time & Pay', 'Companies', 'Locations', 'Hiring & Onboarding', 'Shifts & Scheduling', 'Workforce Analytics']) {
      expect(within(rail()).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    for (const name of ['Emails & Reminders', 'Tickets', 'Items & Equipment', 'Operations']) {
      expect(within(rail()).getByRole('button', { name })).toBeInTheDocument();
    }
    // Falls back to the first subject it can show, with only its open group
    // (a lone group renders bare under the subject heading).
    expect(screen.getByRole('heading', { name: 'Emails & Reminders' })).toBeInTheDocument();
    expect(await find('Task notify panel')).toBeInTheDocument();
    expect(screen.queryByText('Daily Briefing')).not.toBeInTheDocument();
  });

  it('Kudos Values is HR\'s; the Kudos on Teams group opens to a Super Administrator alone (mayOpen is the one rule, 11/08/2026)', async () => {
    apiOverrides.perfSettings = () => Promise.resolve({ settings: { kudosValues: ['Ownership'], kudosTeamsChatId: '', kudosTeams: {} }, canEdit: true, override: false, companies: [] });
    asRole('administrator', { isGlobalAdmin: false });
    render(<AdminConsole activeSub="performance" onSubChange={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Kudos Values' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Kudos on Teams' })).not.toBeInTheDocument();
    cleanup();
    asRole('administrator', { isGlobalAdmin: true });
    render(<AdminConsole activeSub="performance" onSubChange={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Kudos on Teams' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Kudos Values' })).toBeInTheDocument();
  });

  it('opens each group for exactly who its save route lets in (the registry gates, Oct 23)', async () => {
    // A supervisor with a People (hr) editor grant limited to Greens Global:
    // Companies, Locations and Hiring are theirs - with their company picked
    // (the Holiday Policies and the Location Library accept them at Every
    // company too). The shift settings are not: they save through
    // require_shift_manage, the manager tier and up (11/02/2026).
    asRole('supervisor', { grants: { hr: 'editor' }, hrScope: ['c1'], manageCompanies: ['c1'], desk: false });
    render(<AdminConsole activeSub="hiring" onSubChange={() => {}} />);
    // (Branding & Email stays: the company's Email Signature is a People route;
    // People & Access too: its More Details Fields are HR's, Oct 27 2026.)
    for (const name of ['Companies', 'Locations', 'People & Access', 'Hiring & Onboarding', 'Branding & Email']) {
      expect(within(rail()).getByRole('button', { name })).toBeInTheDocument();
    }
    for (const name of ['Security', 'Tickets', 'Items & Equipment', 'Operations', 'Shifts & Scheduling']) {
      expect(within(rail()).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    cleanup();
    // Holiday Policies live under Time Off & Leave since 11/02/2026; the
    // company list, now Companies' lone group, renders bare.
    // For them it is the subject's one group at Every company, so it renders bare.
    render(<AdminConsole activeSub="leave" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Time Off & Leave', level: 3 })).toBeInTheDocument();
    expect(await find('Holiday policies panel')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Leave Policies' })).not.toBeInTheDocument();
    cleanup();
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    expect(await find('Company list')).toBeInTheDocument();
    cleanup();
    render(<AdminConsole activeSub="locations" onSubChange={() => {}} />);
    expect(await find('Site list')).toBeInTheDocument();
    cleanup();

    // A manager whose reach is Greens Global: the shift settings with their
    // company picked; at Every company the tenant defaults are not theirs, so
    // the page says to pick the company.
    asRole('manager', { grants: { hr: 'editor' }, hrScope: ['c1'], manageCompanies: ['c1'] });
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(within(rail()).getByRole('button', { name: 'Shifts & Scheduling' })).toBeInTheDocument();
    expect(screen.getByText(/set per company for you - pick one in Applies To/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Shift Types' })).not.toBeInTheDocument();
    cleanup();
    render(<AdminConsole activeSub="shifts@c1" onSubChange={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Shift Types' }, { timeout: 5000 })).toBeInTheDocument();
    expect(await find('Shift settings panel basics c1')).toBeInTheDocument();
    // Weather Alerts are set for every company at once: company-wide access only.
    expect(screen.queryByRole('region', { name: 'Weather Alerts' })).not.toBeInTheDocument();
    // The labor budget is HR++'s: an Editor People grant is not.
    expect(screen.queryByRole('region', { name: 'Labor Budget' })).not.toBeInTheDocument();
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

  it('keeps a draft through the filter: hidden groups stay mounted (no lost edits, 11/02/2026)', async () => {
    const { hasUnsavedWork } = await import('../lib/dialogGuard');
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Weather note', {}, { timeout: 5000 }), { target: { value: 'rain' } });
    const box = screen.getByLabelText('Filter settings');
    fireEvent.change(box, { target: { value: 'swap' } });
    expect(screen.queryByRole('region', { name: 'Weather Alerts' })).not.toBeInTheDocument();   // hidden...
    expect(hasUnsavedWork()).toBe(true);                                                       // ...and still unsaved
    fireEvent.change(box, { target: { value: 'weather' } });
    expect(screen.getByLabelText('Weather note')).toHaveValue('rain');
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByLabelText('Weather note')).toHaveValue('rain');
    // A search result from another subject, edited, then filtered away, keeps its draft too.
    fireEvent.change(box, { target: { value: 'nothing like this' } });
    fireEvent.change(box, { target: { value: 'weather' } });
    expect(screen.getByLabelText('Weather note')).toHaveValue('rain');
  });

  it('a lone group (bare) keeps its panel when a search turns it into a result', async () => {
    render(<AdminConsole activeSub="items" onSubChange={() => {}} />);
    const before = document.querySelector('[data-setting-group="item-types"] section');
    expect(before).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'item types' } });
    expect(document.querySelector('[data-setting-group="item-types"] section')).toBe(before);
  });

  it('names the unsaved group in the prompt, and Discard really drops the draft', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="shifts" onSubChange={onSubChange} />);
    fireEvent.change(await screen.findByLabelText('Weather note', {}, { timeout: 5000 }), { target: { value: 'rain' } });
    // The subject already on screen: nothing unmounts, nothing to ask.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Shifts & Scheduling' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onSubChange).not.toHaveBeenCalled();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Companies' }));
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText(/Your changes to Weather Alerts on this page have not been saved/)).toBeInTheDocument();
    expect(ask.querySelector('.modal-content').className).not.toContain('nx-popup');
    // The weather panel cannot save itself from here: no Save and Leave.
    expect(within(ask).queryByRole('button', { name: 'Save and Leave' })).not.toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Discard Changes' }));
    expect(onSubChange).toHaveBeenCalledWith('companies');
    expect(await screen.findByLabelText('Weather note')).toHaveValue('');
  });

  // Pay Rules (Neil, 11/02/2026): a switch saves on click with an Undo toast
  // that writes the previous value back; the minutes are one draft, and a
  // save that fails for one rule keeps that rule's edits.
  function payRules({ rounding = {}, autoLunch = {} } = {}) {
    const rules = {
      rounding: { enabled: false, nearestMin: 5, ...rounding },
      autoLunch: { enabled: true, afterMin: 360, deductMin: 30, ...autoLunch },
      breakPolicy: { enabled: false, paidBreakMin: 10, restMaxMin: 20, longBreakMin: 75 },
    };
    apiOverrides.timeRoundingGet = () => Promise.resolve(rules.rounding);
    apiOverrides.timeAutoLunchGet = () => Promise.resolve(rules.autoLunch);
    apiOverrides.timeBreakPolicyGet = () => Promise.resolve(rules.breakPolicy);
    apiOverrides.timeRoundingSet = vi.fn((body) => Promise.resolve({ ...body }));
    apiOverrides.timeAutoLunchSet = vi.fn((body) => Promise.resolve({ ...body }));
    apiOverrides.timeBreakPolicySet = vi.fn((body) => Promise.resolve({ ...body }));
    return rules;
  }

  it('Pay Rules: a switch saves on click, with an Undo that writes the old value back', async () => {
    payRules();
    const { dialog } = await import('../ui/dialog');
    const undo = vi.spyOn(dialog, 'undo').mockImplementation(() => {});
    render(<AdminConsole activeSub="pay:timeclock-policy" onSubChange={() => {}} />);
    const sw = await screen.findByRole('switch', { name: 'Punch Rounding' }, { timeout: 5000 });
    fireEvent.click(sw);
    await waitFor(() => expect(apiOverrides.timeRoundingSet).toHaveBeenCalledWith({ enabled: true, nearestMin: 5 }, ''));
    await waitFor(() => expect(undo).toHaveBeenCalled());
    expect(undo.mock.calls[0][0]).toBe('Punch rounding turned on.');
    const region = screen.getByRole('region', { name: 'Pay Rules' });
    expect(within(region).getByRole('button', { name: /^Save$/ })).toBeDisabled();   // nothing waits for Save
    await undo.mock.calls[0][1]();
    expect(apiOverrides.timeRoundingSet).toHaveBeenLastCalledWith({ enabled: false, nearestMin: 5 }, '');
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Punch Rounding' })).not.toBeChecked());
  });

  it('Pay Rules: a failed switch rolls back; a partly failed Save keeps the failed rule\'s edits', async () => {
    payRules({ rounding: { enabled: true } });
    apiOverrides.timeAutoLunchSet = vi.fn(() => Promise.reject(new Error('Auto-lunch is locked.')));
    render(<AdminConsole activeSub="pay:timeclock-policy" onSubChange={() => {}} />);
    const lunch = await screen.findByRole('switch', { name: 'Auto-Lunch Deduction' }, { timeout: 5000 });
    fireEvent.click(lunch);
    await waitFor(() => expect(apiOverrides.timeAutoLunchSet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Auto-Lunch Deduction' })).toBeChecked());
    fireEvent.change(screen.getByLabelText('Nearest'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Deduct'), { target: { value: '45' } });
    const region = screen.getByRole('region', { name: 'Pay Rules' });
    fireEvent.click(within(region).getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(apiOverrides.timeRoundingSet).toHaveBeenCalledWith({ enabled: true, nearestMin: 10 }, ''));
    await waitFor(() => expect(within(region).getByText('Unsaved changes')).toBeInTheDocument());
    expect(screen.getByLabelText('Nearest')).toHaveValue(10);   // saved
    expect(screen.getByLabelText('Deduct')).toHaveValue(45);    // failed, still the draft
  });

  it('Email Signature: a slow answer for an earlier company never lands over the one picked; a dirty pick asks', async () => {
    const waiting = {};
    apiOverrides.getEntitySignatureTemplates = (id) => new Promise((resolve) => { waiting[id] = resolve; });
    const tpl = (id, label) => ({ id, label, html: '' });
    const { dialog } = await import('../ui/dialog');
    const confirm = vi.spyOn(dialog, 'confirm').mockResolvedValue(false);
    render(<AdminConsole activeSub="branding:email-signature" onSubChange={() => {}} />);
    const region = screen.getByRole('region', { name: 'Email Signature' });
    const box = await within(region).findByRole('combobox');
    await waitFor(() => expect(waiting.c1).toBeTypeOf('function'));
    fireEvent.change(box, { target: { value: 'c2' } });
    await waitFor(() => expect(waiting.c2).toBeTypeOf('function'));
    await act(async () => { waiting.c2({ templates: [tpl('modern', 'Modern B'), tpl('bold', 'Bold B')], template: 'modern' }); });
    await act(async () => { waiting.c1({ templates: [tpl('classic', 'Classic A')], template: 'classic' }); });
    expect(within(region).getByText('Modern B')).toBeInTheDocument();
    expect(within(region).queryByText('Classic A')).not.toBeInTheDocument();
    // A template picked and not saved: switching companies asks; Keep Editing stays.
    fireEvent.click(within(region).getByText('Bold B'));
    fireEvent.change(box, { target: { value: 'c1' } });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toMatch(/Greens India have not been saved/);
    expect(box).toHaveValue('c2');
    expect(within(region).getByText('Bold B')).toBeInTheDocument();
  });

  it('Email Signature: a color redraws the gallery before Save, a bad hex is refused, Save sends it (Neil, 11/11/2026)', async () => {
    const calls = [];
    apiOverrides.getEntitySignatureTemplates = (id, color) => {
      calls.push(color);
      return Promise.resolve({ templates: [{ id: 'bold', label: 'Bold', html: `<i>${color ?? 'saved'}</i>` }], template: 'bold', color: '' });
    };
    const saved = [];
    apiOverrides.updateEntity = (id, body) => { saved.push([id, body]); return Promise.resolve({ signatureColor: '#1d4ed8' }); };
    render(<AdminConsole activeSub="branding:email-signature" onSubChange={() => {}} />);
    const region = screen.getByRole('region', { name: 'Email Signature' });
    const hex = await within(region).findByLabelText('Signature Color');
    fireEvent.change(hex, { target: { value: '#zzz' } });
    expect(within(region).getByText('Enter a hex color such as #1f8a4d.')).toBeInTheDocument();
    fireEvent.change(hex, { target: { value: '#1D4ED8' } });
    await waitFor(() => expect(within(region).getByText('#1D4ED8')).toBeInTheDocument());
    expect(calls).toContain('#1D4ED8');
    expect(calls).not.toContain('#zzz');
    fireEvent.click(within(region).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0][1]).toEqual({ signature_template: 'bold', signature_color: '#1D4ED8' });
  });

  it('Item Types: a failed load says so with Retry and keeps the editors shut', async () => {
    apiOverrides.getItemTypes = () => Promise.reject(new Error('down'));
    render(<AdminConsole activeSub="items" onSubChange={() => {}} />);
    expect(await screen.findByText('Could not load the item types.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage Item Types' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Manage Custom Fields' })).not.toBeDisabled();
    apiOverrides.getItemTypes = () => Promise.resolve(['Laptop']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Could not load the item types.')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Manage Item Types' })).not.toBeDisabled();
  });

  it('a company whose answer never comes does not hide who keeps their own: it times out with Retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      payRules();
      apiOverrides.timeRoundingGet = (cid) => (cid === 'c2' ? new Promise(() => {}) : Promise.resolve({ enabled: false, nearestMin: 5, hasOverride: cid === 'c1' }));
      render(<AdminConsole activeSub="pay:timeclock-policy" onSubChange={() => {}} />);
      const region = screen.getByRole('region', { name: 'Pay Rules' });
      await within(region).findByRole('switch', { name: 'Punch Rounding' }, { timeout: 5000 });
      expect(region.querySelector('[data-company-overrides]')).toBeNull();
      // Whenever the companies' checks start, 15 seconds later they give up.
      const overrides = () => region.querySelector('[data-company-overrides]');
      for (let i = 0; i < 50 && !overrides(); i++) {
        await act(async () => { vi.advanceTimersByTime(16000); await Promise.resolve(); });
      }
      const line = overrides();
      expect(line).not.toBeNull();
      expect(within(line).getByRole('button', { name: 'Greens Global' })).toBeInTheDocument();
      expect(within(line).getByText('Could not check Greens India.')).toBeInTheDocument();
      expect(within(line).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review fixes (11/02/2026).
  it('Pay Rules: "10" typed and saved leaves the form clean (no Unsaved changes after a save that worked)', async () => {
    payRules({ rounding: { enabled: true } });
    render(<AdminConsole activeSub="pay:timeclock-policy" onSubChange={() => {}} />);
    await screen.findByRole('switch', { name: 'Punch Rounding' }, { timeout: 5000 });
    fireEvent.change(screen.getByLabelText('Nearest'), { target: { value: '10' } });
    const region = screen.getByRole('region', { name: 'Pay Rules' });
    expect(within(region).getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(apiOverrides.timeRoundingSet).toHaveBeenCalledWith({ enabled: true, nearestMin: 10 }, ''));
    await waitFor(() => expect(within(region).getByText(/^Saved /)).toBeInTheDocument());
    expect(within(region).queryByText('Unsaved changes')).not.toBeInTheDocument();
    const { hasUnsavedWork } = await import('../lib/dialogGuard');
    await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  });

  it('Discard on the app-wide prompt (browser Back, a bell) really drops the draft', async () => {
    const { default: DialogGuard } = await import('../components/DialogGuard');
    const { askToLeave, hasUnsavedWork } = await import('../lib/dialogGuard');
    render(<><DialogGuard /><AdminConsole activeSub="shifts" onSubChange={() => {}} /></>);
    fireEvent.change(await screen.findByLabelText('Weather note', {}, { timeout: 5000 }), { target: { value: 'rain' } });
    let left;
    act(() => { left = askToLeave(); });
    const ask = await screen.findByRole('alertdialog');
    expect(within(ask).getByText(/Your changes to Weather Alerts/)).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Discard Changes' }));
    await expect(left).resolves.toBe(true);
    await waitFor(() => expect(screen.getByLabelText('Weather note')).toHaveValue(''));
    expect(hasUnsavedWork()).toBe(false);
  });

  it('leaving for Tools reports Settings clean: nothing stays dirty, no stale save is offered', async () => {
    const { hasUnsavedWork, unsavedSummary } = await import('../lib/dialogGuard');
    const onSubChange = vi.fn();
    const { rerender } = render(<AdminConsole activeSub="shifts" onSubChange={onSubChange} />);
    fireEvent.change(await screen.findByLabelText('Weather note', {}, { timeout: 5000 }), { target: { value: 'rain' } });
    expect(hasUnsavedWork()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Tools$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    expect(onSubChange).toHaveBeenCalledWith('tools');
    rerender(<AdminConsole activeSub="tools" onSubChange={onSubChange} />);
    await waitFor(() => expect(hasUnsavedWork()).toBe(false));
    expect(unsavedSummary().labels).toEqual([]);
  });

  it('browser Back to another group of the same subject goes through without asking; another subject asks', async () => {
    const { rememberEntry, guardPopstate } = await import('../lib/dialogGuard');
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Weather note', {}, { timeout: 5000 }), { target: { value: 'rain' } });
    window.history.replaceState({ depth: 1 }, '', '/admin-console/shifts');
    rememberEntry();
    window.history.replaceState({ depth: 0 }, '', '/admin-console/shifts:shift-weather');
    const apply = vi.fn();
    expect(guardPopstate({ state: { depth: 0 } }, apply)).toBe(true);
    expect(apply).toHaveBeenCalled();
    window.history.replaceState({ depth: 0 }, '', '/admin-console/pay');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    expect(guardPopstate({ state: { depth: -1 } }, vi.fn())).toBe(false);
    expect(go).toHaveBeenCalledWith(1);
    guardPopstate({ state: { depth: 0 } }, vi.fn());   // the step back, swallowed
    const { subscribe } = await import('../lib/dialogGuard');
    const off = subscribe((p) => { p?.resolve(false); });   // Keep Editing, to tidy up
    off();
    await act(async () => { await Promise.resolve(); });
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
    // A layered setting keeps its default editor; with no company of its own
    // under it, no footer repeats "every company follows this default".
    const rules = screen.getByRole('region', { name: 'Pay Rules' });
    expect(within(rules).getByText('Every Company · Companies Can Change')).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 50));
    expect(rules.querySelector('[data-company-overrides]')).toBeNull();
    expect(screen.queryByText('Every company follows this default.')).not.toBeInTheDocument();
  });

  it('says what a picked company does differently in the subject, with jump links', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="pay@c1" onSubChange={onSubChange} />);
    const line = (await screen.findByText(/Different for Greens Global/, {}, { timeout: 5000 })).parentElement;
    fireEvent.click(within(line).getByRole('button', { name: 'Payroll Export Codes' }));
    expect(within(within(rail()).getByLabelText('Time & Pay settings')).getByRole('button', { name: 'Payroll Export Codes' })).toHaveAttribute('aria-current', 'location');
    // Its own group's chip says so too, in the one vocabulary: Own Settings.
    expect(within(screen.getByRole('region', { name: 'Payroll Export Codes' })).getByText('Own Settings')).toBeInTheDocument();
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
    // The policies are the Every company face; the company's calendar is its own.
    expect(screen.queryByRole('region', { name: 'Holiday Policies' })).not.toBeInTheDocument();
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
    expect(await screen.findByRole('tab', { name: /Routing & Escalation/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByText('Desk panel c1')).toBeInTheDocument();

    rerender(<AdminConsole activeSub="branding@c1" onSubChange={() => {}} />);
    // The signature is the lone group with a company picked, so it renders bare under the subject heading.
    expect(await screen.findByRole('heading', { name: 'Branding & Email' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Brand Color' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Brand Color' })).toBeInTheDocument();
  });

  it('brings the strays home: readiness, minimum wage, leave, time-off reasons, Intacct, letterheads, property rules, unit rules, ratings (phase 3)', async () => {
    const { rerender } = render(<AdminConsole activeSub="pay" onSubChange={() => {}} />);
    for (const t of ['Pay Rules', 'Payroll Readiness', 'California Minimum Wage', 'Intacct Nightly Sync']) {
      expect(screen.getByRole('heading', { name: t })).toBeInTheDocument();
    }
    expect(await find('Readiness panel')).toBeInTheDocument();
    rerender(<AdminConsole activeSub="leave" onSubChange={() => {}} />);
    for (const t of ['Leave Policies', 'Time Off Reasons']) expect(screen.getByRole('heading', { name: t })).toBeInTheDocument();
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

  it('filters groups across every subject', async () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Filter settings');

    fireEvent.change(box, { target: { value: 'notifications' } });
    expect(await screen.findByText('Ticket Manager')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Task Notifications' })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Search Every Company' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filter' }));
    expect(screen.getByRole('heading', { name: 'Companies', level: 3 })).toBeInTheDocument();
  });

  it('matches at word starts, finds groups by the words inside them, and marks the words found', () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Filter settings');
    // "late" is Late (Schedule Basics' grace), never every "template".
    fireEvent.change(box, { target: { value: 'late' } });
    expect(screen.getByRole('region', { name: 'Schedule Basics' })).toBeInTheDocument();
    for (const t of ['Email Signature', 'HR Letters', 'Hiring Documents']) expect(screen.queryByRole('region', { name: t })).not.toBeInTheDocument();
    // Overtime finds the pay groups as well as the shift alerts.
    fireEvent.change(box, { target: { value: 'overtime' } });
    for (const t of ['Pay Rules', 'Payroll Export Codes', 'Payroll Readiness', 'Overtime Alerts']) expect(screen.getByRole('region', { name: t })).toBeInTheDocument();
    // PTO, vacation and sick find the leave groups.
    for (const q of ['pto', 'vacation', 'sick']) {
      fireEvent.change(box, { target: { value: q } });
      for (const t of ['Leave Policies', 'Time Off Reasons', 'Leave Year-End', 'Time Off Approval']) expect(screen.getByRole('region', { name: t })).toBeInTheDocument();
    }
    // Words typed together find the groups that have them together: "time
    // off" is the leave groups, not Pay Rules' "time clock ... off by default".
    // The words found are marked in the result titles.
    fireEvent.change(box, { target: { value: 'time off' } });
    expect(screen.queryByRole('region', { name: 'Pay Rules' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Requests & Visibility' })).toBeInTheDocument();
    const title = within(screen.getByRole('region', { name: 'Time Off Reasons' })).getByRole('heading', { level: 4 });
    expect([...title.querySelectorAll('mark')].map(m => m.textContent)).toEqual(['Time', 'Off']);
    expect(title).toHaveTextContent('Time Off Reasons');
  });

  it('with a company picked and nothing matching, says so for the company and offers Search Every Company', async () => {
    const onSubChange = vi.fn();
    const { rerender } = render(<AdminConsole activeSub="leave@c1" onSubChange={onSubChange} />);
    await waitFor(() => expect(screen.getByLabelText('Applies To')).toHaveValue('c1'));
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'leave policies' } });
    expect(screen.getByText('No settings match "leave policies" for Greens Global.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search Every Company' }));
    expect(onSubChange).toHaveBeenLastCalledWith('leave');
    // The words stay: the same search runs at Every company.
    rerender(<AdminConsole activeSub="leave" onSubChange={onSubChange} />);
    expect(screen.getByLabelText('Filter settings')).toHaveValue('leave policies');
    expect(screen.getByRole('region', { name: 'Leave Policies' })).toBeInTheDocument();
  });

  it('offers no Search Every Company to someone walled to some companies (they see fewer there)', async () => {
    asRole('supervisor', { grants: { hr: 'editor' }, hrScope: ['c1'] });
    render(<AdminConsole activeSub="leave@c1" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Applies To')).toHaveValue('c1'));
    fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'nothing like this' } });
    expect(screen.getByText(/No settings match "nothing like this" for Greens Global/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search Every Company' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Filter' })).toBeInTheDocument();
  });

  it('reads a typed hyphen as a space, and "mail" finds the email groups', () => {
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Filter settings');
    fireEvent.change(box, { target: { value: 'time-off' } });
    for (const t of ['Time Off Reasons', 'Time Off Approval']) expect(screen.getByRole('region', { name: t })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'no-show' } });
    expect(screen.getByRole('region', { name: 'Attendance' })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'mail' } });
    for (const t of ['Email Appearance', 'Task Notifications', 'Daily Briefing', 'Weekly Digest', 'HR & Compliance Reminders']) {
      expect(screen.getByRole('region', { name: t })).toBeInTheDocument();
    }
  });

  it('links Requests & Visibility to Time Off & Leave through the shell, keeping the company', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="shifts@c1" onSubChange={onSubChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Time Off & Leave' }, { timeout: 5000 }));
    expect(onSubChange).toHaveBeenLastCalledWith('leave@c1');
    // Only the Requests slice carries it.
    expect(screen.getAllByRole('button', { name: 'Open Time Off & Leave' })).toHaveLength(1);
  });

  it('opens on a list of the subjects on phones, and a subject has a way back', async () => {
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

    // With unsaved changes, All Settings asks first, like every other move.
    onSubChange.mockClear();
    dirtyState.weather = true;
    rerender(<AdminConsole activeSub="shifts" onSubChange={onSubChange} />);
    await screen.findByLabelText('Weather note', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /All Settings/ }));
    expect(onSubChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    expect(onSubChange).toHaveBeenLastCalledWith('settings');
  });
});

// The Settings walls (11/02/2026): mayOpen opens each group only where its
// save route would let the person in - the shift and pay settings' "Every
// company" face for company-wide callers only (`tenant`), the organization's
// records for an unwalled caller (`orgWide`), the labor budget for HR++,
// the Ticket Manager for a desk supervisor - and an unknown company in the
// address never has panels mounted against it.
describe('AdminConsole walls', () => {
  it('opens the pay and shift settings per company for a walled Administrator, never at Every company', async () => {
    asRole('administrator', { hrScope: ['c1'], manageCompanies: ['c1'], companyWalled: true });
    const { rerender } = render(<AdminConsole activeSub="pay" onSubChange={() => {}} />);
    for (const t of ['Pay Rules', 'India Contractor Policy', 'California Minimum Wage']) {
      expect(screen.queryByRole('region', { name: t })).not.toBeInTheDocument();
    }
    // The leave groups moved to Time Off & Leave (11/02/2026) with their walls.
    rerender(<AdminConsole activeSub="leave" onSubChange={() => {}} />);
    for (const t of ['Time Off Approval', 'Leave Year-End', 'Time Off Reasons', 'Leave Policies']) {
      expect(screen.queryByRole('region', { name: t })).not.toBeInTheDocument();
    }
    rerender(<AdminConsole activeSub="pay@c1" onSubChange={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Pay Rules' }, { timeout: 5000 })).toBeInTheDocument();
    rerender(<AdminConsole activeSub="leave@c1" onSubChange={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Time Off Approval' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Leave Year-End' })).toBeInTheDocument();
    rerender(<AdminConsole activeSub="shifts@c1" onSubChange={() => {}} />);
    expect(await find('Shift settings panel basics c1')).toBeInTheDocument();
    // HR++ inside their reach: the labor budget is theirs for their company.
    expect(screen.getByRole('region', { name: 'Labor Budget' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Weather Alerts' })).not.toBeInTheDocument();
  });

  it('keeps the records every company shares - brand, email look, property rules - to a Super Administrator', async () => {
    asRole('administrator', { hrScope: ['c1'], manageCompanies: ['c1'], companyWalled: true });
    render(<AdminConsole activeSub="branding" onSubChange={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Brand Color' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Email Appearance' })).not.toBeInTheDocument();
    cleanup();
    render(<AdminConsole activeSub="tickets" onSubChange={() => {}} />);
    expect(await screen.findByRole('tab', { name: /Routing & Escalation/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Property Rules' })).not.toBeInTheDocument();
    cleanup();
    // An Administrator with the walls nowhere near them is still refused (Neil, 11/02/2026).
    asRole('administrator');
    render(<AdminConsole activeSub="branding" onSubChange={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Brand Color' })).not.toBeInTheDocument();
    cleanup();
    asRole('owner', { isGlobalAdmin: true });
    render(<AdminConsole activeSub="branding" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Brand Color' })).toBeInTheDocument();
  });

  it('opens the labor budget for HR++ only - never the manager tier', async () => {
    asRole('manager', { grants: { hr: 'editor' } });
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Schedule Basics' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Labor Budget' })).not.toBeInTheDocument();
    cleanup();
    asRole('manager', { grants: { hr: 'full' } });
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Labor Budget' })).toBeInTheDocument();
    cleanup();
    // A company's HR contact: their company's budget, not every company's.
    asRole('manager', { hrContactFor: ['c1'] });
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Labor Budget' })).not.toBeInTheDocument();
    cleanup();
    render(<AdminConsole activeSub="shifts@c1" onSubChange={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Labor Budget' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it('opens Weather Alerts only with company-wide team access', () => {
    asRole('manager', { manageCompanies: ['c1'] });
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Weather Alerts' })).not.toBeInTheDocument();
    cleanup();
    asRole('manager');
    render(<AdminConsole activeSub="shifts" onSubChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Weather Alerts' })).toBeInTheDocument();
  });

  it('opens the Ticket Manager for a desk supervisor only', async () => {
    asRole('manager', { desk: false });
    render(<AdminConsole activeSub="emails" onSubChange={() => {}} />);
    expect(await find('Task notify panel')).toBeInTheDocument();
    expect(within(rail()).queryByRole('button', { name: 'Tickets' })).not.toBeInTheDocument();
    cleanup();
    asRole('manager');
    render(<AdminConsole activeSub="emails" onSubChange={() => {}} />);
    expect(await within(rail()).findByRole('button', { name: 'Tickets' })).toBeInTheDocument();
  });

  it('drops an unknown company from the address with a notice, mounting nothing against it', async () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="pay@nope" onSubChange={onSubChange} />);
    expect(screen.queryByText(/panel nope/)).not.toBeInTheDocument();
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('pay'));
    expect(screen.getByText(/That company is not one you can open/)).toBeInTheDocument();
    expect(screen.queryByText(/panel nope/)).not.toBeInTheDocument();
  });

  it('says the companies could not load, with Retry, instead of "No companies yet"', async () => {
    apiState.entities = 'error';
    render(<AdminConsole activeSub="analytics" onSubChange={() => {}} />);
    expect(await screen.findByText('The companies could not be loaded right now.')).toBeInTheDocument();
    expect(screen.queryByText(/No companies yet/)).not.toBeInTheDocument();
    apiState.entities = 'ok';
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('The companies could not be loaded right now.')).not.toBeInTheDocument());
  });

  it('lists the companies a Workforce Analytics grant may open when People is not theirs', async () => {
    asRole('employee', { grants: { 'employee-tracking': 'full' }, manageCompanies: [] });
    apiState.entities = 'denied';
    apiState.trackingCompanies = [{ id: 'c1', name: 'Greens Global' }];
    render(<AdminConsole activeSub="analytics" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Applies To');
    await waitFor(() => expect(within(box).getByRole('option', { name: 'Greens Global' })).toBeInTheDocument());
    expect(screen.queryByText('The companies could not be loaded right now.')).not.toBeInTheDocument();
  });
});

// Review follow-ups (11/02/2026): a manager refused both company lists still
// reaches their own company; a company just added elsewhere is asked for
// past the cache before it is dropped; Property Rules open for a desk
// supervisor, as the route does.
describe('AdminConsole walls, review follow-ups', () => {
  it('gives a manager refused both company lists their own companies, never dropping them', async () => {
    asRole('manager', { manageCompanies: ['c1'], manageCompanyRows: [{ id: 'c1', name: 'Greens Global' }] });
    apiState.entities = 'denied';
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="shifts@c1" onSubChange={onSubChange} />);
    expect(await find('Shift settings panel basics c1')).toBeInTheDocument();
    expect(onSubChange).not.toHaveBeenCalled();
    // The fallback list arrives after the panel; wait for the option rather than racing it.
    await waitFor(() => expect(within(screen.getByLabelText('Applies To')).getByRole('option', { name: 'Greens Global' })).toBeInTheDocument());
    expect(screen.queryByText(/That company is not one you can open/)).not.toBeInTheDocument();
  });

  it('asks for the companies again past the cache before dropping an unknown one', async () => {
    apiState.added = [{ id: 'c3', name: 'Greens New' }];
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="pay@c3" onSubChange={onSubChange} />);
    await waitFor(() => expect(screen.getByLabelText('Applies To')).toHaveValue('c3'));
    expect(await find('Export codes panel c3')).toBeInTheDocument();
    expect(onSubChange).not.toHaveBeenCalled();
  });

  it('keeps Property Rules from a desk supervisor and a Full tickets grant - Super Administrators only', async () => {
    asRole('employee', { desk: true });
    render(<AdminConsole activeSub="tickets" onSubChange={() => {}} />);
    // Tickets holds nothing for them: the rules are every company's.
    await waitFor(() => new Promise(r => setTimeout(r, 20)));   // the desk role has answered
    expect(screen.queryByText('Property rules panel')).not.toBeInTheDocument();
    cleanup();
    // Nor a Full tickets grant.
    asRole('employee', { grants: { tickets: 'full' }, desk: false });
    render(<AdminConsole activeSub="companies" onSubChange={() => {}} />);
    await waitFor(() => new Promise(r => setTimeout(r, 20)));   // the desk role has answered
    expect(within(rail()).queryByRole('button', { name: 'Tickets' })).not.toBeInTheDocument();
  });
});

describe('AdminConsole, Diagram From a Sentence (Neil, 11/08/2026)', () => {
  it('is a Super Administrator group whose switch cannot go on while AI is off', async () => {
    apiOverrides.getDiagramAiSettings = () => Promise.resolve({ diagramAiEnabled: false, aiAvailable: false });
    const set = vi.fn(() => Promise.resolve({ diagramAiEnabled: true, aiAvailable: true }));
    apiOverrides.setDiagramAiSettings = set;
    asRole('owner', { isGlobalAdmin: true });
    render(<AdminConsole activeSub="notes" onSubChange={() => {}} />);
    const sw = await screen.findByRole('switch', { name: 'Diagram From a Sentence' }, { timeout: 5000 });
    expect(sw).toBeDisabled();
    expect(sw).not.toBeChecked();
    expect(screen.getByText(/A Super Administrator \(Neil or Visesh\) must enable AI for Nexus and connect an AI service first/)).toBeInTheDocument();
    fireEvent.click(sw);
    expect(set).not.toHaveBeenCalled();
    expect(within(rail()).getByRole('button', { name: /Notes & Boards/ })).toBeInTheDocument();
  });

  it('is not there for an Administrator, walled or not', () => {
    for (const extra of [{}, { hrScope: ['c1'], manageCompanies: ['c1'], companyWalled: true }]) {
      asRole('administrator', extra);
      render(<AdminConsole activeSub="notes" onSubChange={() => {}} />);
      expect(screen.queryByRole('switch', { name: 'Diagram From a Sentence' })).not.toBeInTheDocument();
      expect(within(rail()).queryByRole('button', { name: /Notes & Boards/ })).not.toBeInTheDocument();
      cleanup();
    }
  });
});
