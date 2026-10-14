// One Notes timeline per candidate (Neil, Oct 14): "consolidate all of that and
// just make it a notes section, so it's not in two different areas ... with
// time and date and person who put it in." Every note, every stage move with
// its note, and every finished interview with its verdict - newest first.
// Anyone who can see the candidate adds a note (Neil: "whoever is looking at
// the candidate should be able to put their notes in"); notes are never edited.
// Shown on the candidate card and in the Interview Room, so everyone's
// screening notes are in front of the interviewer ("we need to be able to see
// all those comments prior to the interview").
import { useEffect, useState } from 'react';
import { MessageSquare, ArrowRight, Video, Send } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';
import { Spinner } from './AsyncState';

const LABEL = { applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected' };

function what(e) {
  if (e.kind === 'note') return null;
  if (e.kind === 'interview') return 'Interview finished';
  if (!e.fromStage) return `Added - ${LABEL[e.toStage] || e.toStage}`;
  if (e.fromStage === e.toStage) return null;
  return `Moved to ${LABEL[e.toStage] || e.toStage}`;
}

export default function CandidateNotes({ candidateId, refreshKey, draft, onDraft, canAdd = true, compact = false, toastErr }) {
  const [rows, setRows] = useState(null);
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  // The draft can live with the parent (the card sends it along with a move).
  const text = draft !== undefined ? draft : own;
  const setText = onDraft || setOwn;
  useEffect(() => {
    let live = true;
    api.getCandidateHistory(candidateId).then(r => live && setRows(r || [])).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [candidateId, refreshKey, n]);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try { await api.addCandidateNote(candidateId, text.trim()); setText(''); setN(x => x + 1); }
    catch (e) { toastErr?.(e?.message || 'Could not add the note.'); }
    setBusy(false);
  }

  const shown = [...(rows || [])].reverse();
  return (
    <div>
      {canAdd && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
          <textarea className="form-input" rows={compact ? 2 : 3} value={text} onChange={e => setText(e.target.value)}
            aria-label="Add a note" placeholder="Add a note - what stood out in the resume, the screening call, the interview..."
            style={{ flex: 1, resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
          <button type="button" className="secondary-btn" onClick={add} disabled={busy || !text.trim()}
            style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {busy ? <Spinner size={12} /> : <Send size={12} />} Add Note
          </button>
        </div>
      )}
      {rows === null ? <Spinner size={16} /> : shown.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No notes yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: compact ? 260 : 'none', overflowY: compact ? 'auto' : 'visible' }}>
          {shown.map((e, i) => {
            const head = what(e);
            const Icon = e.kind === 'note' ? MessageSquare : e.kind === 'interview' ? Video : ArrowRight;
            return (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <Icon size={14} style={{ color: e.kind === 'note' ? 'var(--pine)' : 'var(--muted)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
                  {head && <div style={{ fontWeight: 700 }}>{head}</div>}
                  {e.note && !(head && e.note === 'Candidate added') && (
                    <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink)', marginTop: head ? 2 : 0 }}>{e.note}</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                    {e.byName || 'Nexus'}{e.createdAt ? ` · ${formatDateTime(e.createdAt)}` : ''}{e.legacy ? ' · from the old notes box' : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
