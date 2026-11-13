import { useState } from 'react';
import { useIsMobile as useMedia } from '../../../lib/useIsMobile';
import { monthLabel, monthLong, whenTxt } from '../../../accounting/dashboard/model/months';
import { pct, pctTxt } from '../../../accounting/dashboard/model/money';
import { Chip, Dot, EmptyBox, Footnote, GroupRow, LoadingBox, Panel, RTh, SERIES_2, SectionTabs, Tile, WARN, mono, num, toneColor, useDashCols } from './Bits';
import { Lines } from './Charts';
import { useDash } from './DashContext';
import { Toolbar } from './Filters';
import { useNotes, usePerf, usePeriodDraft, useTrend } from './hooks';
import { DrillFigure, useLineDrill, useStatementOpen, useWindow } from './LineDrill';
import { WidgetPanel } from './registry';
import { WarnMark } from '../warnMark';
import { dialog } from '../../../ui/dialog';

// Performance tab: actuals against budget and prior year, ranked by what
// matters, with the month's commentary shared with everyone. One section at
// a time; the tiles stay on top.

const SECTIONS = [
  { id: 'summary', label: 'Summary' },
  { id: 'bva', label: 'Budget vs Actual' },
  { id: 'ytd', label: 'Year to Date' },
  { id: 'commentary', label: 'Commentary' },
];

