import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings > Global Settings > Branding & Policies: the category renders for
// administrators only, each panel loads, and the sign-in policy editor saves
// drafts without publishing and asks before publishing a new version.

const PUBLISHED = { title: 'Company Policies & Monitoring', body: '## Employee monitoring\nScreenshots while clocked in.', version: '2026-07-21', publishedAt: '', publishedBy: '' };
const mockApi = {
  getBrandingConfig: vi.fn(() => Promise.resolve({ accent: 'green' })),
  updateBrandingConfig: vi.fn(() => Promise.resolve({ accent: 'blue' })),
  getEmailTheme: vi.fn(() => Promise.resolve({
    theme: { logoUrl: '', accentColor: '#0f3d2e', footerText: '', companyAddressLine: '' },
    defaults: { logoUrl: '', accentColor: '#0f3d2e', footerText: '', companyAddressLine: '' },
    samples: [{ id: 'task', label: 'Task Notification' }, { id: 'ticket', label: 'Ticket Notification' }],
  })),
  previewEmailTheme: vi.fn(() => Promise.resolve({ html: '<p>sample email</p>' })),
  updateEmailTheme: vi.fn((t) => Promise.resolve({ theme: t })),
  policyConfig: vi.fn(() => Promise.resolve({ published: PUBLISHED, draft: null })),
  policyReport: vi.fn(() => Promise.resolve({ version: '2026-07-21', total: 3, accepted: 1, pending: [
    { name: 'Zed Roe', email: 'zed@example.com', department: '', company: 'Greens Global' },
    { name: 'Amy Poe', email: 'amy@example.com', department: '', company: 'Greens Global' },
  ] })),
  policySaveDraft: vi.fn((d) => Promise.resolve({ published: PUBLISHED, draft: { ...d, savedAt: '', savedBy: '' } })),
  policyDiscardDraft: vi.fn(() => Promise.resolve({ published: PUBLISHED, draft: null })),
  policyPublish: vi.fn((d) => Promise.resolve({ published: { ...d, version: '2026-09-26', publishedAt: '2026-09-26T17:00:00Z', publishedBy: 'a@x.com' }, draft: null })),
  policyReportCsv: vi.fn(() => Promise.resolve(new Blob(['x']))),
};
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => mockApi[k] || vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../lib/brandAccent', () => ({
  ACCENT_VARS: { green: { brand: 'green', hov: 'g', tint: 't' }, blue: { brand: 'blue', hov: 'b', tint: 't' } },
  applyBrandAccent: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/docBuilderUpload', () => ({ uploadToSupabase: vi.fn(), imageFromPaste: () => null }));
const roleState = { admin: true };
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: (min) => (min === 'administrator' ? roleState.admin : true), myGrantedModules: new Set(), actingAs: null }),
}));
vi.mock('./HR', () => ({ CompanySetupPage: () => null, WorkSiteLibrary: () => null }));
vi.mock('../tickets/TicketDeskSettings', () => ({ default: () => null }));
vi.mock('../tickets/TicketNotifySettings', () => ({ default: () => null }));
vi.mock('../tickets/TicketTaxonomySettings', () => ({ default: () => null }));

const AdminConsole = (await import('./AdminConsole')).default;
const { SignInPolicyPanel, EmailAppearancePanel, BrandColorPanel } = await import('./BrandingPoliciesSettings');

beforeEach(() => { Object.values(mockApi).forEach(f => f.mockClear()); });
afterEach(() => { cleanup(); roleState.admin = true; });

describe('Branding & Policies category', () => {
  it('renders its three sections for administrators', () => {
    render(<AdminConsole activeSub="global-branding" onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Branding & Policies' })).toBeInTheDocument();
    for (const t of ['Brand Color', 'Email Appearance', 'Sign-In Policy']) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it('is hidden from non-administrators', () => {
    roleState.admin = false;
    render(<AdminConsole activeSub="global-branding" onSubChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /Branding & Policies/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Organization' })).toBeInTheDocument();
  });

  it('opens a section and loads its panel', async () => {
    render(<AdminConsole activeSub="global-branding" onSubChange={() => {}} />);
    fireEvent.click(screen.getByText('Brand Color'));
    expect(await screen.findByRole('radio', { name: /Blue/ })).toBeInTheDocument();
  });
});

describe('BrandColorPanel', () => {
  it('saves the picked accent and applies it', async () => {
    const { applyBrandAccent } = await import('../lib/brandAccent');
    render(<BrandColorPanel toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(mockApi.updateBrandingConfig).toHaveBeenCalledWith('blue'));
    await waitFor(() => expect(applyBrandAccent).toHaveBeenCalled());
  });
});

describe('EmailAppearancePanel', () => {
  it('previews in a sandboxed frame and rejects a bad color', async () => {
    render(<EmailAppearancePanel toastOk={() => {}} toastErr={() => {}} />);
    const frame = await screen.findByTitle('Email preview');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('sample email');
    fireEvent.change(screen.getByLabelText('Accent Color'), { target: { value: 'green' } });
    expect(screen.getByText(/Enter a hex color/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });
});

describe('SignInPolicyPanel', () => {
  it('saves a draft without publishing', async () => {
    const ok = vi.fn();
    render(<SignInPolicyPanel toastOk={ok} toastErr={() => {}} />);
    const body = await screen.findByLabelText('Policy Text');
    expect(body.value).toContain('Employee monitoring');
    expect(screen.getByText(/Current version: 07\/21\/2026/)).toBeInTheDocument();
    fireEvent.change(body, { target: { value: '## Rules\n- Be kind' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockApi.policySaveDraft).toHaveBeenCalledWith({ title: PUBLISHED.title, body: '## Rules\n- Be kind' }));
    expect(mockApi.policyPublish).not.toHaveBeenCalled();
  });

  it('confirms before publishing a new version', async () => {
    render(<SignInPolicyPanel toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Policy Text'), { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: /Publish New Version/ }));
    expect(screen.getByText(/will have to read and accept this text/)).toBeInTheDocument();
    expect(mockApi.policyPublish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Publish and Ask Everyone/ }));
    await waitFor(() => expect(mockApi.policyPublish).toHaveBeenCalledWith({ title: PUBLISHED.title, body: 'New text' }));
    expect(await screen.findByText(/Current version: 09\/26\/2026/)).toBeInTheDocument();
  });

  it('shows who has not accepted', async () => {
    render(<SignInPolicyPanel toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Zed Roe')).toBeInTheDocument();
    expect(screen.getByText(/have accepted/).textContent).toMatch(/1 of 3 active employees have accepted\. 2 have not yet\./);
  });
});
