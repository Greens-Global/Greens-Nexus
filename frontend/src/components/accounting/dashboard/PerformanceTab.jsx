import { useEffect, useState } from 'react';
import { monthLabel, monthLong, whenTxt } from '../../../accounting/dashboard/model/months';
import { pct, pctTxt } from '../../../accounting/dashboard/model/money';
import { Chip, Dot, EmptyBox, Footnote, GroupRow, LoadingBox, Panel, SectionTabs, Tile, mono, num, toneColor } from './Bits';
import { Lines } from './Charts';
import { useDash } from './DashContext';
import { Toolbar } from './Filters';
import { useNotes, usePerf, useTrend } from './hooks';
import { WidgetPanel, useDashNav } from './registry';

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
  const nav = useDashNav();
  const perf = usePerf();
  const trend = useTrend();
  const { commentary } = useNotes();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState('summary');
  useEffect(() => setNote(commentary?.body ?? ''), [commentary, period]);

  const save = async () => {
    setSaving(true);
    try { await act('note', { period, kind: 'commentary', key: '', body: note.trim(), detail: monthLong(period) }); } finally { setSaving(false); }
  };
  const last12 = trend.slice(-12).map((t) => ({ label: monthLabel(t.month), revenue: Math.round(t.revenue), revenueBudget: t.budgetRevenue ? Math.round(t.budgetRevenue) : null, net: Math.round(t.net), netBudget: t.budgetRevenue || t.budgetExpense ? Math.round(t.budgetRevenue - t.budgetExpense) : null }));
  const material = perf?.variances.filter((v) => v.material && v.budget).slice(0, 6) ?? [];
  const hasBudget = !!perf?.variances.some((v) => v.budget);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 14 };
  const halfWide = typeof window !== 'undefined' && window.innerWidth >= 1000 ? { gridColumn: 'span 6' } : { gridColumn: 'span 12' };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Toolbar right={<button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '4px 10px' }} onClick={() => nav('reports')}>Open Income Statement</button>} />
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
          <Panel title="Revenue and net income · 12 months" style={halfWide}>
            {loading ? <LoadingBox /> : last12.length < 2 ? <EmptyBox title="Not enough history" /> : (
              <>
                <Lines data={last12} height={200} zero={false} series={[
                  { key: 'revenueBudget', label: 'Revenue budget', color: '#0998c3', dashed: true },
                  { key: 'revenue', label: 'Revenue', color: 'var(--wk-brand, #2b45e1)' },
                  { key: 'netBudget', label: 'Net income budget', color: '#d97706', dashed: true },
                  { key: 'net', label: 'Net income', color: '#d97706' },
                ]} />
                <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: '0.7rem', color: 'var(--text-muted)' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--wk-brand, #2b45e1)" />Revenue</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#d97706" />Net income</span><span>Dashed = budget</span></div>
              </>
            )}
          </Panel>
          <Panel title="What moved - material variances" sub="≥ $5K or ≥ 5% of budget" style={halfWide}>
            {loading || !perf ? <LoadingBox /> : !hasBudget ? <EmptyBox title="No budget for this month" body="Post a budget journal in Nexus Accounting covering this month to rank variances." /> : !material.length ? <EmptyBox title="Nothing material" body="Every line is within threshold this month." /> : (
              <div>
                {material.map((v, i) => (
                  <div key={v.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', fontSize: '0.84rem', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
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
        <Panel title={`Budget vs actual vs prior year · ${periodLabel}`} bodyStyle={{ padding: 0 }} onOpenReport={() => nav('reports')}>
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
        <Panel title="Month commentary" sub={commentary ? `Shared with everyone · ${commentary.written_by} · ${whenTxt(commentary.written_at)}` : 'Shared with everyone · nothing written yet'}>
          <textarea className="form-input" value={note} onChange={(e) => setNote(e.target.value)} rows={5} disabled={!canEdit} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: '0.86rem' }} placeholder="Explain the month for the Principals: what drove the variances, what is timing, what needs a decision." />
          {canEdit ? <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}><button type="button" className="primary-btn" style={{ fontSize: '0.78rem' }} onClick={save} disabled={saving || !note.trim()}>Save commentary</button></div> : null}
        </Panel>
      ) : null}
    </div>
  );
}

