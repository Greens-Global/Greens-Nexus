// The Modules group reads alphabetically (Neil, Oct 21 2026). Sorted here at
// render time - the groups are the runs between dividers, Modules is the third -
// so NAV itself stays append-only and the phone menu gets the same order.
export function orderNav(items) {
  const out = [];
  let group = 0;
  let run = [];
  const flush = () => {
    if (group === 2) run.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    out.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.divider) { flush(); group += 1; out.push(item); } else run.push(item);
  }
  flush();
  return out;
}

// The rail's Modules group in sections (11/05/2026): one run of nine icons
// read as a wall. On the computer rail it splits into Operations, Finance and
// Company, each behind a hairline divider (and its label on the open rail),
// alphabetical inside each section as above. A module in no section goes
// last, under the old "Modules" label. The phone menu keeps the one group.
// Returns the items with each divider carrying its `kicker` (label).
export const MODULE_SECTIONS = [
  ['Operations', ['property-asset', 'ops', 'it', 'inventory', 'operations']],
  ['Finance', ['accounting', 'investor-relations']],
  ['Company', ['marketing', 'hr']],
];
export function railSections(items, kickers) {
  const out = [];
  let group = 0;
  let run = [];
  const sectionOf = (item) => {
    const i = MODULE_SECTIONS.findIndex(([, views]) => views.includes(item.view));
    return i < 0 ? MODULE_SECTIONS.length : i;
  };
  const label = (s) => MODULE_SECTIONS[s]?.[0] ?? kickers[2];
  const flush = () => {
    if (group !== 2) { out.push(...run); run = []; return; }
    const sorted = run.map((item, i) => ({ item, i, s: sectionOf(item) })).sort((a, b) => a.s - b.s || a.i - b.i);
    let last = null;
    for (const { item, s } of sorted) {
      if (last === null) {
        // The Modules divider itself takes the first section's name.
        const prev = out[out.length - 1];
        if (prev?.divider) out[out.length - 1] = { ...prev, kicker: label(s) };
      } else if (s !== last) {
        out.push({ divider: true, kicker: label(s) });
      }
      last = s;
      out.push(item);
    }
    run = [];
  };
  for (const item of items) {
    if (item.divider) { flush(); group += 1; out.push({ ...item, kicker: kickers[group] }); } else run.push(item);
  }
  flush();
  return out;
}
