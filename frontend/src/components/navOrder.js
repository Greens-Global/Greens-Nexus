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
