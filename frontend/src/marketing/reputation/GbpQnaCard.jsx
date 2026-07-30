import { useState } from 'react'
import { formatDateLabel } from '../shared/utils'
import { C } from '../theme'

function AnswerRow({ q, showFacility, onAnswer }) {
  const [draft, setDraft] = useState('')
  const unanswered = !q.answer

  return (
    <div
      style={{
        borderRadius: 8,
        border: '1px solid ' + C.gray200,
        padding: 12,
        borderLeft: '4px solid ' + (unanswered ? '#fbbf24' : 'transparent'),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 500, color: C.gray900 }}>
          {q.askedBy}
          {unanswered && (
            <span style={{ padding: '2px 6px', borderRadius: 9999, fontSize: 9.5, fontWeight: 500, color: C.amber700, background: C.amber50 }}>Needs answer</span>
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {showFacility && <span style={{ fontSize: 11, color: C.gray400 }}>{q.facility}</span>}
          <span style={{ fontSize: 11, color: C.gray400 }}>{formatDateLabel(q.askedDate)}</span>
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: C.gray700, marginBottom: 8 }}>{q.question}</p>
      {q.answer ? (
        <div style={{ borderRadius: 6, background: C.gray50, padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
            <span style={{ fontSize: 11.5, fontWeight: 500, color: C.gray700 }}>Acme Storage</span>
            <span style={{ fontSize: 10.5, color: C.gray400 }}>{q.answeredDate && formatDateLabel(q.answeredDate)}</span>
          </div>
          <p style={{ fontSize: 12, color: C.gray600 }}>{q.answer}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                onAnswer(q.id, draft.trim())
                setDraft('')
              }
            }}
            placeholder="Write a public answer..."
            style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 12.5, outline: 'none' }}
          />
          <button
            onClick={() => {
              if (draft.trim()) {
                onAnswer(q.id, draft.trim())
                setDraft('')
              }
            }}
            style={{ padding: '6px 10px', borderRadius: 6, background: C.emerald600, color: C.white, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
          >
            Answer
          </button>
        </div>
      )}
    </div>
  )
}

export default function GbpQnaCard({ questions, showFacility, onAnswer }) {
  const unanswered = questions.filter((q) => !q.answer)
  const answered = questions.filter((q) => q.answer)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 440, overflowY: 'auto' }}>
      {unanswered.map((q) => (
        <AnswerRow key={q.id} q={q} showFacility={showFacility} onAnswer={onAnswer} />
      ))}
      {answered.map((q) => (
        <AnswerRow key={q.id} q={q} showFacility={showFacility} onAnswer={onAnswer} />
      ))}
      {questions.length === 0 && <div style={{ textAlign: 'center', color: C.gray400, padding: '32px 0', fontSize: 12.5 }}>No questions yet.</div>}
    </div>
  )
}
