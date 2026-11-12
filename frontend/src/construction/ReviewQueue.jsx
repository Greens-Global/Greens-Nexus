// Construction - manager review. The 10-minute half of the promise.
//
// The design question is what a manager reads first. Not the newest log: the
// one the crew tagged Safety (and, with AI on, the one the AI was least sure
// about). The server orders the queue on exactly that (see
// /construction/review-queue), so this screen renders the order it is given
// rather than re-sorting by date.
//
// With AI on, the raw note and the AI summary are shown SIDE BY SIDE, never one
// replacing the other. Approving a summary you cannot check against what the
// worker actually wrote is rubber-stamping. With AI off (the default - Neil,
// Oct 29 2026) there is no summary and nothing about AI shows at all: the
// crew's own words, tags and photos are the log (11/03/2026).
//
// An Approve can be taken back for a few seconds (the Undo toast): the undo is
// the server's Reopen, with the reason on the record.
import { useCallback, useEffect, useState } from 'react';
import { LoadingState } from '../components/AsyncState';
import {
  ClipboardCheck, AlertTriangle, ShieldAlert, Clock, MapPin, Image as ImageIcon,
  Check, Undo2, ChevronDown, ChevronRight, Sparkles,
} from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { StatusLabel } from '../components/StatusLabel';
import { dialog } from '../ui/dialog';
import { CARD, TAG_COLOR, TONE, personName, tagLabel } from './ui';
import { useConstructionMeta } from './lib/meta';
import { formatHoursWords } from '../lib/hoursText';

const SEV = {
  high:   'hsl(var(--color-red))',
  medium: '#ca8a04',
  low:    'var(--text-secondary)',
};

const LABEL = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 };

// Shown only when the AI actually ran. A 0.0 on an unprocessed log would read as
// "the model had no confidence" rather than "the model has not looked yet".
function Confidence({ value }) {
  const pct = Math.round((value || 0) * 100);
  const low = pct < 50;
  return (
    <span title="How confident the AI was, given how much evidence the worker attached"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem',
               fontWeight: 600, color: low ? 'hsl(var(--color-red))' : 'var(--text-secondary)' }}>
      <Sparkles size={11} />{pct}%{low ? ' - check this one' : ''}
    </span>
  );
}

