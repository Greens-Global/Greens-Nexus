import { formatDate } from '../../../lib/datetime';
import { fetchStatement, iso, pnlByEntity } from '../reportModel';
import { FORMS, SKIP, TAX_REPORTS, layoutForm, mapsOf, rentalMode } from './engine';

// Accounting -> Reports -> Tax (Charmi, 11/19/2026): reads the books for one
// tax report and lays it out with the engine. Every figure comes through the
// accounting proxy (the income statement or the balance sheet, as on Reports)
// and the mapping through GET /accounting/tax-lines - nothing else is read and
// nothing is written. Loaded on first use (runReport).

/** Schedule E reads one income statement per property; more than this at once is refused. */
export const MAX_PROPERTIES = 15;

/** The mapping scope of a config: one entity picked = that entity, else every entity (''). */
export const mapEntityOf = (config) => (config?.entities?.length === 1 ? config.entities[0] : '');

const dayBefore = (s) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() - 1); return iso(d); };
const labelOf = (config) => {
  const yearly = config.from.slice(5) === '01-01' && config.to.slice(5) === '12-31' && config.from.slice(0, 4) === config.to.slice(0, 4);
  return yearly ? `Tax Year ${config.from.slice(0, 4)}` : `${formatDate(config.from)} - ${formatDate(config.to)}`;
};
const nameOf = (entities, code) => {
  const e = (entities || []).find((x) => x.code === code);
  return e?.name ? `${code} ${e.name}` : code;
};
const saved = (api, form, entity) => api.getAccountingTaxLines(form, entity).then((d) => d?.lines || []);
const pnl = (api, config, entities, book) => fetchStatement(api, { ...config, report: 'pnl', entities }, { from: config.from, to: config.to }, book);

/** One tax report for one config: { org, generatedAt, mode, pickable, mapEntity, ...layout }. */
export async function runTaxReport(api, config, book, entities = []) {
  const { form, report } = TAX_REPORTS[config.report];
  const entity = mapEntityOf(config);
  let range = { from: config.from, to: config.to, book };
  const head = (statement) => ({ org: statement?.org || '', generatedAt: statement?.generated_at || '', mode: 'single', pickable: [], mapEntity: entity });

  if (report.basis === 'returns') return tax1040(api, config, book, entities, form, report);

  if (report.basis === 'bs') {
    // Schedule L: the balance sheet the day before the period, and on its last day.
    const begin = dayBefore(config.from);
    const read = (asof) => fetchStatement(api, { ...config, report: 'balance-sheet' }, { asof }, book);
    const [open, close, lines] = await Promise.all([read(begin), read(config.to), saved(api, form.form, entity)]);
    const maps = mapsOf(lines, entity);
    const out = layoutForm(form, report, [
      { key: 'begin', label: `Beginning of Year (${formatDate(begin)})`, drill: { from: '', to: begin, book }, sections: open?.sections || [], maps },
      { key: 'end', label: `End of Year (${formatDate(config.to)})`, drill: { from: '', to: config.to, book }, sections: close?.sections || [], maps },
    ]);
    return { ...head(close), ...out };
  }

  // Schedule C and Schedule E each read only the entities that FILE on them
  // (Charmi, 11/24/2026: "All the line items is taking into account items for
  // both SCH C and SCH E. We will have to separate them out"). Which one an
  // entity files on is filesOn - the same rule as the 1040.
  let split = null;
  if (SPLIT[form.form]) split = await splitEntities(api, config, book, entities, form.form);
  if (split) {
    config = { ...config, entities: split.keep };
    range = { ...range, entities: split.keep };   // a drill opens only the entities on this form
    if (!split.keep.length) {
      const out = layoutForm(form, report, [{ key: 'amount', label: labelOf(config), drill: range, sections: [], maps: {} }]);
      return { org: split.org, generatedAt: split.generatedAt, mode: 'single', pickable: [], mapEntity: '', ...out, notes: [...out.notes, ...split.notes] };
    }
  }
  const withSplit = (out) => (split ? { ...out, notes: [...out.notes, ...split.notes] } : out);

  if (report.columns === 'entities' && config.entities.length && !(split && !split.picked && config.entities.length > MAX_PROPERTIES)) {
    // Schedule E: one column per property (entity), and a Total.
    const picks = config.entities;
    if (picks.length > MAX_PROPERTIES) throw new Error(`${form.title} reads at most ${MAX_PROPERTIES} properties at a time - pick fewer entities.`);
    const reads = await Promise.all(picks.map((code) => Promise.all([pnl(api, config, [code], book), saved(api, form.form, code)])));
    const cols = reads.map(([statement, lines], i) => ({
      key: `e-${picks[i]}`, label: nameOf(entities, picks[i]), drill: { ...range, entity: picks[i] }, sections: statement?.sections || [], maps: mapsOf(lines, picks[i]),
    }));
    const mapMaps = picks.length === 1 ? cols[0].maps : { entity: {}, all: mapsOf(reads[0]?.[1] || [], '').all };
    const out = layoutForm(form, report, cols, { total: true, mapMaps, totalDrill: range });
    return withSplit({ ...head(reads[0]?.[0]), ...out });
  }

  // One column: the income statement of the entity (or entities) picked.
  const [statement, lines] = await Promise.all([pnl(api, config, config.entities, book), saved(api, form.form, entity)]);
  const out = layoutForm(form, report, [{ key: 'amount', label: labelOf(config), drill: range, sections: statement?.sections || [], maps: mapsOf(lines, entity) }]);
  return withSplit({ ...head(statement), ...out });
}

