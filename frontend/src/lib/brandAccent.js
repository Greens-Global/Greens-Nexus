import { api } from '../api';

// Applies the admin-configured accent (AdminPanel -> Branding) as the
// --wk-brand / --wk-brand-tint CSS vars every "Work OS" surface already reads
// from (style.css's :root default is the original blue) - one fetch, applied
// once per app load, works identically post-login (MainApp) and pre-login
// (LoginPage has its own richer multi-stop palette for the hero gradient, but
// reads the same underlying accent choice). Best-effort: a failed fetch just
// keeps the CSS defaults already baked into style.css.
const ACCENT_VARS = {
  green: { brand: 'hsl(var(--color-green))', tint: 'hsla(var(--color-green),0.12)' },
  blue:  { brand: '#2b45e1',                  tint: '#e8ecfd' },
};

export async function applyBrandAccent() {
  try {
    const { accent } = await api.getBrandingConfig();
    const vars = ACCENT_VARS[accent] || ACCENT_VARS.green;
    document.documentElement.style.setProperty('--wk-brand', vars.brand);
    document.documentElement.style.setProperty('--wk-brand-tint', vars.tint);
  } catch { /* keep CSS defaults */ }
}