function LogCard({ log, onDecide, busy, aiEnabled }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [media, setMedia] = useState(null);

  // Media is fetched only when the card is opened. A queue of forty logs would
  // otherwise fire forty requests to render thumbnails nobody has looked at.
  useEffect(() => {
    if (!open || media !== null) return;
    api.getConstructionMedia(log.id).then(setMedia).catch(() => setMedia([]));
  }, [open, media, log.id]);

  const safety = aiEnabled ? (log.aiSafetyFlags || []) : [];
  const delays = aiEnabled ? (log.aiDelayFlags || []) : [];
  const author = log.authorName || personName(log.authorEmail);

  return (
    <div data-review-log={log.id} style={{ border: '1px solid var(--border-color)', borderRadius: 10,
                  backgroundColor: 'var(--bg-primary)', marginBottom: 12, overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none',
                 padding: 16, cursor: 'pointer', fontFamily: 'inherit', color: 'inherit' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {open ? <ChevronDown size={16} style={{ marginTop: 3, flexShrink: 0 }} />
                : <ChevronRight size={16} style={{ marginTop: 3, flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{log.projectName}</strong>
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{formatDate(log.logDate, log.logDate)}</span>
              {(log.tags || []).map((t) => <StatusLabel key={t} size="sm" label={tagLabel(t)} color={TAG_COLOR[t]} />)}
              {safety.length > 0 && (
                <StatusLabel size="sm" color={TONE.red} label={`${safety.length} Safety Flag${safety.length === 1 ? '' : 's'}`} />
              )}
              {delays.length > 0 && <StatusLabel size="sm" color={TONE.yellow} label="Delay" />}
              {aiEnabled && log.awaitingAi && <StatusLabel size="sm" color={TONE.slate} label="AI Pending" />}
              {!log.geofenceOk && (
                <span title="Filed outside the jobsite geofence - advisory only"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.75rem',
                           color: 'var(--text-secondary)' }}><MapPin size={11} />Off-Site</span>
              )}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)',
                          display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{author}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <ImageIcon size={12} />{log.mediaCount}
              </span>
              {log.crewSize ? <span>crew of {log.crewSize}</span> : null}
              {log.hoursWorked ? <span>{formatHoursWords(log.hoursWorked, { compact: true })}</span> : null}
              {aiEnabled && !log.awaitingAi && <Confidence value={log.aiConfidence} />}
            </div>
          </div>
        </div>
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px 44px' }}>
          {aiEnabled ? (
            /* Side by side, always. Approving a summary without the source is
               rubber-stamping. */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
              <div>
                <div style={LABEL}>Crew Notes</div>
                <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0,
                            color: log.notes ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  {log.notes || 'Nothing written - media only.'}
                </p>
              </div>
              <div>
                <div style={LABEL}>AI Summary</div>
                <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0,
                            color: log.aiSummary ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  {log.aiSummary || (log.awaitingAi ? 'Still processing.' : 'No summary produced.')}
                </p>
              </div>
            </div>
          ) : (
            <div>
              <div style={LABEL}>Crew Notes</div>
              <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0,
                          color: log.notes ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {log.notes || 'Nothing written - media only.'}
              </p>
            </div>
          )}

          {safety.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {safety.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
                                      fontSize: 13, marginBottom: 4 }}>
                  <ShieldAlert size={14} style={{ color: SEV[f.severity] || SEV.low, flexShrink: 0, marginTop: 2 }} />
                  <span><strong style={{ textTransform: 'capitalize' }}>{f.severity}</strong> &middot; {f.issue}</span>
                </div>
              ))}
            </div>
          )}

          {delays.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {delays.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
                                      fontSize: 13, marginBottom: 4 }}>
                  <Clock size={14} style={{ color: SEV.medium, flexShrink: 0, marginTop: 2 }} />
                  <span>{d.cause}{d.impact_days ? ` (${d.impact_days} day impact)` : ''}</span>
                </div>
              ))}
            </div>
          )}

          {media === null ? (
            <LoadingState compact label="Loading media…" />
          ) : media.length > 0 && (
            <div style={{ marginTop: 14, display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
              {media.map((m) => (
                <a key={m.id} href={m.egnyteWebUrl || m.url} target="_blank" rel="noreferrer"
                   title={m.caption || (aiEnabled ? m.aiCaption : '') || m.description || m.kind}
                   style={{ display: 'block', aspectRatio: '1', borderRadius: 8, overflow: 'hidden',
                            border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-card)' }}>
                  {m.kind === 'photo' && m.url
                    ? <img src={m.thumbnailUrl || m.url} alt={m.caption || m.description || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    height: '100%', fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{m.kind}</div>}
                </a>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Question for the crew (required to send back)" aria-label="Question for the crew"
              style={{ flex: '1 1 220px', fontSize: 13 }} />
            {/* Sending back without saying why just produces a second identical
                log, so the button stays disabled until there is a question. */}
            <button className="secondary-btn" disabled={busy || !note.trim()}
              title={note.trim() ? 'Send back to the crew member' : 'Write a question first'}
              onClick={() => onDecide(log, 'needs_info', note.trim())}>
              <Undo2 size={15} />Send Back
            </button>
            <button className="primary-btn" disabled={busy}
              onClick={() => onDecide(log, 'approve', note.trim())}>
              <Check size={15} />Approve
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReviewQueue({ projectId = '', onDecided }) {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const { aiEnabled } = useConstructionMeta();

  const load = useCallback(() => {
    setError('');
    const get = projectId && api.getConstructionReviewQueueFor
      ? api.getConstructionReviewQueueFor(projectId) : api.getConstructionReviewQueue();
    Promise.resolve(get)
      .then((rows) => setLogs((rows || []).filter((l) => !projectId || l.projectId === projectId)))
      .catch((e) => { setLogs([]); setError(e.message || 'Could not load the review queue.'); });
  }, [projectId]);

  useEffect(load, [load]);

  const decide = async (log, decision, note) => {
    setBusyId(log.id); setError('');
    try {
      await api.reviewConstructionLog(log.id, { decision, note });
      // Drop it locally rather than refetching: a reload would re-rank the whole
      // queue and move the rows under the manager's cursor mid-review.
      setLogs((prev) => (prev || []).filter((l) => l.id !== log.id));
      onDecided?.();
      if (decision === 'approve') {
        // A few seconds to take it back - through the server's Reopen, so the
        // undo is on the record like any other reopen.
        dialog.undo(`Approved ${formatDate(log.logDate, log.logDate)} on ${log.projectName}`, async () => {
          try {
            await api.reopenConstructionLog(log.id, 'Approval undone');
            load();
            onDecided?.();
          } catch (e) {
            setError(e.message || 'Could not undo that approval.');
          }
        });
      }
    } catch (e) {
      setError(e.message || 'Could not record that decision.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div style={CARD}>
      <h3 style={{ fontSize: 18, fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>
        Review Queue
      </h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 20 }}>
        {aiEnabled
          ? 'Logs waiting on a decision - low AI confidence and safety first'
          : 'Logs waiting on a decision - the ones the crew tagged Safety first, then the oldest'}
      </p>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', marginBottom: 16,
                      borderRadius: 8, backgroundColor: 'hsl(var(--color-red) / 0.08)',
                      border: '1px solid hsl(var(--color-red) / 0.3)', fontSize: 13 }}>
          <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="secondary-btn" style={{ padding: '4px 12px', fontSize: 13 }} onClick={load}>Retry</button>
        </div>
      )}

      {logs === null ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          Loading review queue&hellip;
        </div>
      ) : logs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
          <ClipboardCheck size={32} style={{ opacity: 0.4, marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            Nothing waiting on you
          </div>
          <p style={{ fontSize: 13 }}>Submitted logs appear here once the crew files them.</p>
        </div>
      ) : (
        logs.map((l) => (
          <LogCard key={l.id} log={l} onDecide={decide} busy={busyId === l.id} aiEnabled={aiEnabled} />
        ))
      )}
    </div>
  );
}
