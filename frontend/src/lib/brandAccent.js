import { api } from '../api';

// Applies the saved company accent (backend routers/branding.py; set in
// Settings > Global Settings > Branding & Policies > Brand Color since Sep 26 -
// views/BrandingPoliciesSettings.jsx, which calls this again after a save so
// the change shows at once) as the --wk-brand
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
// Presets. `login` is LoginPage's three-stop hero palette for the same choice.
export const ACCENT_VARS = {
  // hover is the same hue a shade darker, matching how the cobalt pair is built
  green: { brand: 'hsl(var(--color-green))', hov: 'hsl(142,60%,27%)', tint: 'hsla(var(--color-green),0.12)',
           login: { light: 'hsl(142,55%,42%)', base: 'hsl(142,60%,35%)', dark: 'hsl(142,65%,25%)', tint: 'hsla(142,60%,35%,0.14)', shadow: 'hsla(142,60%,35%,.28)' } },
  blue:  { brand: '#2b45e1', hov: '#1f36c7', tint: '#e8ecfd',
           login: { light: '#3a52e6', base: '#2b45e1', dark: '#1f36c7', tint: '#e8ecfd', shadow: 'rgba(43,69,225,.28)' } },
};

// '#1d4ed8' -> [h 0-360, s 0-100, l 0-100]
export function hexToHsl(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let hue = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  }
  return [Math.round((hue * 60 + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

// The whole variable set for a saved config ({accent, customHex, opacity}).
// A custom color derives hover (8% darker), a light-theme tint (12% alpha),
// a dark-theme tint (22% alpha, so it still reads on a dark card) and the
// sign-in hero stops; opacity (30-100, enforced server-side) scales the
// solid colors only - tints are already translucent.
export function accentVars(cfg) {
  if (cfg?.accent !== 'custom' || !/^#[0-9a-f]{6}$/i.test(cfg.customHex || '')) {
    return ACCENT_VARS[cfg?.accent] || ACCENT_VARS.green;
  }
  const [h, s, l] = hexToHsl(cfg.customHex);
  const a = Math.min(Math.max(Number(cfg.opacity) || 100, 30), 100) / 100;
  const c = (dl, al = a) => `hsla(${h},${s}%,${Math.min(Math.max(l + dl, 0), 100)}%,${al})`;
  return {
    brand: c(0), hov: c(-8), tint: c(0, 0.12), tintDark: c(0, 0.22),
    login: { light: c(7), base: c(0), dark: c(-10), tint: c(0, 0.14), shadow: c(0, 0.28) },
  };
}

const STYLE_ID = 'nexus-brand-accent';

// Writes the stylesheet. `[data-theme="dark"]` has the same specificity as
// style.css's dark rule and comes later, so it wins there, and it still loses
// to the Warm theme's more specific `:root[data-wktheme="warm"]`.
export function setBrandAccent(cfg) {
  const v = accentVars(cfg);
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);   // last in the cascade, so it wins over :root
  }
  el.textContent =
    `:root{--wk-brand:${v.brand};--wk-brand-hov:${v.hov};--wk-brand-tint:${v.tint};}`
    + (v.tintDark ? `[data-theme="dark"]{--wk-brand-tint:${v.tintDark};}` : '');
}

export async function applyBrandAccent() {
  try { setBrandAccent(await api.getBrandingConfig()); } catch { /* keep CSS defaults */ }
}
