import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Support > Documentation: every module page must render (it is one big data
// file, so a typo in one entry would otherwise only show up when someone
// clicks that module), search must narrow the index, and the content must
// follow the house style.

// Real NAV, so the gating under test is the same rule the left menu uses.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const role = { admin: false, external: false, grants: new Set() };
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({
    isExternal: role.external,
    can: (r) => role.admin && r === 'administrator',
    myGrantedModules: role.grants,
  }),
}));
const as = (next) => Object.assign(role, { admin: false, external: false, grants: new Set() }, next);

const SupportDocs = (await import('./SupportDocs')).default;
const { DOCS, DOC_GROUPS } = await import('./docsContent');
const { shotLegend } = await import('./DocShots');

const indexButtons = (container) => [...container.querySelectorAll('.docs-index-item')];

describe('Support documentation', () => {
  it('opens on Getting Started', () => {
    as({});
    render(<SupportDocs />);
    expect(screen.getByRole('heading', { level: 2, name: 'Getting Started' })).toBeTruthy();
    expect(screen.getByText('Find Anything in Two Seconds')).toBeTruthy();
  });

  it('renders every module page without crashing (admins see them all)', () => {
    as({ admin: true });
    const { container } = render(<SupportDocs />);
    expect(indexButtons(container)).toHaveLength(DOCS.length);
    for (const doc of DOCS) {
      const btn = indexButtons(container).find((b) => b.textContent === doc.name);
      fireEvent.click(btn);
      const article = container.querySelector('.docs-article');
      expect(within(article).getByRole('heading', { level: 2, name: doc.name })).toBeTruthy();
      for (const w of doc.walkthroughs) expect(within(article).getAllByText(w.title).length).toBeGreaterThan(0);
    }
  });

  it('an employee only sees documentation for modules in their own menu', () => {
    as({});
    const { container } = render(<SupportDocs />);
    const names = indexButtons(container).map((b) => b.textContent);
    for (const n of ['Getting Started', 'Dashboard', 'Workday', 'Knowledge Base', 'Item Management', 'Construction', 'Support']) {
      expect(names).toContain(n);
    }
    for (const n of ['Tasks', 'Tickets', 'People', 'Accounting', 'Investor Relations', 'Credential Vault', 'Settings', 'Workforce Analytics']) {
      expect(names).not.toContain(n);
    }
    // Search cannot reach a hidden module either.
    fireEvent.change(screen.getByLabelText('Search the documentation'), { target: { value: 'capital call' } });
    expect(indexButtons(container)).toHaveLength(0);
    expect(screen.queryByRole('heading', { level: 2, name: 'Investor Relations' })).toBeNull();
  });

  it('a grant adds that module documentation', () => {
    as({ grants: new Set(['tasks']) });
    const { container } = render(<SupportDocs />);
    const names = indexButtons(container).map((b) => b.textContent);
    expect(names).toContain('Tasks');
    expect(names).not.toContain('Tickets');
  });

  it('external guests see only what they were granted', () => {
    as({ external: true, grants: new Set(['documents']) });
    const { container } = render(<SupportDocs />);
    expect(indexButtons(container).map((b) => b.textContent)).toEqual(['Getting Started', 'Documents']);
  });

  it('a remembered page the person cannot open falls back to Getting Started', () => {
    localStorage.setItem('nexus-support-docs-last', 'accounting');
    as({});
    render(<SupportDocs />);
    expect(screen.getByRole('heading', { level: 2, name: 'Getting Started' })).toBeTruthy();
    localStorage.removeItem('nexus-support-docs-last');
  });

  it('search narrows the index to matching modules', () => {
    as({ admin: true });
    const { container } = render(<SupportDocs />);
    fireEvent.change(screen.getByLabelText('Search the documentation'), { target: { value: 'punch in' } });
    const names = indexButtons(container).map((b) => b.textContent);
    expect(names).toContain('Workday');
    expect(names).not.toContain('Investor Relations');
  });

  it('content is complete and follows the house style', () => {
    const ids = new Set();
    for (const doc of DOCS) {
      expect(ids.has(doc.id)).toBe(false);
      ids.add(doc.id);
      expect(DOC_GROUPS).toContain(doc.group);
      expect(doc.walkthroughs.length).toBeGreaterThan(0);
      expect(doc.features.length).toBeGreaterThan(0);
      if (doc.shot) expect(shotLegend(doc.shot).length).toBeGreaterThan(0);
      // Em dashes read as AI-generated (CLAUDE.md) - plain hyphens only.
      expect(JSON.stringify(doc)).not.toMatch(/—/);
    }
  });
});
