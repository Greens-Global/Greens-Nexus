// Import Bookmarks (11/08/2026): the Netscape bookmarks HTML every browser
// exports (Chrome, Edge, Firefox, Safari - one DL / DT / A shape, folders as
// H3). Parsed in the browser; only http(s) links, one per normalized URL.
import { normalizeUrl } from './personalLinkModal.jsx';

const nearestFolder = (a) => {
  // The folder is the H3 that heads the DL this link sits in: the DT holding
  // the H3 is the DL's previous sibling.
  for (let dl = a.closest('dl'); dl; dl = dl.parentElement?.closest('dl')) {
    const h3 = dl.previousElementSibling?.querySelector?.('h3') || (dl.parentElement?.tagName === 'DT' ? dl.parentElement.querySelector('h3') : null);
    if (h3) return h3.textContent.trim();
  }
  return '';
};

// -> [{ title, url, folder }], de-duplicated against the file itself and the
// URLs in `existing` (strings).
export function parseBookmarks(html, existing = []) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const seen = new Set(existing.map(normalizeUrl));
  const out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = (a.getAttribute('href') || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = a.textContent.trim() || key;
    out.push({ title: title.slice(0, 200), url, folder: nearestFolder(a) });
  }
  return out;
}
