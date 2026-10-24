// Who owns the picked element's file (Build Mode v2, Oct 24 2026). The map
// comes from the server (`GET /dev-notes/enabled` -> `owners`, a copy of
// backend/code_owners.py, which mirrors the CLAUDE.md File Ownership table).
// The server decides whether a pin is held - this only lets the composer say
// so before the pin is saved. Same rules as code_owners.normalize/owner_of:
// source stamps are relative to frontend/ ("src/..."), a path ending in "/"
// is a whole folder.

export function normalizePath(path = '') {
  let p = String(path || '').trim().replace(/\\/g, '/');
  const at = p.indexOf('/frontend/src/');
  if (at > 0) p = p.slice(at + 1);              // an absolute path from a dev build
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '');
  if (p.startsWith('src/')) p = `frontend/${p}`;
  return p;
}

/** { name, email } of the owner of `file`, or null. */
export function ownerOf(file, owners = []) {
  const f = normalizePath(file);
  if (!f || !Array.isArray(owners)) return null;
  for (const o of owners) {
    for (const raw of (o && Array.isArray(o.paths) ? o.paths : [])) {
      const p = normalizePath(raw);
      if (!p) continue;
      if (p.endsWith('/') ? f.startsWith(p) : f === p) return { name: o.name || o.email || '', email: String(o.email || '').toLowerCase() };
    }
  }
  return null;
}

/** The owner when it is someone other than me (the pin will be held for them). */
export function foreignOwner(file, owners, myEmail = '') {
  const o = ownerOf(file, owners);
  if (!o) return null;
  return o.email && o.email === String(myEmail || '').toLowerCase() ? null : o;
}
