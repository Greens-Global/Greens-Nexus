import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { cleanName, emailToName } from './utils';

// Resolves a work email to the person's real display name. The curated Nexus
// People directory (nexus_employees) is the source of truth — provision someone
// in People and their name resolves everywhere. The roles directory (old
// GAL-derived list) is kept only as a fallback so historical records naming
// people who are no longer in People still render properly. People must
// always be shown by their first + last name, never a raw email address.
//
// Returns a stable resolver: nameOf(email, storedName?) — a stored display name,
// if given, always wins; then the directory; then the email-derived name.
// The directory fetches are cached/deduped in api.js, so calling this from
// several components is cheap.
export function useNameResolver() {
  const [dir, setDir] = useState({});
  useEffect(() => {
    let alive = true;
    Promise.allSettled([api.getRolesDirectory(), api.getPeopleDirectory()])
      .then(([roles, people]) => {
        if (!alive) return;
        const m = {};
        // roles first, People second — People wins where both know the email
        for (const res of [roles, people]) {
          if (res.status !== 'fulfilled') continue;
          for (const u of res.value || []) {
            const e = (u.email || '').toLowerCase();
            const n = cleanName(u.name || u.display_name || '');
            if (e && n) m[e] = n;
          }
        }
        setDir(m);
      });
    return () => { alive = false; };
  }, []);
  return useCallback((email, storedName) => {
    // The People directory wins over whatever name was stored on the row —
    // stored names go stale ("Neil" typed at assignment time vs "Neil Kadakia"
    // in People). Stored name is only the fallback while the directory loads
    // or for emails People doesn't know.
    const e = (email || '').toLowerCase();
    if (e && dir[e]) return dir[e];
    const s = cleanName((storedName || '').trim());
    return s || emailToName(email);
  }, [dir]);
}
