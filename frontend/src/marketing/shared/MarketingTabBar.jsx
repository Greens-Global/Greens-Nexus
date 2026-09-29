import MarketingTabs from './MarketingTabs'
import ManageButton from './ManageButton'
import AlertsBell from './AlertsBell'
import AiAnalystButton from './AiAnalystButton'

export default function MarketingTabBar({ active, onNavigate, alerts, insights, onClearAlert }) {
  return (
    <div className="mktg-tabbar">
      <MarketingTabs active={active} onChange={onNavigate} />
      <div className="mktg-tabbar-actions">
        {active !== 'insights' && <AiAnalystButton insights={insights} onNavigate={onNavigate} />}
        <ManageButton onNavigate={onNavigate} />
        <AlertsBell alerts={alerts} onNavigate={onNavigate} onClearAlert={onClearAlert} />
      </div>
    </div>
  )
}
