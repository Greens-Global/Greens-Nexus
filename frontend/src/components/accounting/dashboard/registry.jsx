import { Component, createContext, useContext } from 'react';
import { EmptyBox, Panel } from './Bits';
import { KpiCashNcWidget, KpiCashWidget, KpiInvestWidget, KpiMarginWidget, KpiNiWidget, KpiReconWidget, KpiRunwayWidget, KpiYtdWidget } from './Kpis';
import { CashForecastWidget, CashTrendWidget, EntityCashWidget, InvestWidget, UncatWidget } from './CashWidgets';
import { ExpensesWidget, IncomeWidget, NoiPropWidget, RevExpWidget, VarianceWidget, YtdVarianceWidget } from './PerfWidgets';
import { ActivityWidget, CloseWidget, DeadlinesWidget, FluxWidget, IcWidget, ReconWidget } from './CloseWidgets';
import { DebtWidget, MaturityWidget, PartnersWidget, ValuationWidget } from './CapitalWidgets';

// The widget catalog: id, title, category, default size, what it reads, and
// the component that renders its body. The Overview grid, the Add Widget
// library and the other tabs all mount widgets through WidgetPanel, which
// adds the frame, the "Open report" link and an error boundary so a failing
// widget never blanks the screen.

export const WIDGET_CATS = ['Headline Numbers', 'Cash & Banking', 'Performance', 'Debt & Capital', 'Close & Controls'];

/** Where a widget's link goes: another dashboard tab, or the Reports tab. Provided by Accounting.jsx. */
export const DashNav = createContext(() => {});
export const useDashNav = () => useContext(DashNav);

const def = (id, title, cat, size, desc, Component, extra = {}) => ({ id, title, cat, size, desc, Component, ...extra });

