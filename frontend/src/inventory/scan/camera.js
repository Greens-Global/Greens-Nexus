// Items phase 4 - the phone's camera, opened and put away carefully.
//
// getUserMedia for the back camera, the reasons it can fail sorted into what
// the person can do about each, the torch where the track offers one, and
// one stop() that every exit path calls (close, unmount, the tab hidden) so
// the camera light never stays on behind Nexus.

/** 'ok' | 'insecure' (http: the browser hides the camera) | 'unsupported'. */
export function cameraSupport(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return 'unsupported';
  if (win.isSecureContext === false) return 'insecure';
  return win.navigator?.mediaDevices?.getUserMedia ? 'ok' : 'unsupported';
}

/** Does this device have a camera at all? (Labels are not needed, so no permission is asked.) */
export async function hasVideoInput(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  try {
    const list = await nav?.mediaDevices?.enumerateDevices?.();
    return Array.isArray(list) && list.some((d) => d.kind === 'videoinput');
  } catch { return false; }
}

/** The back camera's stream. Throws what getUserMedia throws. */
export async function startCamera(nav = navigator) {
  return nav.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
}

/** Turn a getUserMedia failure into what the screen says: denied | nocamera | busy | insecure | error. */
export function cameraErrorKind(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'SecurityError') return 'insecure';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'nocamera';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
  return 'error';
}

export function stopStream(stream) {
  try { stream?.getTracks?.().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } }); } catch { /* nothing to stop */ }
}

export function videoTrack(stream) {
  try { return stream?.getVideoTracks?.()[0] || null; } catch { return null; }
}

export function torchSupported(track) {
  try { return !!track?.getCapabilities?.()?.torch; } catch { return false; }
}

export async function setTorch(track, on) {
  await track.applyConstraints({ advanced: [{ torch: !!on }] });
}

/**
 * How to let Nexus use the camera again, in this browser's own words.
 * { title, steps: [string] }
 */
export function cameraHelp(kind, ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
  const android = /Android/i.test(ua);
  if (kind === 'denied') {
    if (ios) return { title: 'Camera Access Is Off', steps: [
      'Tap the "aA" button in the address bar, then Website Settings.',
      'Set Camera to Allow, then tap Try Again.',
      'If it is not there: Settings > Apps > Safari > Camera > Allow.',
    ] };
    if (android) return { title: 'Camera Access Is Off', steps: [
      'Tap the icon to the left of the address, then Permissions.',
      'Turn Camera on, then tap Try Again.',
    ] };
    return { title: 'Camera Access Is Off', steps: [
      'Click the camera or lock icon in the address bar.',
      'Allow the camera for this site, then click Try Again.',
    ] };
  }
  if (kind === 'insecure') return { title: 'The Camera Needs a Secure Page', steps: [
    'This browser only opens the camera on an https address.',
    'Open Nexus from its usual https link, or type the serial below.',
  ] };
  if (kind === 'nocamera') return { title: 'No Camera Found', steps: [
    'This device has no camera Nexus can use.',
    'Type the serial printed on the tag below instead.',
  ] };
  if (kind === 'busy') return { title: 'The Camera Is Busy', steps: [
    'Another app or tab is using the camera.',
    'Close it, then tap Try Again.',
  ] };
  if (kind === 'unsupported') return { title: 'This Browser Cannot Scan', steps: [
    'This browser does not let pages use the camera.',
    'Type the serial printed on the tag below instead.',
  ] };
  return { title: 'The Camera Did Not Start', steps: ['Tap Try Again, or type the serial printed on the tag below.'] };
}
