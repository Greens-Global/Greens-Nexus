// Who may CHANGE What's New (Neil, Oct 12 2026). Reading it is every Nexus
// user's default - the page, the unseen dot, the weekly bar and the update
// popup's See What's New are open to everyone signed in, externals included
// (the server's read routes sit on task_config.view_router, which asks only
// for a signed-in user). Adding, editing, reviewing, publishing and commenting
// stay behind the task family's grant, exactly as the server gates them:
// require_any_module_grant("tasks", "tickets"), administrators bypassing.
export const WHATS_NEW_EDIT_GRANTS = ['tasks', 'tickets'];

export function canEditWhatsNew(role) {
  if (role?.can?.('administrator')) return true;
  return WHATS_NEW_EDIT_GRANTS.some((g) => role?.myGrantedModules?.has?.(g));
}
