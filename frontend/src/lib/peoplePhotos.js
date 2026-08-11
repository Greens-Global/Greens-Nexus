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
const _photoSubs = new Set();

function _load() {
  _photoPromise = api.getPeopleDirectory().then((rows) => {
    _photoMap = {};
    for (const r of rows || []) if (r.email) _photoMap[r.email.toLowerCase()] = r.photoUrl || '';
    _photoSubs.forEach((f) => f((x) => x + 1));
  }).catch(() => { _photoMap = {}; });
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

// '' while the directory is still loading, and for anyone without a photo on
// their HR record - every caller falls back to initials in that case.
export function usePersonPhoto(email) {
  const photos = usePhotoMap();
  return email ? (photos[email.toLowerCase()] || '') : '';
}

// Drop the cached directory and re-fetch, notifying every mounted avatar -
// call after the signed-in user changes their own photo (My Profile) so the
// header avatar and every other avatar of them update without a page reload.
export function refreshPhotoMap() {
  _photoMap = null;
  _load();
}
