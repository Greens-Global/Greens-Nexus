// Passwords is a Dashboard tab (Neil, 11/18/2026): the module that was
// Credentials in the left menu. The tab shows for exactly the people the old
// menu row showed for - administrators and holders of the grant - and the
// old 'credvault' view is a doorway onto it (an outside guest, who has no
// Dashboard, keeps the screen by itself).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const role = vi.hoisted(() => ({ value: {} }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Olive Owner' }] }) }));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ activeOverdueAlerts: [], dismissOverdueAlert: () => {} }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role.value }));
vi.mock('../lib/useActionCounts', () => ({ useActionCounts: () => ({}), tabCount: () => 0 }));
vi.mock('../dashboard/CustomDashboard', () => ({ default: () => <div>Home Board</div> }));
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs, active }) => <div role="tablist">{tabs.map((t) => <span key={t.key} role="tab" aria-selected={active === t.key}>{t.label}</span>)}</div>,
  ModuleActions: ({ children }) => children,
}));
vi.mock('../credvault/CredentialVaultApp', () => ({ default: ({ activeSub, standalone }) => <div data-testid="vault" data-sub={activeSub ?? 'none'} data-standalone={String(!!standalone)} /> }));

const { default: Dashboard } = await import('./Dashboard');
const { default: CredentialVault } = await import('./CredentialVault');
const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent);
const person = (over = {}) => ({ can: () => false, hrScope: null, myGrantedModules: new Map(), isExternal: false, ...over });

beforeEach(() => { role.value = person(); });

describe('Dashboard > Passwords', () => {
  it('is the last tab for someone who holds the grant, and renders the vault with its deep link', async () => {
    role.value = person({ myGrantedModules: new Map([['credvault', 'viewer']]) });
    render(<Dashboard activeSub="passwords:cred-abc" onSubChange={() => {}} />);
    expect(tabs()).toEqual(['Home', 'Notes', 'Links', 'Passwords']);
    expect(screen.getByRole('tab', { name: 'Passwords' }).getAttribute('aria-selected')).toBe('true');
    const vault = await screen.findByTestId('vault');
    expect(vault.getAttribute('data-sub')).toBe('cred-abc');
    expect(vault.getAttribute('data-standalone')).toBe('false');
  });

  it('shows for an administrator without the grant', () => {
    role.value = person({ can: (r) => r === 'administrator' || r === 'manager' });
    render(<Dashboard activeSub="passwords" onSubChange={() => {}} />);
    expect(tabs()).toEqual(['Home', 'Approvals', 'Notes', 'Links', 'Passwords']);
  });

  it('is not there at all without the grant - a typed address lands on Home', () => {
    render(<Dashboard activeSub="passwords:cred-abc" onSubChange={() => {}} />);
    expect(tabs()).toEqual(['Home', 'Notes', 'Links']);
    expect(screen.getByText('Home Board')).toBeTruthy();
    expect(screen.queryByTestId('vault')).toBeNull();
  });
});

describe("the old 'credvault' view", () => {
  it('sends an employee on to the Dashboard tab, keeping the deep link', async () => {
    const onBounce = vi.fn();
    const { rerender } = render(<CredentialVault activeSub="cred-abc" onBounce={onBounce} />);
    await waitFor(() => expect(onBounce).toHaveBeenCalledWith('dashboard', 'passwords:cred-abc'));
    rerender(<CredentialVault activeSub="cred-abc" onBounce={vi.fn()} />);            // a new function each render: still once
    expect(onBounce).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('vault')).toBeNull();
  });

  it("sends the vault's old Approvals address to Dashboard > Approvals", async () => {
    const onBounce = vi.fn();
    render(<CredentialVault activeSub="approvals" onBounce={onBounce} />);
    await waitFor(() => expect(onBounce).toHaveBeenCalledWith('dashboard', 'approvals:access'));
  });

  it('renders by itself for an outside guest, who has no Dashboard', () => {
    role.value = person({ isExternal: true, myGrantedModules: new Map([['credvault', 'viewer']]) });
    const onBounce = vi.fn();
    render(<CredentialVault activeSub="personal" onBounce={onBounce} />);
    const vault = screen.getByTestId('vault');
    expect(vault.getAttribute('data-standalone')).toBe('true');
    expect(vault.getAttribute('data-sub')).toBe('personal');
    expect(onBounce).not.toHaveBeenCalled();
  });
});
