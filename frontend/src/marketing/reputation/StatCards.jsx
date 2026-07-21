import { Star, MessageSquare, Inbox, ArrowUp, ArrowDown } from 'lucide-react'
import { pctChange } from '../shared/utils'
import StarRating from '../shared/StarRating'
import { C } from '../theme'

function StatCard({ def, onClick }) {
  const Icon = def.icon
  const isRating = def.stars !== undefined
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        borderRadius: 12,
        border: '1px solid ' + C.gray200,
        background: C.white,
        padding: 16,
        boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
        minWidth: 0,
        transition: 'all .15s',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = C.gray300
        e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = C.gray200
        e.currentTarget.style.boxShadow = '0 1px 2px 0 rgba(0,0,0,0.05)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
        {isRating ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.value}</span>
            <StarRating value={def.stars} size={13} />
          </div>
        ) : (
          <div style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: def.color.color, background: def.color.background }}>
            <Icon size={14} />
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, fontWeight: 600, color: def.isGood ? C.emerald600 : C.red500 }}>
            {def.deltaLabel.startsWith('-') ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
            {def.deltaLabel.replace('-', '')}
          </span>
          <span style={{ fontSize: 10, color: C.gray400, whiteSpace: 'nowrap' }}>vs {def.deltaSubtitle}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>{def.label}</div>
      {!isRating && (
        <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.value}</div>
      )}
    </button>
  )
}

export default function StatCards(props) {
  const {
    overallRating, prevOverallRating,
    totalReviews, prevTotalReviews,
    newReviews, prevNewReviews,
    pending, prevPending,
    previousMonthLabel, onSelectStat,
  } = props

  const ratingDelta = overallRating - prevOverallRating
  const totalDelta = pctChange(totalReviews, prevTotalReviews)
  const newDelta = pctChange(newReviews, prevNewReviews)
  const pendingDelta = pctChange(pending, prevPending)

  const cards = [
    {
      key: 'rating', label: 'Overall Rating', icon: Star, color: { color: C.amber500, background: C.amber50 },
      value: overallRating.toFixed(1),
      deltaLabel: `${ratingDelta >= 0 ? '+' : ''}${ratingDelta.toFixed(1)}`,
      isGood: ratingDelta >= 0,
      deltaSubtitle: previousMonthLabel,
      stars: overallRating,
    },
    {
      key: 'total', label: 'Total Reviews', icon: MessageSquare, color: { color: C.blue500, background: C.blue50 },
      value: totalReviews.toLocaleString(),
      deltaLabel: `${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(1)}%`,
      isGood: totalDelta >= 0,
      deltaSubtitle: previousMonthLabel,
    },
    {
      key: 'new', label: 'New Reviews', icon: Inbox, color: { color: C.purple500, background: C.purple50 },
      value: newReviews.toLocaleString(),
      deltaLabel: `${newDelta >= 0 ? '+' : ''}${newDelta.toFixed(1)}%`,
      isGood: newDelta >= 0,
      deltaSubtitle: previousMonthLabel,
    },
    {
      key: 'pending', label: 'Pending Replies', icon: Inbox, color: { color: C.orange500, background: C.orange50 },
      value: pending.toLocaleString(),
      deltaLabel: `${pendingDelta >= 0 ? '+' : ''}${pendingDelta.toFixed(1)}%`,
      isGood: pendingDelta <= 0,
      deltaSubtitle: previousMonthLabel,
    },
  ]

  return (
    <>
      {cards.map((c) => (
        <StatCard key={c.key} def={c} onClick={() => onSelectStat(c.key, c.label)} />
      ))}
    </>
  )
}
