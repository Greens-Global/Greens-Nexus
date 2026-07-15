import MarketingTabs from './MarketingTabs'
import ManageButton from './ManageButton'
import AlertsBell from './AlertsBell'
import AiAnalystButton from './AiAnalystButton'

export default function MarketingTabBar({ active, onNavigate, alerts, insights, onClearAlert }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <MarketingTabs active={active} onChange={onNavigate} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <AiAnalystButton insights={insights} onNavigate={onNavigate} />
        <ManageButton onNavigate={onNavigate} />
        <AlertsBell alerts={alerts} onNavigate={onNavigate} onClearAlert={onClearAlert} />
      </div>
    </div>
  )
}
