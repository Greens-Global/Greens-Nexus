// Who may open What's New (Oct 12 2026). Every internal user; an external
// (B2B guest) only with a grant that opens /task-changelog on the API - the
// grants auth.MODULE_API_PREFIXES maps to "/task". One list, read by App.jsx's
// view gate and by the header's entry points, so the two cannot drift apart.
export const WHATS_NEW_GRANTS = ['tasks', 'tickets', 'support'];

export function canOpenWhatsNew({ isExternal, myGrantedModules }) {
  if (!isExternal) return true;
  return WHATS_NEW_GRANTS.some((g) => myGrantedModules?.has?.(g));
}
