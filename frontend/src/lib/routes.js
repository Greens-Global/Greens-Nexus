// The address-bar aliases, in one place (Oct 14 2026): a module whose
// internal view id is not what the address should read. App.jsx parses and
// writes with these; the Daily Briefing's link map (dashboard/essentials/
// MyDay.jsx) resolves server links with the same table, so an alias added
// here reaches both. Old addresses keep resolving to the same view.
//   itemmanagement <-> inventory   (Neil, Jun 16)
//   construction   <-> ops         (the module was renamed, the id stayed)
//   workday        <-> myhr        (Workday since Sep 3; the address since Oct 14)
export const PATH_TO_VIEW = { itemmanagement: 'inventory', inventory: 'inventory', construction: 'ops', ops: 'ops', workday: 'myhr', myhr: 'myhr' };
export const VIEW_TO_PATH = { inventory: 'itemmanagement', ops: 'construction', myhr: 'workday' };
