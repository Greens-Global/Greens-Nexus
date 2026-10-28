// Describe It (Oct 2026): on a workflow with no steps yet, a box to say in
// plain words what should happen and a Draft It button. The server asks
// Claude for a definition, validates it like a hand-built one and hands it
// back with its problems; it lands in the builder for editing and is never
// published by itself.
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../api';
import { btn } from '../../tasks/theme';
import { card, cardTitle, hint, textInput } from '../lib/text.builder-helpers';
import { errorText } from '../lib/errors';

export default function DescribeIt({ onDraft, companyId = '' }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const [problems, setProblems] = useState([]);

  const draft = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true); setError(''); setNotes(''); setProblems([]);
    try {
      const r = await api.wfDescribe({ text: t, companyId });
      if (!r?.definition) throw new Error('No draft came back.');
      setNotes(r.notes || '');
      setProblems(r.problems || []);
      onDraft(r.definition, r.problems || [], r.notes || '');
    } catch (e) {
      const status = e?.status || e?.response?.status;
      setError(status === 503 ? 'Describe It is not set up on this server yet. Build the workflow with Add Step instead.' : errorText(e, 'The draft could not be made.'));
    } finally { setBusy(false); }
  };

  return (
    <section style={{ ...card, borderStyle: 'dashed' }} aria-label="Describe It">
      <div style={cardTitle}>Describe It</div>
      <div style={hint}>Say what should happen and a draft is written for you to edit. Nothing runs until you test and publish it.</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Describe what should happen"
        placeholder="e.g. When a time off request is approved, tell the manager and post the dates to the team's chat."
        style={{ ...textInput, minHeight: 72, resize: 'vertical', lineHeight: 1.45 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={draft} disabled={busy || !text.trim()} style={{ ...btn('primary'), opacity: busy || !text.trim() ? 0.6 : 1 }}>
          <Sparkles size={14} /> {busy ? 'Drafting...' : 'Draft It'}
        </button>
        {error && <span style={{ ...hint, color: 'hsl(var(--color-red))' }}>{error}</span>}
      </div>
      {notes && <div style={hint}>{notes}</div>}
      {!!problems.length && (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {problems.map((p, i) => <li key={i} style={{ ...hint, color: 'hsl(var(--color-orange))' }}>{p.message}</li>)}
        </ul>
      )}
    </section>
  );
}