function BvaTable({ rows }) {
  const { m } = useDash();
  if (!rows.length) return <EmptyBox title="No activity this month" style={{ margin: 16 }} />;
  const sections = [['Revenue', 'Revenue'], ['Cost of Revenue', 'Cost of revenue'], ['Operating Expenses', 'Operating expenses'], ['Other', 'Interest and depreciation']];
  const sum = (ls, k) => ls.reduce((t, l) => t + l[k], 0);
  const py = (ls) => ls.reduce((t, l) => t + (l.py ?? 0), 0);
  const hasPy = rows.some((r) => r.py != null);
  const cell = (v, color) => <td style={{ ...num, color }}>{v == null ? '-' : m(v, { paren: true })}</td>;
  const totals = (label, ls, strong) => {
    const a = sum(ls, 'actual'), b = sum(ls, 'budget'), p = py(ls), v = a - b;
    return (
      <tr style={{ fontWeight: 700, borderTop: strong ? '2px solid var(--border-color)' : '1px solid var(--border-color)' }}>
        <td>{label}</td>{cell(a, strong ? toneColor(a >= 0) : undefined)}{cell(b || null)}{cell(b ? v : null, b ? toneColor(v >= 0) : undefined)}
        <td style={{ ...num, fontSize: '0.76rem', color: b ? toneColor(v >= 0) : undefined }}>{b ? pctTxt(v / Math.abs(b)) : '-'}</td>
        {cell(hasPy ? p : null)}<td style={{ ...num, fontSize: '0.76rem', color: hasPy && p ? toneColor(a - p >= 0) : undefined }}>{hasPy && p ? pct((a - p) / Math.abs(p)) : '-'}</td>
      </tr>
    );
  };
  return (
    <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
      <thead><tr><th>Line</th><th style={num}>Actual</th><th style={num}>Budget</th><th style={num}>Var $</th><th style={num}>Var %</th><th style={num}>Last year</th><th style={num}>YoY</th></tr></thead>
      <tbody>
        {sections.map(([g, label]) => {
          const ls = rows.filter((r) => r.group === g).sort((a, b) => a.gl.localeCompare(b.gl, 'en-US', { numeric: true }));
          if (!ls.length) return null;
          return (
            <GroupBlock key={g} title={label}>
              {ls.map((r) => (
                <tr key={r.id} style={!r.material ? { color: 'var(--text-muted)' } : undefined}>
                  <td><span style={mono}>{r.gl}</span>{r.name}{r.material && r.budget ? <Chip tone={r.good ? 'ok' : 'bad'} style={{ marginLeft: 8 }}>material</Chip> : null}</td>
                  {cell(r.actual)}{cell(r.budget || null)}{cell(r.budget ? r.v : null, r.budget ? toneColor(r.good) : undefined)}
                  <td style={{ ...num, fontSize: '0.76rem', color: r.budget ? toneColor(r.good) : undefined }}>{r.budget ? pctTxt(r.p) : '-'}</td>
                  {cell(hasPy ? r.py : null)}<td style={{ ...num, fontSize: '0.76rem', color: r.py != null ? toneColor(r.actual - r.py >= 0) : undefined }}>{r.py ? pct((r.actual - r.py) / Math.abs(r.py)) : '-'}</td>
                </tr>
              ))}
              {totals(`Total ${label.toLowerCase()}`, ls, false)}
            </GroupBlock>
          );
        })}
        {totals('Net income', rows, true)}
      </tbody>
      <tfoot><tr><td colSpan={7}><Footnote style={{ padding: '0 10px 10px' }}>Rows in grey are within threshold. Groups follow the chart of accounts sections.</Footnote></td></tr></tfoot>
    </table>
  );
}

function GroupBlock({ title, children }) {
  return (<><GroupRow title={title} cols={7} />{children}</>);
}
