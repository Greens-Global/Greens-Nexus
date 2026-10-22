// Task attachments: file versions and Egnyte links (Neil, Oct 22 2026) - the
// pure helpers, kept apart from the drawer so they can be tested alone.
//
// A task file can have versions (Upload New Version): the rows of one file
// share `versionGroup` and the highest `version` is the current file. The
// server's list already sends only the current one; currentVersionsOf keeps
// the screen right even if a list ever carries several.
//
// An Egnyte link (kind "egnyte") is a LINK to a file or folder in the company
// Egnyte, never a copy: it opens in Egnyte, where each viewer's own Egnyte
// permissions apply. The server takes only https links on the company Egnyte
// host; egnyteLinkProblem says the same thing up front.

/** One row per file: the highest version of each group, in first-seen order. */
export function currentVersionsOf(rows) {
  const best = new Map();
  const order = [];
  for (const a of rows || []) {
    const g = a.versionGroup || a.id;
    if (!best.has(g)) order.push(g);
    const cur = best.get(g);
    if (!cur || (a.version || 1) > (cur.version || 1)) best.set(g, a);
  }
  return order.map((g) => best.get(g));
}

export const isEgnyteLink = (a) => a?.kind === 'egnyte';

/** May this row take "Upload New Version"? Task files only - not a file
 *  attached to a comment, not an Egnyte link (Egnyte keeps its own). */
export const canVersion = (a) => !!a && !isEgnyteLink(a) && !a.commentId;

/** The link a row may open: https only, whatever the row says. */
export function safeEgnyteHref(a) {
  const u = String(a?.url || '');
  return /^https:\/\//i.test(u) ? u : '';
}

/** "" when `value` is a link the server will take, else what is wrong.
 *  `host` is the company Egnyte host (/egnyte/status webHost); "" = unknown,
 *  and then only the https shape is checked (the server has the last word).
 *  The host is read from the RAW text, the way the server reads it
 *  (tasks._check_egnyte_url) - never through new URL(), which would bend a
 *  trailing dot, full-width dots or an IDN look-alike into the real host
 *  and pass a link the server then refuses. */
export function egnyteLinkProblem(value, host = '') {
  const s = String(value || '').trim();
  if (!s) return 'Paste the link to the Egnyte file or folder.';
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return 'Paste the Egnyte link exactly as Egnyte shows it.';
  const own = String(host || '').toLowerCase();
  const where = own ? `the company Egnyte (${own})` : 'the company Egnyte';
  const m = /^https:\/\/([^/?#]*)/i.exec(s);
  if (!m) {
    return /^[a-z][a-z0-9+.-]*:/i.test(s)
      ? `Only https links to ${where} can be added.`
      : 'That is not a link. Copy it from Egnyte and paste it here.';
  }
  const authority = m[1];
  // ASCII only, no user@ part, no backslash, one optional port.
  if (!/^[\x21-\x7e]*$/.test(authority) || /[@\\]/.test(authority)) return `Only links to ${where} can be added.`;
  const hp = /^([^:]+)(?::(\d*))?$/.exec(authority);
  if (!hp) return 'That is not a link. Copy it from Egnyte and paste it here.';
  if (hp[2] && Number(hp[2]) !== 443) return `Only links to ${where} can be added.`;
  if (own && hp[1].toLowerCase() !== own) return `Only links to ${where} can be added.`;
  return '';
}

/** What a pasted link says about itself: the /Shared/... path of an Egnyte
 *  address-bar link (...#storage/files/1/Shared/...), its last part as the
 *  name, and whether it is a folder. Unknown parts are ''/null. */
export function egnyteLinkInfo(value) {
  const s = String(value || '').trim();
  const m = s.match(/#storage\/files\/1(\/[^?]*)/);
  let path = '';
  if (m) {
    try { path = decodeURIComponent(m[1]); } catch { path = m[1]; }
  }
  path = path.replace(/\/+$/, '');
  const name = path ? path.split('/').filter(Boolean).pop() || '' : '';
  let isFolder = null;
  if (/\/navigate\/folder\//.test(s) || m) isFolder = true;
  else if (/\/navigate\/file\//.test(s)) isFolder = false;
  return { path, name, isFolder };
}

/** "/Shared/Leases/Temecula" -> ["Shared", "Leases", "Temecula"]; the row
 *  shows the folders above the item (its own name is shown already). */
export function egnyteCrumbs(path, { withLast = false } = {}) {
  const parts = String(path || '').split('/').filter(Boolean);
  return withLast ? parts : parts.slice(0, -1);
}
