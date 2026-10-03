// Pictures and files in a rich body, made renderable on the hosted app.
//
// A protected upload (ticket-evidence, task-files...) is stored by its
// canonical storage URL and reaches the browser as the file viewer's URL
// (lib/storageView.js). On the hosted app (BFF mode) that viewer URL is
// RELATIVE - "/api/files/view?u=..." - and tasks/lib.js's sanitizeRichHtml
// only keeps http(s):, mailto: and data:image/ URLs, so an uploaded picture in
// a reply lost its src the moment it was rendered (Oct 2026). Pinning the
// viewer prefix to this page's own origin makes it an ordinary https: URL to
// the same place. Render-time only: never store what this returns - the
// request rewrite in api.js only recognizes the relative viewer URL.
import { VIEW_PREFIX } from './storageView';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function absolutizeViewUrls(html, {
  prefix = VIEW_PREFIX,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
} = {}) {
  if (!html || typeof html !== 'string' || !prefix.startsWith('/') || !origin || !html.includes(prefix)) return html;
  const re = new RegExp(`(\\b(?:src|href)\\s*=\\s*["']?\\s*)${esc(prefix)}`, 'gi');
  return html.replace(re, (_m, lead) => `${lead}${origin}${prefix}`);
}
