// The answer inputs for the newer question types (WP 5.5, Oct 29 2026), used
// by the final quiz and lesson checkpoints. Grading stays on the server
// (routers/kb_training._is_correct): keywords and the right order never
// reach the browser.
import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, Camera } from 'lucide-react';
import { api } from '../../api';
import { filesFromPaste } from '../../tasks/lib';
import { readAsDataUrl } from '../lib';

// Put in order: `value` is the list of shown positions in the learner's order.
export function OrderAnswer({ q, value, onChange }) {
  const order = Array.isArray(value) && value.length === q.options.length ? value : q.options.map((_, i) => i);
  useEffect(() => { if (!Array.isArray(value) || value.length !== q.options.length) onChange(q.options.map((_, i) => i)); }, [q._id]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="Put these in order">
      {order.map((pos, i) => (
        <li key={pos} className="kb-option" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ width: 20 }}>{i + 1}.</b><span className="kb-grow">{q.options[pos]}</span>
          <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label={`Move ${q.options[pos]} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="kb-ibtn" style={{ width: 28, height: 28 }} aria-label={`Move ${q.options[pos]} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
        </li>
      ))}
    </ol>
  );
}

export function ShortAnswer({ q, value, onChange }) {
  return (
    <textarea className="kb-textarea" style={{ minHeight: 70 }} aria-label={`Answer to: ${q.q}`} value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)} placeholder="Type your answer in your own words" />
  );
}

// Photo proof (WP 5.5): upload or paste a photo; a person reviews it before
// the quiz counts. `value` is the stored photo URL.
export function PhotoAnswer({ q, value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const take = async (file) => {
    if (!file || !file.type?.startsWith('image/')) return;
    setBusy(true); setErr('');
    try { const r = await api.kbUploadMedia(await readAsDataUrl(file), 'proof'); onChange(r.url); }
    catch (e) { setErr(e?.detail || e?.message || 'Upload failed'); } finally { setBusy(false); }
  };
  return (
    <div onPaste={(e) => { const f = filesFromPaste(e)[0]; if (f) { e.preventDefault(); take(f); } }} tabIndex={0}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={`Photo for: ${q.q}`}>
      {value && <img src={value} alt="Your photo" style={{ maxWidth: 320, borderRadius: 10 }} />}
      <label className="kb-btn sm" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
        <Camera />{busy ? 'Uploading...' : value ? 'Replace Photo' : 'Add a Photo'}
        <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      <span className="kb-meta">or press Ctrl+V with a photo copied. A manager reviews it before the quiz counts.</span>
      {err && <span className="kb-meta" style={{ color: '#b91c1c' }}>{err}</span>}
    </div>
  );
}

// true when the question has an answer the learner can submit
export const hasAnswer = (v) => (typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) && v.length > 0);
