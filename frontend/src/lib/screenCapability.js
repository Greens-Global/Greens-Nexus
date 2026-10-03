// Can this device record its screen? (Oct 2026, tickets on phones.)
//
// getDisplayMedia does not exist on iOS at all and is a dead end on Android
// Chrome, so on a phone "Record Screen" was a button that could only fail -
// and pressing it still asked for notification permission first (the
// return-cue prime) for a recording that could never start. One check, shared
// by every place that offers recording.
export const PHONE_QUERY = '(max-width: 640px)';

/** `isMobile` from useIsMobile() when the caller has it; read from matchMedia otherwise. */
export function canRecordScreen(isMobile) {
  const phone = isMobile ?? (typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY)?.matches);
  if (phone) return false;
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}
