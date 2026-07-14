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
import { yelpMonthlyBudgetByPropertyDefault } from './googleAds/yelpData';
import { leadGoalByPropertyDefault } from './insights/data';
import { generateInsights } from './insights/insightEngine';
import { buildAccountWideInsightInput } from './insights/buildAccountWideInsightInput';

// Ported 1:1 from the standalone "Marketing Module Nexus" export (src/pages/
// marketing/Marketing.tsx). The export drove tab/date-range/property state
// through the URL (react-router useSearchParams); inside Nexus this module is
// one view among many, so that state lives in React state here instead. Budget
// and goal targets are lifted to this shell (not owned by the pages) so the
// alerts bell — shown on every tab — reflects edits immediately.
export default function Marketing() {
  const [tab, setTab] = useState('google-ads');   // google-ads | reputation | insights | seo | listings | leads
  const [range, setRange] = useState(thisMonth());
  const [property, setProperty] = useState(ALL_PROPERTIES);
  const [action, setAction] = useState(null);
  const [monthlyBudgetByProperty, setMonthlyBudgetByProperty] = useState(monthlyBudgetByPropertyDefault);
  const [yelpMonthlyBudgetByProperty, setYelpMonthlyBudgetByProperty] = useState(yelpMonthlyBudgetByPropertyDefault);
  const [leadGoalByProperty, setLeadGoalByProperty] = useState(leadGoalByPropertyDefault);
  const [dismissedAlertIds, setDismissedAlertIds] = useState(() => new Set());

  const totalMonthlyBudget = useMemo(() => Object.values(monthlyBudgetByProperty).reduce((a, b) => a + b, 0), [monthlyBudgetByProperty]);
  const totalYelpMonthlyBudget = useMemo(() => Object.values(yelpMonthlyBudgetByProperty).reduce((a, b) => a + b, 0), [yelpMonthlyBudgetByProperty]);
  const totalLeadGoal = useMemo(() => Object.values(leadGoalByProperty).reduce((a, b) => a + b, 0), [leadGoalByProperty]);

  const allAlerts = useMemo(
    () => computeAlerts({ monthlyBudget: totalMonthlyBudget, yelpMonthlyBudget: totalYelpMonthlyBudget, leadGoal: totalLeadGoal }),
    [totalMonthlyBudget, totalYelpMonthlyBudget, totalLeadGoal],
  );
  const alerts = useMemo(() => allAlerts.filter(a => !dismissedAlertIds.has(a.id)), [allAlerts, dismissedAlertIds]);
  const insights = useMemo(
    () => generateInsights(buildAccountWideInsightInput({ monthlyBudgetByProperty, yelpMonthlyBudgetByProperty, leadGoalByProperty })),
    [monthlyBudgetByProperty, yelpMonthlyBudgetByProperty, leadGoalByProperty],
  );

  const changeMonthlyBudget = (facility, value) => setMonthlyBudgetByProperty(prev => ({ ...prev, [facility]: value }));
  const changeYelpMonthlyBudget = (facility, value) => setYelpMonthlyBudgetByProperty(prev => ({ ...prev, [facility]: value }));
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

  if (tab === 'reputation') return <ReputationPage {...sharedProps} />;
  if (tab === 'listings') return <BusinessProfilePage {...sharedProps} />;
  if (tab === 'insights') return (
    <InsightsPage
      {...sharedProps}
      leadGoalByProperty={leadGoalByProperty}
      onChangeLeadGoal={changeLeadGoal}
      monthlyBudgetByProperty={monthlyBudgetByProperty}
      yelpMonthlyBudgetByProperty={yelpMonthlyBudgetByProperty}
    />
  );
  if (tab === 'seo') return <SeoPage onNavigate={sharedProps.onNavigate} alerts={alerts} insights={insights} onClearAlert={clearAlert} />;
  if (tab === 'leads') return <LeadsPage onNavigate={sharedProps.onNavigate} alerts={alerts} insights={insights} onClearAlert={clearAlert} />;
  return (
    <GoogleAdsPage
      {...sharedProps}
      monthlyBudgetByProperty={monthlyBudgetByProperty}
      onChangeMonthlyBudget={changeMonthlyBudget}
      yelpMonthlyBudgetByProperty={yelpMonthlyBudgetByProperty}
      onChangeYelpMonthlyBudget={changeYelpMonthlyBudget}
    />
  );
}
