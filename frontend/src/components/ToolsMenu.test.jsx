import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The profile menu's Tools section and its Act As finder (Neil, Oct 25 2026):
// rows only for people who can use them, nobody listed until something is
// typed (recents aside), at most 5 rows with a count of the rest, and every
// typed word may match a title, company or site as well as a name.

let TARGETS = [];
let DIRECTORY = [];
let QA = false;
vi.mock('../api', () => ({ api: {
  getActAsEligibleTargets: () => Promise.resolve(TARGETS),
  getPeopleDirectory: () => Promise.resolve(DIRECTORY),
  qaEnabled: () => Promise.resolve({ enabled: QA }),
} }));

const build = { enabled: false, on: false, toggle: vi.fn() };
vi.mock('../devnotes/BuildModeChip', () => ({ useBuildModeMenu: () => build }));

const roleState = { value: null };
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => roleState.value };
});

const LEVEL = { employee: 1, supervisor: 2, manager: 3, administrator: 4, owner: 5 };
function makeRole(myRole, { grants = [], actingAs = null } = {}) {
  return {
    myRole, actingAs, isExternal: false,
    can: (min) => LEVEL[myRole] >= (LEVEL[min] ?? 1),
    myGrantedModules: new Set(grants),
    startActAs: vi.fn(() => Promise.resolve()), stopActAs: vi.fn(() => Promise.resolve()),
  };
}

const { ToolsSection, ActAsFinder } = await import('./ToolsMenu');

function person(i, extra = {}) {
  return { email: `p${i}@x.com`, name: `Alex Person${i}`, photoUrl: '', title: 'Technician', company: 'Greens Global', site: '', department: '', role: 'employee', ...extra };
}

beforeEach(() => {
  QA = false; build.enabled = false; build.on = false;
  TARGETS = []; DIRECTORY = [];
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => cleanup());

describe('Tools section', () => {
  it('is absent for someone with no tools', async () => {
    roleState.value = makeRole('employee');
    render(<ToolsSection onClose={vi.fn()} onOpenActAs={vi.fn()} />);
    await Promise.resolve();
    expect(screen.queryByTestId('tools-section')).not.toBeInTheDocument();
  });

  it('gives a manager Act As only, and A opens it', () => {
    roleState.value = makeRole('manager');
    const open = vi.fn();
    render(<ToolsSection onClose={vi.fn()} onOpenActAs={open} />);
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Act As/ })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Build Mode/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Support Tools')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'a' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens Act As for an employee holding the grant', () => {
    roleState.value = makeRole('employee', { grants: ['act-as'] });
    render(<ToolsSection onClose={vi.fn()} onOpenActAs={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Act As/ })).toBeInTheDocument();
  });

  it('shows Build Mode as a switch and Testing for an admin when QA is on', async () => {
    QA = true; build.enabled = true; build.on = true;
    roleState.value = makeRole('owner');
    const onClose = vi.fn();
    render(<ToolsSection onClose={onClose} onOpenActAs={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: /Build Mode/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(build.toggle).toHaveBeenCalled();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    fireEvent.click(await screen.findByRole('button', { name: /Testing/ }));
    expect(nav.mock.calls[0][0].detail.view).toBe('testing');
    window.removeEventListener('nexus:navigate', nav);
  });

  it('shows who you are acting as with Exit instead of the finder', async () => {
    roleState.value = makeRole('employee', { actingAs: { targetName: 'Sam Lee', targetEmail: 'sam@x.com' } });
    render(<ToolsSection onClose={vi.fn()} onOpenActAs={vi.fn()} />);
    expect(screen.getByText('Acting as Sam')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Act As/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    await waitFor(() => expect(roleState.value.stopActAs).toHaveBeenCalled());
  });
});

describe('Act As finder', () => {
  // First: the People photo map loads once per test file.
  it('draws a photo from the row, from the People map, or initials', async () => {
    TARGETS = [
      person(1, { name: 'Ann Able', photoUrl: 'https://cdn/ann.jpg' }),
      person(2, { name: 'Bo Brown' }),
      person(3, { name: 'Cy Cole' }),
    ];
    DIRECTORY = [{ email: 'p2@x.com', photoUrl: 'https://cdn/bo.jpg' }];
    roleState.value = makeRole('manager');
    render(<ActAsFinder onBack={vi.fn()} />);
    await screen.findByText('3 people');
    fireEvent.change(screen.getByLabelText('Find a person to act as'), { target: { value: 'technician' } });
    const [ann, bo, cy] = screen.getAllByRole('option');
    expect(ann.querySelector('img').getAttribute('src')).toBe('https://cdn/ann.jpg');
    await vi.waitFor(() => expect(bo.querySelector('img')?.getAttribute('src')).toBe('https://cdn/bo.jpg'));
    expect(cy.querySelector('img')).toBeNull();
    expect(cy.textContent).toContain('CC');
  });

  it('lists nobody until something is typed, then at most 5 with a count', async () => {
    TARGETS = Array.from({ length: 12 }, (_, i) => person(i + 1));
    roleState.value = makeRole('manager');
    render(<ActAsFinder onBack={vi.fn()} />);
    expect(await screen.findByText('12 people')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Find a person to act as'), { target: { value: 'alex' } });
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getByText('+7 more')).toBeInTheDocument();
  });

  it('matches every word against name, title and site', async () => {
    TARGETS = [
      person(1, { name: 'Maria Garcia', title: 'HR Coordinator', site: 'Austin' }),
      person(2, { name: 'Jordan Lee', title: 'HR Generalist', site: 'Temecula' }),
      person(3, { name: 'Ben Adams', title: 'Site Lead', site: 'Austin' }),
    ];
    roleState.value = makeRole('manager');
    render(<ActAsFinder onBack={vi.fn()} />);
    await screen.findByText('3 people');
    fireEvent.change(screen.getByLabelText('Find a person to act as'), { target: { value: 'hr aus' } });
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Maria Garcia');
    expect(rows[0].textContent).toContain('HR Coordinator · Austin');
  });

  it('starts on Enter and remembers the person as a recent', async () => {
    TARGETS = [person(1, { name: 'Maria Garcia' }), person(2, { name: 'Jordan Lee' })];
    roleState.value = makeRole('manager');
    const { unmount } = render(<ActAsFinder onBack={vi.fn()} />);
    await screen.findByText('2 people');
    const box = screen.getByLabelText('Find a person to act as');
    fireEvent.change(box, { target: { value: 'jor' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(roleState.value.startActAs).toHaveBeenCalledWith('p2@x.com'));
    unmount();
    render(<ActAsFinder onBack={vi.fn()} />);
    await screen.findByText('Recent');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toContain('Jordan Lee');
  });

});
