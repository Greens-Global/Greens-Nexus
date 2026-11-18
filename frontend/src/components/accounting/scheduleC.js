import { FORMS, SKIP as ENGINE_SKIP, layoutForm, lineFor as engineLineFor, lineText as engineLineText, mapsOf as engineMapsOf, suggestLine as engineSuggest } from './taxForms/engine';
import { runTaxReport, mapEntityOf as engineMapEntityOf } from './taxForms/run';

// Accounting -> Reports -> Schedule C (Draft) (Neil, Viral, 10/27 triage item
// 18). Since 11/19/2026 (Charmi: "We need Sch C, Sch E, 1040, 1065, form 568,
// 1120") Schedule C is one form of the tax engine (taxForms/engine.js, its
// lines in taxForms/schedule_c.json); this file keeps the names the screens
// and tests already use.

export const FORM = 'schedule_c';
const DEF = FORMS.schedule_c;
const REPORT = DEF.reports[0];
const PART = { income: 1, expenses: 2, home: 3 };
// part: 1 income, 2 expenses, 3 after line 29. sign: +1 adds income, -1 adds expense (shown positive).
export const SCHEDULE_C_LINES = REPORT.rows.filter((r) => r.sign != null).map((r) => ({ line: r.line, label: r.label, part: PART[r.group], sign: r.sign }));
export const SKIP = ENGINE_SKIP;
/** "Line 8 - Advertising"; "Not on Schedule C" for skip. */
export const lineText = (line) => engineLineText(DEF, line);
/** A suggested line for one income statement account ({ code, title, section }), or ''. */
export const suggestLine = (account) => engineSuggest(DEF, account);
/** The line an account adds into and where that came from (entity / all / suggested / ''). */
export const lineFor = (account, maps = {}) => engineLineFor(DEF, account, maps);
export const mapsOf = engineMapsOf;
export const mapEntityOf = engineMapEntityOf;

/** Lay Schedule C out from the income statement's sections and the mapping (one column). */
export function scheduleCLayout(sections, maps, { drill = null, label = 'Amount' } = {}) {
  return layoutForm(DEF, REPORT, [{ key: 'amount', label, drill, sections, maps }]);
}

/** Read and lay out Schedule C for one config (see runReport). */
export function scheduleC(api, config, book) {
  return runTaxReport(api, { ...config, report: 'schedule-c' }, book);
}