// ── Which schedule an entity files on ────────────────────────────────────────
const SPLIT = { schedule_c: 'schedule_e', schedule_e: 'schedule_c' };

/**
 * The ONE rule for where an entity's business goes on a 1040: its Files On
 * row in Form 1040's Line Mapping (the entity's own, else the one for every
 * entity), else Schedule E when most of its revenue is rent, else Schedule C.
 * Returns { line, source }.
 */
export function filesOn(sections, own) {
  if (own.entity.return) return { line: own.entity.return, source: 'entity' };
  if (own.all.return) return { line: own.all.return, source: 'all' };
  return { line: rentalMode(FORMS.form_1065, sections) ? 'schedule_e' : 'schedule_c', source: 'suggested' };
}

/**
 * The entities a Schedule C or E report reads: of the picked entities (else
 * the top-level ones) those that file on this form. Every entity is read in
 * ONE by-entity call; its Files On rows in one call each.
 * Returns { keep, picked, notes, org, generatedAt }, or null when it cannot tell.
 */
async function splitEntities(api, config, book, entities, formKey) {
  const picked = (config.entities || []).length > 0;
  let read;
  try {
    read = await pnlByEntity(api, config, { from: config.from, to: config.to }, book);
  } catch {
    return null;      // the by-entity read failed: the form reads as before, unsplit
  }
  const codes = picked ? config.entities : [...read.byEntity.keys()].filter(Boolean);
  if (!codes.length) return null;     // no entity had activity: nothing to split
  const mapped = await Promise.all(codes.map((code) => saved(api, FORMS.form_1040.form, code).then((l) => mapsOf(l, code)).catch(() => ({ entity: {}, all: {} }))));
  const keep = [];
  const away = [];
  codes.forEach((code, i) => {
    const { line } = filesOn(read.byEntity.get(code) || [], mapped[i]);
    if (line === formKey) keep.push(code);
    else away.push({ code, line });
  });
  const other = FORMS[SPLIT[formKey]];
  const elsewhere = away.filter((a) => a.line === other.form);
  const off = away.filter((a) => a.line !== other.form);
  const list = (xs) => xs.map((a) => nameOf(entities, a.code)).join(', ');
  const notes = [
    ...(elsewhere.length ? [`Left out - ${elsewhere.length === 1 ? 'files' : `${elsewhere.length} entities file`} on ${other.title}: ${list(elsewhere)}. Where an entity files is Files On in Form 1040's Line Mapping.`] : []),
    ...(off.length ? [`Left out - not on Form 1040: ${list(off)}.`] : []),
    ...(!keep.length ? [`No entity ${picked ? 'picked ' : ''}files on ${FORMS[formKey].title} - change Files On in Form 1040's Line Mapping, or pick other entities.`] : []),
  ];
  return { keep, picked, notes, org: read.org, generatedAt: read.generatedAt };
}

// ── Form 1040 ────────────────────────────────────────────────────────────────
// Each entity picked files on Schedule C or Schedule E (Line Mapping, one row
// per entity, kept as that entity's "return" row of form_1040); its Schedule C
// line 31 or Schedule E line 41 is worked out from that form's own mapping.
const SCHED = {
  schedule_c: { form: () => FORMS.schedule_c, line: '31', word: 'Schedule C line 31' },
  schedule_e: { form: () => FORMS.schedule_e, line: '41', word: 'Schedule E line 41' },
};

