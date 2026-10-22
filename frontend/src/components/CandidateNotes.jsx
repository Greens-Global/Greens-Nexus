// One Notes timeline per candidate (Neil, Oct 14): "consolidate all of that and
// just make it a notes section, so it's not in two different areas ... with
// time and date and person who put it in." Every note, every stage move with
// its note, and every finished interview with its verdict - newest first,
// grouped by day. Anyone who can see the candidate adds a note (Neil:
// "whoever is looking at the candidate should be able to put their notes
// in"); notes are never edited.
//
// Read as a thread (Pranshu, Oct 15: "when we will have full data it will be
// more messy"): a note is a bubble with who wrote it; a move or a finished
// interview is one thin grey line, so a busy candidate still reads at a
// glance. Shown on the candidate card and in the Interview Room.
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Video, Send, UserPlus } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatTime } from '../lib/datetime';
import { Spinner } from './AsyncState';

const LABEL = { applied: 'Applied', screening: 'Screening', interview: 'Interview', decision: 'Decision', offer: 'Offer', hired: 'Hired', rejected: 'Rejected' };
const initials = (name) => (name || '?').split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const hue = (name) => { let h = 0; for (const ch of name || '') h = (h * 31 + ch.charCodeAt(0)) % 360; return `${h},45%,45%`; };

function what(e) {
  if (e.kind === 'note') return null;
  if (e.kind === 'interview') return 'Interview finished';
  if (!e.fromStage) return 'Added to the pipeline';
  if (e.fromStage === e.toStage) return null;
  return `Moved to ${LABEL[e.toStage] || e.toStage}`;
}

export default function CandidateNotes({ candidateId, refreshKey, draft, onDraft, canAdd = true, compact = false, toastErr }) {
  const [rows, setRows] = useState(null);
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  const box = useRef(null);
  // The draft can live with the parent (the card sends it along with a move).
  const text = draft !== undefined ? draft : own;
  const setText = onDraft || setOwn;
  useEffect(() => {
    let live = true;
    api.getCandidateHistory(candidateId).then(r => live && setRows(r || [])).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [candidateId, refreshKey, n]);
  // One line that grows with what is typed - never a big empty box.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try { await api.addCandidateNote(candidateId, text.trim()); setText(''); setN(x => x + 1); }
    catch (e) { toastErr?.(e?.message || 'Could not add the note.'); }
    setBusy(false);
  }

  // Newest first, grouped by day.
  const shown = [...(rows || [])].reverse();
  const groups = [];
  shown.forEach(e => {
    const day = (e.createdAt || '').slice(0, 10);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e); else groups.push({ day, items: [e] });
  });

  return (
    <div>
      {canAdd && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
          <textarea ref={box} className="form-input" rows={1} value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); }}
            aria-label="Add a note" placeholder="Add a note..."
            style={{ flex: 1, resize: 'none', overflow: 'hidden', fontFamily: 'Inter,sans-serif', fontSize: 13, lineHeight: 1.5, minHeight: 38 }} />
          <button type="button" className="primary-btn" onClick={add} disabled={busy || !text.trim()} title="Ctrl+Enter"
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, height: 38 }}>
            {busy ? <Spinner size={12} /> : <Send size={12} />} Add Note
          </button>
        </div>
      )}
      {rows === null ? <Spinner size={16} /> : shown.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No notes yet.</div>
      ) : (
        <div style={{ maxHeight: compact ? 260 : 'none', overflowY: compact ? 'auto' : 'visible' }}>
          {groups.map(g => (
            <div key={g.day}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 0 6px' }}>
                {g.day ? formatDate(g.day) : ''}
              </div>
              {g.items.map((e, i) => {
                const head = what(e);
                const when = e.createdAt ? formatTime(e.createdAt) : '';
                if (e.kind === 'note') {
                  return (
                    <div key={i} style={{ display: 'flex', gap: 10, padding: '5px 0' }}>
                      <span title={e.byName} style={{ width: 28, height: 28, borderRadius: 14, flexShrink: 0, background: `hsla(${hue(e.byName)},0.15)`, color: `hsl(${hue(e.byName)})`, fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        {initials(e.byName)}
                      </span>
                      <div style={{ flex: 1, minWidth: 0, background: 'var(--mist)', borderRadius: '4px 12px 12px 12px', padding: '8px 12px' }}>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 2 }}>
                          <b style={{ color: 'var(--ink)' }}>{e.byName || 'Nexus'}</b>{when ? ` · ${when}` : ''}{e.legacy ? ' · from the old notes box' : ''}
                        </div>
                        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{e.note}</div>
                      </div>
                    </div>
                  );
                }
                const Icon = e.kind === 'interview' ? Video : e.fromStage ? ArrowRight : UserPlus;
                return (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 0 4px 6px', fontSize: 12.5, color: 'var(--muted)' }}>
                    <Icon size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{head}</span>
                      {e.note && e.note !== 'Candidate added' && <span> - {e.note}</span>}
                      <span>{e.byName ? ` · ${e.byName}` : ''}{when ? ` · ${when}` : ''}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
