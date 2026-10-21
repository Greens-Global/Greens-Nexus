// The address-bar aliases, in one place (Oct 14 2026): a module whose
// internal view id is not what the address should read. App.jsx parses and
// writes with these; the Daily Briefing's link map (dashboard/essentials/
// MyDay.jsx) resolves server links with the same table, so an alias added
// here reaches both. Old addresses keep resolving to the same view.
//   itemmanagement <-> inventory   (Neil, Jun 16)
//   construction   <-> ops         (the module was renamed, the id stayed)
//   workday        <-> myhr        (Workday since Sep 3; the address since Oct 14)
//   insights       <-> bi          (Business Intelligence renamed Insights, Neil Oct 14;
//                                   the id stays - it is the stored access grant)
//   team           <-> shifts      (Team since Neil, Oct 13 2026)
//   help-center    <-> support     (Help Center since Neil, Oct 13 2026)
export const PATH_TO_VIEW = { itemmanagement: 'inventory', inventory: 'inventory', construction: 'ops', ops: 'ops', workday: 'myhr', myhr: 'myhr', insights: 'bi', bi: 'bi',
  team: 'shifts', shifts: 'shifts', 'help-center': 'support', support: 'support' };
export const VIEW_TO_PATH = { inventory: 'itemmanagement', ops: 'construction', myhr: 'workday', bi: 'insights', shifts: 'team', support: 'help-center' };

// Purchase Requisition moved to Workday > Purchase Requests (Neil, Oct 22
// 2026). Where an old address goes: the retired 'purchase' view (sub 'new' =
// the form, 'log' = the list) and Item Management's old 'purchasereqs' tab -
// bells, emails, bookmarks and saved dashboard tiles still carry them.
// null = not a moved address.
export function purchaseRedirect(view, sub) {
  if (view === 'purchase') return { view: 'myhr', sub: sub === 'new' ? 'purchase:new' : 'purchase' };
  if (view === 'inventory' && sub === 'purchasereqs') return { view: 'myhr', sub: 'purchase' };
  return null;
}
