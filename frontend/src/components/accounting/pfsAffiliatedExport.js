// PFS Affiliated Entities and the co-borrower's executive profile in the
// exports (Charmi, 10/04). Pure helpers, no React, so pfsPdf.js and
// pfsXlsx.js can use them without pulling a screen into the export bundle.
//
// Both come from the statement the server computed (routers/pfs_affiliates.py
// `attach`): `statement.affiliated` = { borrowers: [{ key, name }], rows } and
// `statement.executiveProfiles` = [{ key, name, text }]. A statement kept on
// record before 10/06 has neither, and every helper here returns nothing for
// it - the export then looks exactly as it did.

const pctText = (n) => (n == null || n === '' ? '' : `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);

/** The Affiliated Entities table of a statement: the borrowers (one ownership
 * column each), the column headers, and one row of raw values per entity
 * ([name, type, EIN last 4, state, ...ownership per borrower, beneficial, role, notes]). */
export function affiliatedRows(statement) {
  const a = statement?.affiliated;
  const borrowers = a?.borrowers?.length ? a.borrowers : [{ key: 'primary', name: statement?.profile?.name || 'Borrower' }];
  const columns = [
    { key: 'name', label: 'Entity Name' }, { key: 'type', label: 'Entity Type' }, { key: 'ein', label: 'EIN (Last 4)' }, { key: 'state', label: 'State' },
    ...borrowers.map((b) => ({ key: `own:${b.key}`, label: `${b.name} Ownership`, pct: true })),
    { key: 'beneficial', label: 'Beneficial Ownership', pct: true }, { key: 'role', label: 'Role' }, { key: 'notes', label: 'Notes' },
  ];
  const rows = (a?.rows || []).map((r) => [
    r.name || '', r.entityTypeLabel || '', r.einLast4 ? `XX-XXX${r.einLast4}` : '', r.state || '',
    ...borrowers.map((b) => (r.ownership?.[b.key] ?? null)),
    r.beneficialPct ?? null, r.role || '', r.notes || '',
  ]);
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
    const fixed = { type: 78, ein: 46, state: 36, beneficial: 54 };
    const pcts = shown.filter((c) => c.key.startsWith('own:')).length;
    const rest = width - Object.values(fixed).reduce((s, v) => s + v, 0) - pcts * 54;
    const cols = shown.map((c) => ({
      label: c.key.startsWith('own:') ? `${c.label.replace(/ Ownership$/, '').split(' ')[0]} %` : c.key === 'beneficial' ? 'Beneficial %' : c.label,
      width: fixed[c.key] || (c.key.startsWith('own:') ? 54 : c.key === 'name' ? Math.round(rest * 0.62) : Math.round(rest * 0.38)),
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
 * entered must read blank, never 0%. */
export function pfsExtraSheets(statement) {
  const out = [];
  const { columns, rows } = affiliatedRows(statement);
  if (rows.length) out.push({ name: 'Affiliated Entities', title: 'Affiliated Entities', cols: columns.map((c) => ({ label: c.label })), rows: rows.map((r) => r.map((v, i) => (columns[i].pct ? pctText(v) : (v ?? '')))) });
  const co = coExecutiveProfile(statement);
  if (co) out.push({ name: 'Co-Borrower Profile', title: `Executive Profile - ${co.name}`, text: co.text });
  return out;
}
