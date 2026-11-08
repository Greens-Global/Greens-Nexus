import { useEffect, useState } from 'react';
import { api } from '../api';

// People profile photos for the whole app, keyed by lowercased work email.
// The source is the curated Nexus People directory (nexus_employees.photo_url) -
// the same list every people picker reads, never an M365/GAL-derived one (see
// CLAUDE.md) - fetched once per session and shared, so a header avatar and fifty
// task avatars cost one request between them. Module-scope cache + subscriber
// set so avatars that mounted before the directory arrived re-render when it does.
let _photoMap = null;
let _photoPromise = null;
let _photoFailed = false;
const _photoSubs = new Set();

function _load() {
  // A throw (an api without the call, as in a test's partial mock) lands in
  // the catch below instead of the render.
  let req;
  try { req = api.getPeopleDirectory(); } catch (e) { req = Promise.reject(e); }
  _photoPromise = Promise.resolve(req).then((rows) => {
    _photoMap = {};
    _photoFailed = false;
    for (const r of rows || []) if (r.email) _photoMap[r.email.toLowerCase()] = r.photoUrl || '';
    _photoSubs.forEach((f) => f((x) => x + 1));
  }).catch(() => { _photoMap = {}; _photoFailed = true; });
  return _photoPromise;
}

export function usePhotoMap() {
  const [, force] = useState(0);
  useEffect(() => {
    // Always subscribe, even if the map already resolved before this mount -
    // otherwise a refreshPhotoMap() call later (My Profile photo change) has
    // no subscriber to notify and this component never re-renders.
    _photoSubs.add(force);
    if (!_photoMap && !_photoPromise) _load();
    return () => _photoSubs.delete(force);
  }, []);
  return _photoMap || {};
}

// The signed-in person's own photo (TopHeader, MobileMenu - the only callers).
// The directory is the whole roster and takes a moment on every page load, so
// the header used to show the initials first and the photo a beat later - on
// every reload (11/05/2026: "switches between the photo and NK"). The last
// photo the directory gave is remembered in this browser and shown until the
// directory answers (or when it fails); '' = no photo, initials.
const MEMO = 'nexus.ownPhoto.';
function recall(key) {
  try { return localStorage.getItem(MEMO + key) || ''; } catch { return ''; }
}
export function usePersonPhoto(email) {
  const photos = usePhotoMap();
  const key = (email || '').toLowerCase();
  const known = !!_photoMap && !_photoFailed;
  const photo = known ? (photos[key] || '') : '';
  useEffect(() => {
    if (!key || !known) return;
    try {
      if (photo) localStorage.setItem(MEMO + key, photo); else localStorage.removeItem(MEMO + key);
    } catch { /* storage blocked - the initials show until the directory answers */ }
  }, [key, known, photo]);
  if (!key) return '';
  return known ? photo : recall(key);
}

// Drop the cached directory and re-fetch, notifying every mounted avatar -
// call after the signed-in user changes their own photo (My Profile) so the
// header avatar and every other avatar of them update without a page reload.
export function refreshPhotoMap() {
  _photoMap = null;
  _load();
}
