// The first page of a PFS: the Statement of Financial Condition (Charmi,
// 10/04: "You need to build out the first page of our PFS"). The server
// computes it (`condition` on the statement, see _condition in routers/pfs.py);
// a statement kept before Oct 6 has none, so it is read from that statement's
// summary instead - the same figures, without the bank form's fixed lines.
// The screen, the PDF and the workbook all read it through here.

export function conditionOf(statement) {
  if (statement?.condition) return statement.condition;
  const s = statement?.summary || { assets: [], liabilities: [] };
  const t = statement?.totals || { assets: 0, liabilities: 0 };
  const rows = (list) => list.map((x, i) => ({ key: `l${i}`, label: x.label, ownership: '', count: 1, amount: x.amount }));
  return {
    assets: rows(s.assets || []), liabilities: rows(s.liabilities || []),
    totals: { assets: t.assets, liabilities: t.liabilities },
    contingent: [], contingentAnswer: null, income: null,
  };
}

/** "Neil R. Kadakia and Archana Kadakia" - the names the first page is headed with. */
export const statementName = (statement) => statement?.profile?.displayName || statement?.profile?.name || 'Guarantor';
