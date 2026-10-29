// Was This Helpful? (Help Center, Oct 2026) - Yes / No under a guide article
// (Documentation and the Help panel) and under an Ask Nexus answer. No asks
// what was missing (optional). One vote per person per article or answer,
// changed in place on the server (help_feedback); administrators read the No
// votes in Knowledge Base > Manage > Help Signals.
import { useState } from 'react';
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { api } from '../api';

// What this person said this session, so reopening an article shows it.
const voted = new Map();
const keyOf = (kind, id) => `${kind}|${id}`;

const btn = (on) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 999,
  border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--line)'}`,
  background: on ? 'rgba(43,69,225,0.08)' : 'var(--card)', color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--ink)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
});

/**
 * @param {'guide'|'answer'} kind
 * @param {string} targetId  guide: "<docId>" or "<docId>#<anchor>"; answer: unused (the question is the key)
 * @param {string} title     what the person was reading, for the Help Signals list
 * @param {string} question  an answer's question
 */
export default function HelpFeedback({ kind = 'guide', targetId = '', title = '', question = '', style }) {
  const key = keyOf(kind, kind === 'answer' ? question.trim().toLowerCase() : targetId);
  const [vote, setVote] = useState(() => voted.get(key) ?? null);   // null | true | false
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [state, setState] = useState(vote === null ? 'idle' : 'thanks');   // idle | thanks | failed

  const send = async (helpful, text = '') => {
    setVote(helpful);
    voted.set(key, helpful);
    try {
      await api.helpFeedback({ target_kind: kind, target_id: targetId, helpful, note: text, question, title });
      setState('thanks');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="help-feedback" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0 4px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Was This Helpful?</span>
        <button type="button" style={btn(vote === true)} aria-pressed={vote === true}
          onClick={() => { setAsking(false); send(true); }}>
          <ThumbsUp size={13} /> Yes
        </button>
        <button type="button" style={btn(vote === false)} aria-pressed={vote === false}
          onClick={() => { setAsking(true); if (vote !== false) send(false); }}>
          <ThumbsDown size={13} /> No
        </button>
        {state === 'thanks' && !asking && (
          <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
            <Check size={13} /> Thanks for the feedback.
          </span>
        )}
        {state === 'failed' && <span role="status" style={{ fontSize: 12, color: 'var(--muted)' }}>Your answer could not be saved. Try again.</span>}
      </div>
      {asking && (
        <form style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          onSubmit={(e) => { e.preventDefault(); send(false, note.trim()); setAsking(false); }}>
          <label style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            What was missing? (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={2}
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box', borderRadius: 8, border: '1px solid var(--line)',
                background: 'var(--card)', color: 'var(--ink)', padding: '7px 9px', fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }} />
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="submit" className="primary-btn" style={{ padding: '5px 12px', fontSize: 12.5 }}>Send</button>
            <button type="button" className="secondary-btn" style={{ padding: '5px 12px', fontSize: 12.5 }} onClick={() => setAsking(false)}>Skip</button>
          </div>
        </form>
      )}
    </div>
  );
}

