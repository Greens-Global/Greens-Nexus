// Refresher (Neil, 11/07/2026): spaced repetition after a course is passed.
// Up to three questions a day from the banks of courses the person has
// passed, asked again on a widening schedule (the server keeps it:
// GET /kb/refresher/today, POST /kb/refresher/answer). A right answer says
// so and moves on; a wrong one shows the explanation and the right answer.
// Nothing here changes a score or a certificate. Shown at the top of My
// Learning and as the Dashboard's Refresher widget; with nothing due it is
// one quiet line (what it is and when it starts), so it never nags.
import { useEffect, useState } from 'react';
import { Brain, Check, X, Flame } from 'lucide-react';
import { api } from '../../api';
import { OrderAnswer, ShortAnswer, hasAnswer } from './QuestionInputs';
import { plural } from '../lib';

function Question({ item, onAnswered }) {
  const q = item.question;
  const [value, setValue] = useState(q.type === 'order' ? q.options.map((_, i) => i) : q.type === 'short' ? '' : []);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = (pos) => setValue((v) => (q.type === 'multi' ? (v.includes(pos) ? v.filter((x) => x !== pos) : [...v, pos]) : [pos]));
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.kbRefresherAnswer(item.item_id, { answer: value, order: item.order });
      setResult(r);
      onAnswered(r);
    } catch (e) {
      setResult({ error: e?.message || 'Could not check that answer' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kb-refresher-q">
      <div className="kb-meta">{item.course_title}</div>
      <div className="kb-refresher-text">{q.q}{q.type === 'multi' && <span className="kb-meta"> (choose all that apply)</span>}</div>
      {!result && (
        <>
          {['single', 'multi', 'tf'].includes(q.type) && q.options.map((o, pos) => (
            <label key={pos} className={`kb-option${value.includes(pos) ? ' on' : ''}`}>
              <input type={q.type === 'multi' ? 'checkbox' : 'radio'} name={item.item_id} checked={value.includes(pos)} onChange={() => pick(pos)} /><span>{o}</span>
            </label>
          ))}
          {q.type === 'order' && <OrderAnswer q={{ ...q, _id: item.item_id }} value={value} onChange={setValue} />}
          {q.type === 'short' && <ShortAnswer q={{ ...q, _id: item.item_id }} value={value} onChange={setValue} />}
          <button type="button" className="kb-btn sm pri" style={{ alignSelf: 'flex-start' }} disabled={busy || !hasAnswer(value)} onClick={send}>Check</button>
        </>
      )}
      {result && !result.error && (
        <div className={`kb-refresher-result ${result.correct ? 'ok' : 'miss'}`}>
          <b>{result.correct ? <><Check size={14} /> Right.</> : <><X size={14} /> Not this time.</>}</b>
          {!result.correct && result.answer && <span>The answer: {result.answer.join(result.answer.length > 2 ? ' → ' : ' and ')}.</span>}
          {result.explanation && <span>{result.explanation}</span>}
          <span className="kb-meta">You will see this one again in {plural(result.next_in_days, 'day')}.</span>
        </div>
      )}
      {result?.error && <div className="kb-meta" style={{ color: '#b91c1c' }}>{result.error}</div>}
    </div>
  );
}

export default function Refresher({ compact = false }) {
  const [data, setData] = useState(null);
  const [done, setDone] = useState(0);
  const [streak, setStreak] = useState(0);
  useEffect(() => {
    let live = true;
    api.kbRefresherToday().then((d) => { if (live) { setData(d); setStreak(d.streak || 0); } }).catch(() => { if (live) setData({ items: [] }); });
    return () => { live = false; };
  }, []);
  if (!data || !data.items?.length) {
    if (!data) return null;
    // A new learner sees what it is and when it starts (11/08/2026); one quiet line, never a nag.
    const line = data.total > 0
      ? `Nothing due today. ${data.streak > 0 ? `${plural(data.streak, 'day')} in a row.` : 'Questions from the courses you passed come back here on their own schedule.'}`
      : 'Starts the day after you pass your first course: up to three of its questions a day, each one coming back less often as you get it right. It never changes a score.';
    return <div className={`kb-refresher kb-card soft${compact ? ' compact' : ''}`}><div className="kb-refresher-head"><Brain size={16} /><b>Refresher</b></div><div className="kb-meta">{line}</div></div>;
  }
  const finished = done >= data.items.length;
  return (
    <section className={`kb-refresher kb-card soft${compact ? ' compact' : ''}`} aria-label="Refresher">
      <div className="kb-refresher-head">
        <Brain size={16} />
        <b>Refresher</b>
        <span className="kb-meta">{finished ? 'Done for today' : `${plural(data.items.length - done, 'question')} from the courses you passed`}</span>
        {streak > 1 && <span className="kb-refresher-streak"><Flame size={13} />{plural(streak, 'day')} in a row</span>}
      </div>
      {!finished && data.items.slice(done, done + 1).map((it) => <Question key={it.item_id} item={it} onAnswered={(r) => { setStreak(r.streak || streak); setTimeout(() => setDone((d) => d + 1), r.correct ? 900 : 4500); }} />)}
      {finished && <div className="kb-meta">That is today's three. The ones you missed come back tomorrow; the ones you knew wait longer each time.</div>}
    </section>
  );
}
