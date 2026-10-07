// PFS Affiliated Entities and the co-borrower's executive profile in the
// exports (Charmi, 10/04). Pure helpers, no React, so pfsPdf.js and
// pfsXlsx.js can use them without pulling a screen into the export bundle.
//
// Both come from the statement the server computed (routers/pfs_affiliates.py
// `attach`): `statement.affiliated` = { borrowers: [{ key, name }], rows } and
// `statement.executiveProfiles` = [{ key, name, text }]. A statement kept on
// record before 10/06 has neither, and every helper here returns nothing for
// it - the export then looks exactly as it did.

// Oct 7 (Neil/Charmi): an empty percent prints "-", like every other
// accounting table; EIN and State are no longer printed (still kept on the row).
export const pctText = (n) => (n == null || n === '' ? '-' : `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);

/** Each borrower's role in an entity row (Oct 7): `roles` keyed like
 * `ownership`; a row saved before then has one `role`, the primary's. */
export const rolesOf = (r) => (r?.roles && Object.keys(r.roles).length ? r.roles : r?.role ? { primary: r.role } : {});

/** The Affiliated Entities table of a statement: the borrowers (an ownership
 * and a role column each), the column headers, and one row of raw values per
 * entity ([name, type, ...(ownership, role) per borrower, beneficial, notes]). */
export function affiliatedRows(statement) {
  const a = statement?.affiliated;
  const borrowers = a?.borrowers?.length ? a.borrowers : [{ key: 'primary', name: statement?.profile?.name || 'Borrower' }];
  const columns = [
    { key: 'name', label: 'Entity Name' }, { key: 'type', label: 'Entity Type' },
    ...borrowers.flatMap((b) => [{ key: `own:${b.key}`, label: `${b.name} Ownership`, pct: true }, { key: `role:${b.key}`, label: `${b.name} Role` }]),
    { key: 'beneficial', label: 'Beneficial Ownership', pct: true }, { key: 'notes', label: 'Notes' },
  ];
  const rows = (a?.rows || []).map((r) => {
    const roles = rolesOf(r);
    return [
      r.name || '', r.entityTypeLabel || '',
      ...borrowers.flatMap((b) => [r.ownership?.[b.key] ?? null, roles[b.key] || '']),
      r.beneficialPct ?? null, r.notes || '',
    ];
  });
  return { borrowers, columns, rows };
}

/** The co-borrower's executive profile ({ name, text }), or null. The
 * borrower's own prints where it always has (profile.executiveProfile). */
export function coExecutiveProfile(statement) {
  const co = (statement?.executiveProfiles || []).find((p) => p.key === 'co');
  return co && (co.text || '').trim() ? { name: co.name, text: co.text } : null;
}

/** PDF sections to draw after the executive profile: [{ title, cols?, rows?, text? }].
 * `width` is the printable width; cols are pfsPdf.js table columns, rows text
 * (a row's notes print as its quieter second line). */
export function pfsExtraPdf(statement, width) {
  const out = [];
  const { columns, rows } = affiliatedRows(statement);
  if (rows.length) {
    const shown = columns.filter((c) => c.key !== 'notes');
    const fixed = { type: 78, beneficial: 54 };
    const per = shown.filter((c) => c.key.startsWith('own:')).length;
    const name = Math.max(90, width - fixed.type - fixed.beneficial - per * (46 + 72));
    const first = (label, suffix) => `${label.replace(suffix, '').split(' ')[0]}`;
    const cols = shown.map((c) => ({
      label: c.key.startsWith('own:') ? `${first(c.label, / Ownership$/)} %` : c.key.startsWith('role:') ? `${first(c.label, / Role$/)} Role`
        : c.key === 'beneficial' ? 'Beneficial %' : c.label,
      width: fixed[c.key] || (c.key.startsWith('own:') ? 46 : c.key.startsWith('role:') ? 72 : name),
      num: !!c.pct,
    }));
    const notesAt = columns.findIndex((c) => c.key === 'notes');
    out.push({
      title: 'Affiliated Entities',
      cols,
      rows: rows.map((r) => {
        const cells = r.filter((_, i) => i !== notesAt).map((v, i) => (shown[i].pct ? pctText(v) : String(v ?? '')));
        if (r[notesAt]) cells.sub = r[notesAt];
        return cells;
      }),
    });
  }
  const co = coExecutiveProfile(statement);
  if (co) out.push({ title: `Executive Profile - ${co.name}`, text: co.text });
  return out;
}

/** Excel sheets to add: [{ name, title, cols?, rows?, text? }], with cols in
 * pfsXlsx.js's table shape. Percents go as text ("50%"): a share nobody
 * entered must read "-", never 0%. */
export function pfsExtraSheets(statement) {
  const out = [];
  const { columns, rows } = affiliatedRows(statement);
  if (rows.length) out.push({ name: 'Affiliated Entities', title: 'Affiliated Entities', cols: columns.map((c) => ({ label: c.label })), rows: rows.map((r) => r.map((v, i) => (columns[i].pct ? pctText(v) : (v ?? '')))) });
  const co = coExecutiveProfile(statement);
  if (co) out.push({ name: 'Co-Borrower Profile', title: `Executive Profile - ${co.name}`, text: co.text });
  return out;
}