export async function tax1040(api, config, book, entities, form, report) {
  const picks = config.entities || [];
  const label = labelOf(config);
  const base = { org: '', generatedAt: '', mode: 'single', pickable: [], mapEntity: '', labelHead: 'Line / Entity', startFolded: false, taxForm: { form: form.form, report: report.key } };
  if (picks.length > MAX_PROPERTIES) throw new Error(`Form 1040 reads at most ${MAX_PROPERTIES} entities at a time - pick fewer entities.`);
  const reads = await Promise.all(picks.map((code) => Promise.all([
    pnl(api, config, [code], book), saved(api, 'schedule_c', code), saved(api, 'schedule_e', code), saved(api, form.form, code),
  ])));
  const placed = reads.map(([statement, sc, se, ret], i) => {
    const code = picks[i];
    const sections = statement?.sections || [];
    const own = mapsOf(ret, code);
    const suggested = filesOn(sections, { entity: {}, all: {} }).line;
    const { line, source } = filesOn(sections, own);
    let amount = 0;
    if (SCHED[line]) {
      const f = SCHED[line].form();
      const r = f.reports[0];
      const lay = layoutForm(f, r, [{ key: 'amount', label, drill: null, sections, maps: mapsOf(line === 'schedule_c' ? sc : se, code) }]);
      amount = lay.lineTotals[SCHED[line].line] || 0;
    }
    const net = Math.round(sections.reduce((s, sec) => s + (sec.accounts || []).reduce((t, a) => t + ((sec.key === 'revenue' || sec.key === 'other_income') ? 1 : -1) * (Number(a.amount) || 0), 0), 0) * 100) / 100;
    return { code, name: nameOf(entities, code), line, source, suggested, amount, net, org: statement?.org, generatedAt: statement?.generated_at };
  });
  const vals = { 3: 0, 5: 0 };
  placed.forEach((p) => { if (p.line === 'schedule_c') vals[3] += p.amount; if (p.line === 'schedule_e') vals[5] += p.amount; });
  vals[3] = Math.round(vals[3] * 100) / 100;
  vals[5] = Math.round(vals[5] * 100) / 100;
  const calc = (def) => Math.round(def.calc.reduce((s, t) => s + (t.startsWith('-') ? -1 : 1) * (vals[t.replace(/^-/, '')] || 0), 0) * 100) / 100;
  const rows = [];
  let prefix = '';
  report.rows.forEach((r) => {
    if (r.heading) { prefix = r.prefix || ''; rows.push({ kind: 'section', section: r.heading, label: r.heading, count: 0, values: [''] }); return; }
    const text = `${prefix}Line ${r.num ?? r.line} - ${r.label}`;
    if (r.manual) { rows.push({ kind: 'account', code: '', title: `${text} - ${r.manual}`, values: [''], noDrill: true, hint: 'Not from the books' }); return; }
    if (r.from) {
      const mine = placed.filter((p) => p.line === r.from);
      const group = `L${r.line}`;
      rows.push({ kind: 'group', group, label: text, count: mine.length, values: [''], totals: [vals[r.line]], noDrill: true });
      mine.forEach((p) => rows.push({ kind: 'account', group, code: '', title: `${p.name}${p.source === 'suggested' ? ' (suggested)' : ''}`, match: text, values: [p.amount], noDrill: true, hint: `${SCHED[r.from].word} for this entity - open ${FORMS[r.from].title} (Draft) for its lines` }));
      return;
    }
    vals[r.line] = calc(r);
    rows.push({ kind: r.grand ? 'grand' : 'subtotal', label: text, values: [vals[r.line]], noDrill: true, ...(r.grand ? { tone: true } : {}) });
  });
  const off = placed.filter((p) => p.line === SKIP);
  if (off.length) {
    rows.push({ kind: 'section', section: 'For Review', label: 'For Review - Not on This Return', count: 0, values: [''] });
    off.forEach((p) => rows.push({ kind: 'account', code: '', title: p.name, values: [''], noDrill: true, hint: 'Set to Not on Form 1040 in Line Mapping' }));
  }
  const mapRows = placed.map((p) => ({ code: 'return', rowKey: p.code, saveEntity: p.code, title: p.name, section: 'entity', amount: p.net, line: p.line, source: p.source, suggested: p.suggested }));
  const notes = [
    `Draft working paper for the preparer, not a filed return. ${form.about}`,
    ...(report.notes || []),
    ...(!picks.length ? ['Pick the entities that file on this return (Entities on the bar) - nothing is read until then.'] : []),
  ];
  return {
    ...base, org: placed[0]?.org || '', generatedAt: placed[0]?.generatedAt || '',
    columns: [{ key: 'amount', label, type: 'amount', drill: null }], rows, notes, mapRows,
    summary: (report.summary || []).map(([l, line, tone]) => ({ label: l, amount: vals[line] || 0, ...(tone ? { tone: (vals[line] || 0) >= 0 ? 'good' : 'bad' } : {}) })),
    lineTotals: vals,
  };
}
