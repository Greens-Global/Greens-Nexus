import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Settings (AdminConsole): Global Settings and Company Settings render as two
// separate areas, old 'settings' links still land on Global Settings, category
// subs map both ways, and the filter narrows the org-wide sections.

// Every api call resolves empty - no section that renders here needs data.
vi.mock('../api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({
    can: () => true, myGrantedModules: new Set(), actingAs: null,
    startActAs: vi.fn(), stopActAs: vi.fn(),
  }),
}));
// HR.jsx is huge; Company Settings only needs to prove it mounts the page.
vi.mock('./HR', () => ({
  CompanySetupPage: () => <div>Company list</div>,
  WorkSiteLibrary: () => <div>Site list</div>,
}));

const AdminConsole = (await import('./AdminConsole')).default;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AdminConsole', () => {
  it('shows Global Settings with the Organization category by default', () => {
    render(<AdminConsole activeSub="global" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to every company.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByText('Email Signature')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365 Directory Sync')).toBeInTheDocument();
    expect(screen.getByText('Work Site Library')).toBeInTheDocument();
    // Other categories' sections stay out of view until picked.
    expect(screen.queryByText('Service Desk & Escalation')).not.toBeInTheDocument();
  });

  it('lands an old "settings" sub on Global Settings', () => {
    render(<AdminConsole activeSub="settings" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to every company.')).toBeInTheDocument();
    expect(screen.getByText('Email Signature')).toBeInTheDocument();
  });

  it('opens a category from its sub, and writes the sub when one is picked', () => {
    const onSubChange = vi.fn();
    render(<AdminConsole activeSub="global-service-desk" onSubChange={onSubChange} />);
    expect(screen.getByText('Service Desk & Escalation')).toBeInTheDocument();
    expect(screen.getByText('Ticket Notifications')).toBeInTheDocument();
    expect(screen.getByText('SLA & Ticket Types')).toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Items/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('global-items');
    fireEvent.click(screen.getByRole('button', { name: /Organization/ }));
    expect(onSubChange).toHaveBeenLastCalledWith('global');
  });

  it('shows Company Settings as its own per-company area', async () => {
    render(<AdminConsole activeSub="company" onSubChange={() => {}} />);
    expect(screen.getByText('Applies to one company at a time.')).toBeInTheDocument();
    expect(await screen.findByText('Company list')).toBeInTheDocument();
    expect(screen.queryByText('Applies to every company.')).not.toBeInTheDocument();
  });

  it('filters sections across every category and opens a lone match', () => {
    render(<AdminConsole activeSub="global" onSubChange={() => {}} />);
    const box = screen.getByLabelText('Filter settings');

    fireEvent.change(box, { target: { value: 'notifications' } });
    expect(screen.getByText('Ticket Notifications')).toBeInTheDocument();
    expect(screen.getByText('Task Notifications')).toBeInTheDocument();
    expect(screen.queryByText('Email Signature')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'microsoft' } });
    expect(screen.getByText('Microsoft 365 Directory Sync')).toBeInTheDocument();
    expect(screen.queryByText('Work Site Library')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync Now/ })).toBeInTheDocument();

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
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'tasks' } });
    expect(onSubChange).toHaveBeenLastCalledWith('global-tasks');
  });
});
