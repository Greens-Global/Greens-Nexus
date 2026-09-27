import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Settings > Global Settings > Branding & Policies: the category renders for
// administrators only, each panel loads, and the sign-in policy editor saves
// drafts without publishing and asks before publishing a new version.

const PUBLISHED = { title: 'Company Policies & Monitoring', body: '## Employee monitoring\nScreenshots while clocked in.', version: '2026-07-21', publishedAt: '', publishedBy: '' };
const mockApi = {
  getBrandingConfig: vi.fn(() => Promise.resolve({ accent: 'green' })),
  updateBrandingConfig: vi.fn((c) => Promise.resolve({ ...c, opacity: c.opacity ?? 100 })),
  getEmailTheme: vi.fn(() => Promise.resolve({
    theme: { logoUrl: '', accentColor: '#0f3d2e', footerText: '', companyAddressLine: '', headerText: 'GREENS GLOBAL', headerStyle: 'auto' },
    defaults: { logoUrl: '', accentColor: '#0f3d2e', footerText: '', companyAddressLine: '' },
    samples: [{ id: 'task', label: 'Task Notification' }, { id: 'ticket', label: 'Ticket Notification' }],
  })),
  previewEmailTheme: vi.fn(() => Promise.resolve({ html: '<p>sample email</p>' })),
  updateEmailTheme: vi.fn((t) => Promise.resolve({ theme: t })),
  policyConfig: vi.fn(() => Promise.resolve({ published: PUBLISHED, draft: null })),
  policyReport: vi.fn(() => Promise.resolve({ version: '2026-07-21', total: 3, accepted: 1, pending: [
    { name: 'Zed Roe', email: 'zed@example.com', department: '', company: 'Greens Global' },
    { name: 'Amy Poe', email: 'amy@example.com', department: '', company: 'Greens Global' },
  ], acceptedPeople: [
    { name: 'Cal Doe', email: 'cal@example.com', department: '', company: 'Greens Global', acceptedAt: '2026-09-20T21:30:00Z' },
  ] })),
  policySaveDraft: vi.fn((d) => Promise.resolve({ published: PUBLISHED, draft: { ...d, savedAt: '', savedBy: '' } })),
  policyDiscardDraft: vi.fn(() => Promise.resolve({ published: PUBLISHED, draft: null })),
  policyPublish: vi.fn((d) => Promise.resolve({ published: { ...d, version: '2026-09-26', publishedAt: '2026-09-26T17:00:00Z', publishedBy: 'a@x.com' }, draft: null })),
  policyReportCsv: vi.fn(() => Promise.resolve(new Blob(['x']))),
};
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => mockApi[k] || vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../lib/brandAccent', async (orig) => ({ ...(await orig()), setBrandAccent: vi.fn() }));
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
  it('saves the picked preset and applies it', async () => {
    const { setBrandAccent } = await import('../lib/brandAccent');
    render(<BrandColorPanel toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Blue/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(mockApi.updateBrandingConfig).toHaveBeenCalledWith(expect.objectContaining({ accent: 'blue' })));
    await waitFor(() => expect(setBrandAccent).toHaveBeenCalled());
  });

  it('custom shows the wheel, hex and opacity, previews live and warns on low contrast', async () => {
    render(<BrandColorPanel toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Custom/ }));
    const handle = await screen.findByRole('slider', { name: 'Hue and saturation' });
    const hex = screen.getByLabelText('Hex');
    expect(hex.value).toBe('#1d4ed8');
    // Arrow keys turn the hue and sync the hex field.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(hex.value).not.toBe('#1d4ed8');
    // Typing a hex updates the preview button.
    fireEvent.change(hex, { target: { value: '#123456' } });
    expect(screen.getByText('Primary Button').style.background).toBe('rgb(18, 51, 84)');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // A pale color fails AA with white text.
    fireEvent.change(hex, { target: { value: '#ffe4a0' } });
    expect(screen.getByRole('status')).toHaveTextContent(/hard to read/);
    // Low opacity fails too, and the slider stops at 30%.
    fireEvent.change(hex, { target: { value: '#1d4ed8' } });
    const opacity = screen.getByRole('slider', { name: /Opacity/ });
    expect(opacity).toHaveAttribute('min', '30');
    fireEvent.change(opacity, { target: { value: '30' } });
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.change(opacity, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(mockApi.updateBrandingConfig).toHaveBeenCalledWith({ accent: 'custom', customHex: '#1d4ed8', opacity: 100 }));
  });
});

describe('EmailAppearancePanel', () => {
  it('offers the header text and style, and shows a never-chosen style as what it renders', async () => {
    render(<EmailAppearancePanel toastOk={() => {}} toastErr={() => {}} />);
    const style = await screen.findByLabelText('Header Style');
    expect(style.value).toBe('title');   // auto + no logo
    expect(screen.getByLabelText('Header Text').value).toBe('GREENS GLOBAL');
    fireEvent.change(style, { target: { value: 'logo_title' } });
    expect(screen.getByText(/Until a logo is added/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Preview$/ }));
    await waitFor(() => expect(mockApi.previewEmailTheme).toHaveBeenLastCalledWith(expect.objectContaining({ headerStyle: 'logo_title' })));
  });

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

  it('shows Not Accepted and Accepted tabs, each with its own export', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    render(<SignInPolicyPanel toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Zed Roe')).toBeInTheDocument();
    expect(screen.getByText(/have accepted/).textContent).toMatch(/1 of 3 active employees have accepted\./);
    expect(screen.getByRole('tab', { name: 'Not Accepted (2)' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(mockApi.policyReportCsv).toHaveBeenLastCalledWith('not_accepted'));

    fireEvent.click(screen.getByRole('tab', { name: 'Accepted (1)' }));
    expect(screen.getByText('Cal Doe')).toBeInTheDocument();
    expect(screen.queryByText('Zed Roe')).not.toBeInTheDocument();
    expect(screen.getByText(/^09\/2\d\/2026, \d{1,2}:\d\d\s(AM|PM)$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(mockApi.policyReportCsv).toHaveBeenLastCalledWith('accepted'));
  });
});
