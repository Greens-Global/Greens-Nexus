import { api } from '../api';

// Applies the admin-configured accent (AdminPanel -> Branding) as the --wk-brand
// family every "Work OS" surface already reads from - one fetch, applied once
// per app load, post-login (MainApp) and pre-login (LoginPage has its own richer
// multi-stop hero palette but reads the same underlying choice). Best-effort: a
// failed fetch just keeps the CSS defaults baked into style.css.
//
// Injected as a STYLESHEET, not inline styles on <html>. Inline styles beat every
// stylesheet rule regardless of specificity, so the original setProperty() version
// also overrode `:root[data-wktheme="warm"] { --wk-brand: #26241f }` and silently
// cost the Warm sand theme its black pill. A `:root{...}` rule instead:
//   - beats style.css's own `:root` default, because this <style> is appended last
//     (equal specificity, later wins), and
//   - loses to `:root[data-wktheme="warm"]`, which is more specific,
// so per-theme brand overrides keep working. Do NOT switch this back to
// documentElement.style.
//
// --wk-brand-hov must move WITH --wk-brand: style.css:3058 uses it for
// .primary-btn:hover, so setting only the base color left every primary button
// green at rest and cobalt on hover.
const ACCENT_VARS = {
  // hover is the same hue a shade darker, matching how the cobalt pair is built
  green: { brand: 'hsl(var(--color-green))', hov: 'hsl(142,60%,27%)', tint: 'hsla(var(--color-green),0.12)' },
  blue:  { brand: '#2b45e1',                 hov: '#1f36c7',          tint: '#e8ecfd' },
};

const STYLE_ID = 'nexus-brand-accent';

export async function applyBrandAccent() {
  try {
    const { accent } = await api.getBrandingConfig();
    const v = ACCENT_VARS[accent] || ACCENT_VARS.green;
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);   // last in the cascade, so it wins over :root
    }
    el.textContent =
      `:root{--wk-brand:${v.brand};--wk-brand-hov:${v.hov};--wk-brand-tint:${v.tint};}`;
  } catch { /* keep CSS defaults */ }
}
