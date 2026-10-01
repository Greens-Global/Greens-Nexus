import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// The sign-in screen must never wear the loader ring's `nxl` class (Oct 1): the
// global `.nxl` rule (style.css) sizes the ring at 20px, and on the sign-in
// root it shrank the whole page to a 20px square - a white screen for
// everyone signed out.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: { loginRedirect: vi.fn() }, accounts: [] }) }));
vi.mock('../lib/queries', () => ({ useBranding: () => ({ data: null }) }));
vi.mock('../bffAuth', () => ({ BFF_MODE: true, clearSignedOutMarker: vi.fn() }));

const LoginPage = (await import('./LoginPage')).default;

afterEach(cleanup);

describe('LoginPage', () => {
  it('renders the sign-in screen without the loader ring class on any element', () => {
    const { container, getByText } = render(<LoginPage />);
    expect(getByText(/Sign in with your account to continue/)).toBeTruthy();
    const root = container.firstElementChild;
    expect(root.classList.contains('nxl-page')).toBe(true);
    expect(container.querySelectorAll('.nxl').length).toBe(0);
  });

  it("keeps its own full-screen rule on the page's class, not the loader's", () => {
    const { container } = render(<LoginPage />);
    const css = [...container.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).toMatch(/\.nxl-page\s*\{\s*position:\s*fixed;\s*inset:\s*0/);
    expect(css).not.toMatch(/(^|[\s,}])\.nxl\s*\{/);
  });
});