export const WIDGET_LIST = [
  def('kpiCash', 'Cash on Hand', 'Headline Numbers', 'xs', 'Cash available for general purposes, with partner-entity cash noted beside it.', KpiCashWidget, { report: 'reports' }),
  def('kpiCashNC', 'Non-Controllable Cash · FYI', 'Headline Numbers', 'xs', 'Cash held in entities with outside investors or partners. Shown for reference only.', KpiCashNcWidget),
  def('kpiNI', 'Net Income · MTD', 'Headline Numbers', 'xs', 'Month-to-date net income with change from last month.', KpiNiWidget, { report: 'reports' }),
  def('kpiMargin', 'Operating Margin', 'Headline Numbers', 'xs', 'Operating income as a share of revenue.', KpiMarginWidget),
  def('kpiInvest', 'Investment Portfolio', 'Headline Numbers', 'xs', 'Market value of brokerage and money market holdings, with month change.', KpiInvestWidget),
  def('kpiRecon', 'Reconciliations', 'Close & Controls', 'xs', 'Accounts reconciled through the selected month end: bank, credit card, mortgage, credit line and investment.', KpiReconWidget, { page: 'close' }),
  def('kpiRunway', 'Liquidity Runway', 'Headline Numbers', 'xs', 'Months of controllable cash plus investments against fixed monthly obligations (debt service, payroll, taxes, insurance).', KpiRunwayWidget, { page: 'cash' }),
  def('kpiYtd', 'Net Income · YTD', 'Headline Numbers', 'xs', 'Year-to-date net income against the year-to-date budget.', KpiYtdWidget, { report: 'reports' }),
  def('invest', 'Investment Portfolio', 'Cash & Banking', 'md', 'Investments split between stocks and bonds, with market value, gain and month change.', InvestWidget),
  def('cashTrend', 'Cash on Hand · 12 months', 'Cash & Banking', 'md', 'Month-end cash balance trend.', CashTrendWidget, { report: 'reports' }),
  def('revExp', 'Revenue vs Expense', 'Performance', 'md', 'Monthly revenue and expense bars.', RevExpWidget, { report: 'reports' }),
  def('noiProp', 'NOI by Entity', 'Performance', 'md', 'Net operating income for each operating entity this month.', NoiPropWidget, { page: 'performance' }),
  def('entityCash', 'Cash by Entity', 'Cash & Banking', 'sm', 'Controllable cash by entity, with partner-entity cash listed separately.', EntityCashWidget, { page: 'cash' }),
  def('close', 'Month-End Close', 'Close & Controls', 'sm', 'Shared close checklist: progress by phase and the next open tasks. The Close tab has the full plan.', CloseWidget, { page: 'close' }),
  def('uncat', 'Bank and Card Transactions to Code', 'Cash & Banking', 'md', 'Imported bank and credit card lines without a GL account, with the matcher\'s suggestions.', UncatWidget, { page: 'close' }),
  def('variance', 'Budget vs Actual', 'Performance', 'md', 'Largest variances to budget this month.', VarianceWidget, { page: 'performance' }),
  def('recon', 'Account Reconciliations', 'Close & Controls', 'lg', 'Every bank, credit card, mortgage, credit line and brokerage account with its reconciliation status.', ReconWidget, { page: 'close' }),
  def('activity', 'Recent Activity', 'Close & Controls', 'sm', 'Who reconciled an account or completed a close step, and when.', ActivityWidget, { page: 'close' }),
  def('ic', 'Intercompany Balances', 'Close & Controls', 'sm', 'Due-to and due-from balances between entities, with any differences to clear before consolidation.', IcWidget, { page: 'close' }),
  def('flux', 'Balance Sheet Changes to Explain', 'Close & Controls', 'md', 'Month-over-month balance changes over $25,000 or 10%, for flux review.', FluxWidget, { page: 'close' }),
  def('debt', 'Debt and Covenants', 'Close & Controls', 'md', 'Loan balances, rates, maturities and debt service coverage against each covenant.', DebtWidget, { page: 'cash' }),
  def('deadlines', 'Filing and Payment Calendar', 'Close & Controls', 'sm', 'Upcoming tax filings, loan payments and covenant deadlines.', DeadlinesWidget),
  def('income', 'Income This Month', 'Performance', 'lg', 'Every income source for the selected month, by account and by entity, with a chart, a six-month trend and the change from last month.', IncomeWidget, { report: 'reports' }),
  def('expenses', 'Expenses This Month', 'Performance', 'lg', 'Every expense for the selected month by account, with a chart and the change from last month.', ExpensesWidget, { report: 'reports' }),
  def('cashForecast', 'Monthly Cash Forecast', 'Cash & Banking', 'lg', 'Receipts, disbursements and ending controllable cash for the next six months from the posted budget, with the minimum cash line.', CashForecastWidget, { page: 'cash' }),
  def('ytdVariance', 'Budget vs Actual · Year to Date', 'Performance', 'md', 'Revenue, expense and net income against budget for the year so far, with the largest variances.', YtdVarianceWidget, { page: 'performance' }),
  def('partners', 'Partner Capital & Distributions', 'Debt & Capital', 'md', 'Capital by investor class, distributions paid year to date, and what is scheduled next.', PartnersWidget),
  def('valuation', 'Portfolio Value & Leverage', 'Debt & Capital', 'md', 'Implied value from trailing NOI at market cap rates, against debt, for loan-to-value and equity.', ValuationWidget),
  def('maturity', 'Debt Maturities & Rate Exposure', 'Debt & Capital', 'md', 'Balances maturing by year, weighted rate, and what is coming due within 18 months.', MaturityWidget, { page: 'cash' }),
];

export const WIDGETS = Object.fromEntries(WIDGET_LIST.map((w) => [w.id, w]));
export const SIZES = ['xs', 'sm', 'md', 'lg'];
export const SIZE_LABEL = { xs: '¼ width', sm: '⅓ width', md: '½ width', lg: 'Full width' };

class WidgetBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[accounting-dashboard] widget failed', error, info?.componentStack); }
  render() {
    if (this.state.error) return <EmptyBox title="Couldn't load this widget" body={`${this.state.error.message}. Refresh the figures to try again.`} />;
    return this.props.children;
  }
}

/** Frame + body for one widget. `right` adds controls to the header (the Overview's menu). */
export function WidgetPanel({ id, right, flash, style, sub, compact }) {
  const nav = useDashNav();
  const w = WIDGETS[id];
  if (!w) return <Panel title={id} style={style}><EmptyBox title="Unknown widget" body={`"${id}" is not in the library any more. Remove it from this view.`} /></Panel>;
  const Body = w.Component;
  const link = w.report ? { label: 'Open report', to: w.report } : w.page ? { label: `Open ${w.page[0].toUpperCase()}${w.page.slice(1)}`, to: w.page } : null;
  return (
    <Panel title={w.title} sub={sub} right={right} flash={flash} style={style} onOpenReport={link && !compact ? () => nav(link.to) : undefined} reportLabel={link?.label}>
      <WidgetBoundary><Body onOpenClose={() => nav('close')} onOpenBanks={() => nav('reports')} compact={compact} /></WidgetBoundary>
    </Panel>
  );
}
