import { useMemo, useState } from 'react';
import GoogleAdsPage from './googleAds/GoogleAdsPage';
import ReputationPage from './reputation/ReputationPage';
import BusinessProfilePage from './reputation/BusinessProfilePage';
import InsightsPage from './insights/InsightsPage';
import SeoPage from './seo/SeoPage';
import LeadsPage from './leads/LeadsPage';
import { ALL_PROPERTIES } from './shared/facilities';
import { thisMonth } from './shared/utils';
import { computeAlerts } from './shared/alerts';
import { monthlyBudgetByPropertyDefault } from './googleAds/data';
import { leadGoalByPropertyDefault } from './insights/data';
import { generateInsights } from './insights/insightEngine';
import { buildAccountWideInsightInput } from './insights/buildAccountWideInsightInput';

// Ported 1:1 from the standalone "Marketing Module Nexus" export (src/pages/
// marketing/Marketing.tsx). The export drove tab/date-range/property state
// through the URL (react-router useSearchParams); inside Nexus this module is
// one view among many, so that state lives in React state here instead. Budget
// and goal targets are lifted to this shell (not owned by the pages) so the
// alerts bell - shown on every tab - reflects edits immediately.
export default function Marketing() {
  const [tab, setTab] = useState('google-ads');   // google-ads | reputation | insights | seo | listings | leads
  const [range, setRange] = useState(thisMonth());
  const [property, setProperty] = useState(ALL_PROPERTIES);
  const [action, setAction] = useState(null);
  const [monthlyBudgetByProperty, setMonthlyBudgetByProperty] = useState(monthlyBudgetByPropertyDefault);
  const [leadGoalByProperty, setLeadGoalByProperty] = useState(leadGoalByPropertyDefault);
  const [dismissedAlertIds, setDismissedAlertIds] = useState(() => new Set());

  const totalMonthlyBudget = useMemo(() => Object.values(monthlyBudgetByProperty).reduce((a, b) => a + b, 0), [monthlyBudgetByProperty]);
  const totalLeadGoal = useMemo(() => Object.values(leadGoalByProperty).reduce((a, b) => a + b, 0), [leadGoalByProperty]);

  const allAlerts = useMemo(
    () => computeAlerts({ monthlyBudget: totalMonthlyBudget, leadGoal: totalLeadGoal }),
    [totalMonthlyBudget, totalLeadGoal],
  );
  const alerts = useMemo(() => allAlerts.filter(a => !dismissedAlertIds.has(a.id)), [allAlerts, dismissedAlertIds]);
  const insights = useMemo(
    () => generateInsights(buildAccountWideInsightInput({ monthlyBudgetByProperty, leadGoalByProperty })),
    [monthlyBudgetByProperty, leadGoalByProperty],
  );

  const changeMonthlyBudget = (facility, value) => setMonthlyBudgetByProperty(prev => ({ ...prev, [facility]: value }));
  const changeLeadGoal = (facility, value) => setLeadGoalByProperty(prev => ({ ...prev, [facility]: value }));
  const clearAlert = (id) => setDismissedAlertIds(prev => new Set(prev).add(id));

  const sharedProps = {
    range,
    onRangeChange: (r) => setRange(r),
    property,
    onPropertyChange: (p) => setProperty(p),
    onNavigate: (t, a) => { setTab(t || 'google-ads'); setAction(a ?? null); },
    alerts,
    insights,
    onClearAlert: clearAlert,
    action,
    onClearAction: () => setAction(null),
  };

  let page;
  if (tab === 'reputation') page = <ReputationPage {...sharedProps} />;
  else if (tab === 'listings') page = <BusinessProfilePage {...sharedProps} />;
  else if (tab === 'insights') page = (
    <InsightsPage
      {...sharedProps}
      leadGoalByProperty={leadGoalByProperty}
      onChangeLeadGoal={changeLeadGoal}
      monthlyBudgetByProperty={monthlyBudgetByProperty}
    />
  );
  else if (tab === 'seo') page = <SeoPage onNavigate={sharedProps.onNavigate} alerts={alerts} insights={insights} onClearAlert={clearAlert} />;
  else if (tab === 'leads') page = <LeadsPage onNavigate={sharedProps.onNavigate} alerts={alerts} insights={insights} onClearAlert={clearAlert} />;
  else page = (
    <GoogleAdsPage
      {...sharedProps}
      monthlyBudgetByProperty={monthlyBudgetByProperty}
      onChangeMonthlyBudget={changeMonthlyBudget}
    />
  );

  // The standalone app leaned on Tailwind's global reset (Preflight) to strip
  // native <button> chrome; Nexus has no such reset, so every unstyled sort /
  // "view all" button was rendering as a grey UA pill. This scoped stylesheet
  // restores that reset for the module AND layers in the motion the design was
  // always meant to have: pressable buttons, card hover-lift, a soft focus ring
  // and a per-tab fade-in. Non-!important so components that set their own inline
  // background/border (styled buttons, status pills) still win.
  return (
    <>
      <style>{MKTG_STYLES}</style>
      <div className="mktg-root" key={tab}>
        {page}
      </div>
    </>
  );
}

const MKTG_STYLES = `
.mktg-root { animation: mktgFadeIn .28s ease both; }
@keyframes mktgFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.mktg-root button {
  background: transparent;
  border: 0;
  margin: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color .15s ease, color .15s ease, opacity .15s ease, box-shadow .15s ease, border-color .15s ease, transform .08s ease;
}
.mktg-root button:disabled { cursor: default; }
.mktg-root button:active:not(:disabled) { transform: translateY(1px) scale(0.985); }

.mktg-root input, .mktg-root select, .mktg-root textarea {
  transition: border-color .15s ease, box-shadow .15s ease;
}
.mktg-root input:focus, .mktg-root select:focus, .mktg-root textarea:focus {
  border-color: #10b981 !important;
  box-shadow: 0 0 0 3px rgba(16,185,129,0.14);
  outline: none;
}

.mktg-root .mktg-card { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; will-change: transform; }
.mktg-root .mktg-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 20px -8px rgba(0,0,0,0.16), 0 4px 8px -4px rgba(0,0,0,0.08) !important;
  border-color: #d1d5db !important;
}

/* Responsive layout (QA, Sep 23). The export's desktop Tailwind spans were
   fixed inline grids with no breakpoints, so phones got seven 40px KPI cards
   and three skinny chart columns. Spans live here so they can collapse. */
.mktg-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.mktg-grid12 { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
.mktg-grid12 > * { min-width: 0; }
.mktg-span-3 { grid-column: span 3; }
.mktg-span-4 { grid-column: span 4; }
.mktg-span-5 { grid-column: span 5; }
.mktg-span-6 { grid-column: span 6; }
@media (max-width: 1100px) {
  .mktg-grid12 > * { grid-column: 1 / -1; }
}

/* Tab bar: the tabs swipe (.scroll-tabs) instead of pushing AI Analyst /
   Manage / Alerts off-screen; on phones the actions take their own row. */
.mktg-tabbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.mktg-tabbar-tabs { flex: 1 1 0; min-width: 0; }
.mktg-tabbar-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
@media (max-width: 640px) {
  .mktg-tabbar-tabs { flex-basis: 100%; }
}

.mktg-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }

@media (prefers-reduced-motion: reduce) {
  .mktg-root, .mktg-root *, .mktg-root .mktg-card { animation: none !important; transition: none !important; }
}
`;
