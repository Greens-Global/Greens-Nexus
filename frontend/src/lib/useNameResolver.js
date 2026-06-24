import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { cleanName, emailToName } from './utils';

// Resolves a work email to the person's real display name from the roles
// directory (the same Microsoft Graph data as the Outlook GAL), falling back to a
// name derived from the email when the person isn't in the directory. People must
// always be shown by their first + last name, never a raw email address.
//
// Returns a stable resolver: nameOf(email, storedName?) — a stored display name,
// if given, always wins; then the directory; then the email-derived name.
// The directory fetch is cached/deduped in api.js, so calling this from several
// components is cheap.
export function useNameResolver() {
  const [dir, setDir] = useState({});
  useEffect(() => {
    let alive = true;
    api.getRolesDirectory()
      .then(rows => {
        if (!alive) return;
        const m = {};
        for (const u of rows || []) {
          const e = (u.email || '').toLowerCase();
          if (e) m[e] = cleanName(u.name || u.display_name || '');
        }
        setDir(m);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return useCallback((email, storedName) => {
    const s = cleanName((storedName || '').trim());
    if (s) return s;
    const e = (email || '').toLowerCase();
    return dir[e] || emailToName(email);
  }, [dir]);
}
