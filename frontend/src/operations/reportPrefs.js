// Operations > Reports: per-viewer conveniences kept in this browser only -
// favorite reports, the last few opened, and each report's last choices.
// Storage can be missing or blocked (private windows), so every read and write
// is wrapped and the screen works the same without it.
const KEY = 'nexus.opsReports.';

function read(name, fallback) {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY + name));
    return v ?? fallback;
  } catch { return fallback; }
}
function write(name, value) {
  try { window.localStorage.setItem(KEY + name, JSON.stringify(value)); } catch { /* storage blocked */ }
}

export const getFavorites = () => { const v = read('favorites', []); return Array.isArray(v) ? v : []; };
export function toggleFavorite(key) {
  const list = getFavorites();
  const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  write('favorites', next);
  return next;
}

export const getRecent = () => { const v = read('recent', []); return Array.isArray(v) ? v : []; };
export function pushRecent(key) {
  const next = [key, ...getRecent().filter((k) => k !== key)].slice(0, 5);
  write('recent', next);
  return next;
}

// { period, options, format } - the facilities always follow the page's picker.
export const getChoices = (kind) => { const v = read(`choices.${kind}`, null); return v && typeof v === 'object' ? v : null; };
export const saveChoices = (kind, { period, options, format }) => write(`choices.${kind}`, { period, options, format });