export default function PerformanceTab({ canEdit }) {
  const { m, period, periodLabel, loading, act } = useDash();
  const openStatement = useStatementOpen();
  const win = useWindow();
  const perf = usePerf();
  const trend = useTrend();
  const { commentary } = useNotes();
  // What is typed is kept per month until saved or discarded (11/12/2026): a month
  // change or a newer save by someone else no longer overwrites it.
  const draft = usePeriodDraft(period, commentary?.body, commentary?.written_at);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState('summary');

  const save = async () => {
    setSaving(true);
    try { await act('note', { period, kind: 'commentary', key: '', body: draft.value.trim(), detail: monthLong(period) }); draft.discard(); }
    catch (e) { await dialog.alert(e?.message || 'The commentary could not be saved. Your draft is kept.', { title: 'Month Commentary' }); }
    finally { setSaving(false); }
  };
  const discard = async () => {
    if (await dialog.confirm('Discard your draft and show the saved commentary?', { title: 'Discard Draft', confirmText: 'Discard', danger: true })) draft.discard();
  };
  const last12 = trend.slice(-12).map((t) => ({ label: monthLabel(t.month), revenue: Math.round(t.revenue), revenueBudget: t.budgetRevenue ? Math.round(t.budgetRevenue) : null, net: Math.round(t.net), netBudget: t.budgetRevenue || t.budgetExpense ? Math.round(t.budgetRevenue - t.budgetExpense) : null }));
  const material = perf?.variances.filter((v) => v.material && v.budget).slice(0, 6) ?? [];
  const hasBudget = !!perf?.variances.some((v) => v.budget);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 14 };
  const wide = useMedia('(min-width: 1000px)');   // follows the viewport, so a phone turned sideways re-lays out
  const halfWide = wide ? { gridColumn: 'span 6' } : { gridColumn: 'span 12' };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Toolbar right={<button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => openStatement(win())}>Open Income Statement</button>} />
      {loading || !perf ? <LoadingBox height={84} /> : (
        <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          {perf.tiles.map((t) => (
            <Tile key={t.name} label={t.name} value={m(t.actual, { compact: true })}
              sub={<span><span style={{ color: t.vsBudget != null ? toneColor(t.goodBudget) : undefined }}>{t.vsBudget != null ? pct(t.vsBudget) : '-'} vs budget</span> · <span style={{ color: t.vsPrior != null ? toneColor(t.goodPrior) : undefined }}>{t.vsPrior != null ? pct(t.vsPrior) : '-'} vs last year</span></span>} />
          ))}
        </div>
      )}
      <SectionTabs tabs={SECTIONS.map((s) => (s.id === 'commentary' && commentary ? { ...s, badge: 'written' } : s))} value={section} onChange={setSection} />

      {section === 'summary' ? (
        <div style={grid}>
          <Panel title="Revenue and Net Income · 12 Months" style={halfWide}>
            {loading ? <LoadingBox /> : last12.length < 2 ? <EmptyBox title="Not enough history" /> : (
              <>
                <Lines data={last12} height={200} zero={false} series={[
                  { key: 'revenueBudget', label: 'Revenue Budget', color: '#0998c3', dashed: true },
                  { key: 'revenue', label: 'Revenue', color: 'var(--wk-brand, #2b45e1)' },
                  { key: 'netBudget', label: 'Net Income Budget', color: SERIES_2, dashed: true },
                  { key: 'net', label: 'Net Income', color: SERIES_2 },
                ]} />
                <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--wk-brand, #2b45e1)" />Revenue</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color={SERIES_2} />Net Income</span><span>Dashed = budget</span></div>
              </>
            )}
          </Panel>
          <Panel title="What Moved - Material Variances" sub="≥ $5K or ≥ 5% of budget" style={halfWide}>
            {loading || !perf ? <LoadingBox /> : !hasBudget ? <EmptyBox title="No budget for this month" body="Post a budget journal in Nexus Accounting covering this month to rank variances." /> : !material.length ? <EmptyBox title="Nothing material" body="Every line is within threshold this month." /> : (
              <div>
                {material.map((v, i) => (
                  <div key={v.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', fontSize: 13, borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
                    <span style={{ marginTop: 6, width: 8, height: 8, flexShrink: 0, borderRadius: 99, background: v.good ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)' }} />
                    <span style={{ minWidth: 0, flex: 1 }}><b>{v.name}</b> {v.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {section === 'bva' ? (
        <Panel title={`Budget vs Actual vs Prior Year · ${periodLabel}`} bodyStyle={{ padding: 0 }} onOpenReport={() => openStatement(win())}>
          {loading || !perf ? <LoadingBox /> : <BvaTable rows={perf.variances} />}
        </Panel>
      ) : null}

      {section === 'ytd' ? (
        <div style={grid}>
          <div style={halfWide}><WidgetPanel id="ytdVariance" style={{ height: '100%' }} /></div>
          <div style={halfWide}><WidgetPanel id="noiProp" style={{ height: '100%' }} /></div>
        </div>
      ) : null}

      {section === 'commentary' ? (
        <Panel title="Month Commentary" sub={commentary ? `Shared with everyone · ${commentary.written_by} · ${whenTxt(commentary.written_at)}` : 'Shared with everyone · nothing written yet'}>
          <textarea className="form-input" value={draft.value} onChange={(e) => draft.set(e.target.value)} rows={5} disabled={!canEdit} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14 }} placeholder="Explain the month for the Principals: what drove the variances, what is timing, what needs a decision." />
          {draft.stale ? (
            <div role="status" style={{ marginTop: 8, fontSize: 13, color: WARN }}>
              <WarnMark />{commentary ? `${commentary.written_by} saved a newer commentary ${whenTxt(commentary.written_at)}.` : 'The saved commentary changed.'} <span style={{ color: 'var(--text-secondary)' }}>Your draft is kept until you save or discard it.</span>
            </div>
          ) : null}
          {canEdit ? (
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {draft.dirty ? <button type="button" className="secondary-btn" style={{ fontSize: 13 }} onClick={discard} disabled={saving}>Discard Draft</button> : null}
              <button type="button" className="primary-btn" style={{ fontSize: 13 }} onClick={save} disabled={saving || !draft.dirty || !draft.value.trim()}>Save Commentary</button>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

function BvaTable({ rows }) {
  const { m } = useDash();
  const [drill, lines] = useLineDrill();
  const openStatement = useStatementOpen();
  const win = useWindow();
  const cols = useDashCols('bva');
  if (!rows.length) return <EmptyBox title="No activity this month" style={{ margin: 16 }} />;
  const sections = [['Revenue', 'Revenue'], ['Cost of Revenue', 'Cost of Revenue'], ['Operating Expenses', 'Operating Expenses'], ['Other', 'Interest and Depreciation']];
  const sum = (ls, k) => ls.reduce((t, l) => t + l[k], 0);
  const py = (ls) => ls.reduce((t, l) => t + (l.py ?? 0), 0);
  const hasPy = rows.some((r) => r.py != null);
  // `open`: the figure is posted, so it opens its lines (11/11/2026); budget and variance are worked out.
  const cell = (v, color, open) => <td style={{ ...num, color }}>{v == null ? '-' : open ? <DrillFigure onOpen={open}>{m(v, { report: true })}</DrillFigure> : m(v, { report: true })}</td>;
  const totals = (label, ls, strong) => {
    const a = sum(ls, 'actual'), b = sum(ls, 'budget'), p = py(ls), v = a - b;
    return (
      <tr style={{ fontWeight: 700, borderTop: strong ? '2px solid var(--border-color)' : '1px solid var(--border-color)' }}>
        {/* A total is many accounts: it opens the Income Statement for the same months (and last year's). */}
        <td>{label}</td>{cell(a, strong ? toneColor(a >= 0) : undefined, () => openStatement(win()))}{cell(b || null)}{cell(b ? v : null, b ? toneColor(v >= 0) : undefined)}
        <td style={{ ...num, fontSize: 12, color: b ? toneColor(v >= 0) : undefined }}>{b ? pctTxt(v / Math.abs(b)) : '-'}</td>
        {cell(hasPy ? p : null, undefined, () => openStatement(win(12)))}<td style={{ ...num, fontSize: 12, color: hasPy && p ? toneColor(a - p >= 0) : undefined }}>{hasPy && p ? pct((a - p) / Math.abs(p)) : '-'}</td>
      </tr>
    );
  };
  return (
    <div className="req-table-wrapper">{lines}<table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
      <thead><tr>{[['line', 'Line'], ['actual', 'Actual'], ['budget', 'Budget'], ['var', 'Var $'], ['varPct', 'Var %'], ['py', 'Last Year'], ['yoy', 'YoY']].map(([id, label], i) => <RTh key={id} cols={cols} id={id} label={label} style={i ? num : undefined} />)}</tr></thead>
      <tbody>
        {sections.map(([g, label]) => {
          const ls = rows.filter((r) => r.group === g).sort((a, b) => a.gl.localeCompare(b.gl, 'en-US', { numeric: true }));
          if (!ls.length) return null;
          return (
            <GroupBlock key={g} title={label}>
              {ls.map((r) => (
                <tr key={r.id} style={!r.material ? { color: 'var(--text-muted)' } : undefined}>
                  <td><span style={mono}>{r.gl}</span>{r.name}{r.material && r.budget ? <Chip tone={r.good ? 'ok' : 'bad'} style={{ marginLeft: 8 }}>Material</Chip> : null}</td>
                  {cell(r.actual, undefined, () => drill(r))}{cell(r.budget || null)}{cell(r.budget ? r.v : null, r.budget ? toneColor(r.good) : undefined)}
                  <td style={{ ...num, fontSize: 12, color: r.budget ? toneColor(r.good) : undefined }}>{r.budget ? pctTxt(r.p) : '-'}</td>
                  {cell(hasPy ? r.py : null, undefined, r.py ? () => drill(r, { yearsAgo: 1 }) : undefined)}<td style={{ ...num, fontSize: 12, color: r.py != null ? toneColor(r.actual - r.py >= 0) : undefined }}>{r.py ? pct((r.actual - r.py) / Math.abs(r.py)) : '-'}</td>
                </tr>
              ))}
              {totals(`Total ${label}`, ls, false)}
            </GroupBlock>
          );
        })}
        {totals('Net Income', rows, true)}
      </tbody>
      <tfoot><tr><td colSpan={7}><Footnote style={{ padding: '0 10px 10px' }}>Rows in gray are within threshold. Groups follow the chart of accounts sections.</Footnote></td></tr></tfoot>
    </table></div>
  );
}

function GroupBlock({ title, children }) {
  return (<><GroupRow title={title} cols={7} />{children}</>);
}
