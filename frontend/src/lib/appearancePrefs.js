// Appearance follows the account (11/13/2026).
//
// Dark Mode ('gg-theme', App.jsx) and the Theme ('wk-theme', TopHeader.jsx)
// were kept in this browser only, so a person who chose Dark at their desk
// found Light on their laptop. They are now ALSO kept in the person's
// profile prefs - the same per-person document Navigation Motion uses
// (tasks/tableCols.jsx, `/task-prefs`), table "appearance", in its `data`
// (the opaque part the client owns): { mode: 'dark' | 'light',
// theme: 'cobalt' | 'warm' }.
//
// localStorage stays the first-paint value: the app still reads it before
// anything is fetched, so there is no flash of the wrong look. When the
// account answers, ONE pass settles the two (reconcileAppearance):
//
//   the account has a value        it wins - this device now shows it
//   the account has none           a look this device chose (anything but
//                                  the default) is lifted to the account;
//                                  a device on the default changes nothing,
//                                  so a new account keeps today's default
//   changed here before it answered  that change wins and is saved
//
// After that, a change on this device is written to both. Nothing happens
// while acting as someone else (the prefs on the wire are theirs), or when
// the account could not be asked (offline: the cached copy may be another
// person's on a shared computer).
import { useEffect, useRef } from 'react';
import { getActAsSessionId } from '../api';
import { useTableValue, whenTablePrefsLoaded } from '../tasks/tableCols';

export const TABLE = 'appearance';
export const MODES = ['light', 'dark'];
export const THEMES = ['cobalt', 'warm'];
export const DEFAULTS = Object.freeze({ mode: 'light', theme: 'cobalt' });
const ALLOWED = { mode: MODES, theme: THEMES };
const KEYS = Object.keys(ALLOWED);

/** Only the keys we know, only the values we know. */
export function cleanAppearance(raw) {
  const out = {};
  for (const k of KEYS) if (raw && ALLOWED[k].includes(raw[k])) out[k] = raw[k];
  return out;
}

/** What to do when the account's answer arrives.
 *    local    what this device shows now ({ mode, theme })
 *    account  what the account holds (may be {} or partial)
 *    touched  keys the person changed on this device before the answer
 *  Returns { apply, save }: `apply` holds the keys this device must switch
 *  to; `save` is the whole document to store, or null when the account is
 *  already right. */
export function reconcileAppearance({ local = {}, account = {}, fromServer = true, touched = {} } = {}) {
  const apply = {};
  if (!fromServer) return { apply, save: null };
  const here = cleanAppearance(local);
  const acct = cleanAppearance(account);
  const next = { ...acct };
  let dirty = false;
  for (const k of KEYS) {
    if (here[k] === undefined) continue;                 // this surface does not show that key
    if (touched[k]) {
      if (acct[k] !== here[k]) { next[k] = here[k]; dirty = true; }
    } else if (acct[k] !== undefined) {
      if (acct[k] !== here[k]) apply[k] = acct[k];
    } else if (here[k] !== DEFAULTS[k]) {
      next[k] = here[k]; dirty = true;
    }
  }
  return { apply, save: dirty ? next : null };
}

const NOTHING = Object.freeze({});

// True while acting as someone else. Guarded like lib/offline/identity.js: a
// screen test that mocks the api module without this export must not throw.
function actingAs() {
  try { return !!getActAsSessionId(); } catch { return false; }
}

/** Mounted once, by the header (it holds both looks). `theme` is 'light' |
 *  'dark' and only toggles (`onThemeToggle`); `wkTheme` sets by name. */
export function useAccountAppearance({ theme, onThemeToggle, wkTheme, setWkTheme }) {
  const [, saveDoc] = useTableValue(TABLE, 'data', NOTHING);
  // What the header holds right now, for the answer that arrives later
  // (declared first, so it is current before the effects below read it).
  const latest = useRef(null);
  useEffect(() => { latest.current = { theme, onThemeToggle, wkTheme, setWkTheme, saveDoc }; });
  const account = useRef(null);                  // what the account holds, once it has answered
  const shown = useRef({ mode: theme, theme: wkTheme });
  const touched = useRef({});

  useEffect(() => {
    if (actingAs()) return undefined;
    let live = true;
    whenTablePrefsLoaded().then(({ prefs, fromServer }) => {
      if (!live || !fromServer || actingAs()) return;
      const now = latest.current;
      const { apply, save } = reconcileAppearance({
        local: { mode: now.theme, theme: now.wkTheme },
        account: prefs?.[TABLE]?.data,
        fromServer, touched: touched.current,
      });
      account.current = save || cleanAppearance(prefs?.[TABLE]?.data);
      if (apply.mode && now.onThemeToggle) now.onThemeToggle();
      if (apply.theme && now.setWkTheme) now.setWkTheme(apply.theme);
      if (save) now.saveDoc(save);
    }).catch(() => { /* the device keeps its own look */ });
    return () => { live = false; };
  }, []);

  // A change on this device: remembered until the account answers, written
  // to it afterwards. Only the key that changed - switching the Theme never
  // stamps this device's Dark Mode on the account, or the other way round.
  useEffect(() => {
    const now = { mode: theme, theme: wkTheme };
    const changed = KEYS.filter((k) => now[k] !== shown.current[k] && ALLOWED[k].includes(now[k]));
    shown.current = now;
    if (!changed.length || actingAs()) return;
    if (!account.current) { for (const k of changed) touched.current[k] = true; return; }
    const next = { ...account.current };
    let dirty = false;
    for (const k of changed) if (next[k] !== now[k]) { next[k] = now[k]; dirty = true; }
    if (!dirty) return;
    account.current = next;
    saveDoc(next);
  }, [theme, wkTheme, saveDoc]);
}
