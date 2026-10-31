// The Workflows module's address segment (Oct 28 2026): what comes after
// /workflows/ in the URL. One screen per sub -
//   overview | list | automations | runs | templates | catalog | settings
//   wf:<id>   the builder for one workflow
//   wf:<id>:run:<runId>  the builder replaying that run on its canvas (10/30/2026)
//   run:<id>  the Runs tab with that run's drawer open
// `settings` is Settings > Workflows: WorkflowsApp sends the person there
// (nexus:navigate admin-console / workflows) and shows Overview meanwhile.
// Anything unknown (an old link, a typo) lands on Overview, never blank.

export const SCREENS = ['overview', 'list', 'automations', 'runs', 'templates', 'catalog', 'settings'];

// The tab lit up for each screen (the builder sits under Workflows, a run
// under Runs).
export const TAB_OF = { builder: 'list', run: 'runs' };

export function parseSub(sub) {
  const s = String(sub ?? '').trim();
  if (!s) return { screen: 'overview' };
  if (s.startsWith('wf:') && s.length > 3) {
    const [id, runId] = s.slice(3).split(':run:');
    if (!id) return { screen: 'overview' };
    return runId ? { screen: 'builder', id, runId } : { screen: 'builder', id };
  }
  if (s.startsWith('run:') && s.length > 4) return { screen: 'run', id: s.slice(4) };
  if (SCREENS.includes(s)) return { screen: s };
  return { screen: 'overview' };
}

export function buildSub(screen, id, runId) {
  if (screen === 'builder') return id ? (runId ? `wf:${id}:run:${runId}` : `wf:${id}`) : 'list';
  if (screen === 'run') return id ? `run:${id}` : 'runs';
  return SCREENS.includes(screen) ? screen : 'overview';
}

/** Which ModuleTabs key a sub lights up. */
export function tabFor(sub) {
  const { screen } = parseSub(sub);
  return TAB_OF[screen] || (screen === 'settings' ? 'overview' : screen);
}
