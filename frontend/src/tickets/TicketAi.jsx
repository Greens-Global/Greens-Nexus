// Ticket AI (Oct 2026, backend/routers/ticket_ai.py + ticket_ai.py).
//
//   TicketAiSummary       the drawer's AI Summary card - desk agents only.
//                         On demand (Summarize), cached server-side until the
//                         ticket changes, Refresh to rebuild it anyway.
//   SuggestedTopicChips   the create form's Suggested Help Topic chips, from
//                         what the requester has typed (debounced). Clicking a
//                         chip fills the help topic; nothing is ever picked
//                         for them.
//   DrawerSuggestedTopic  the same chips in the drawer, for a ticket filed
//                         without a help topic. Applying goes through the
//                         drawer's normal edit path (held for Done).
//
// Everything here renders NOTHING while loading the switch, when AI is off,
// and on any failure of the status call - a missing card beats a broken one,
// and none of it may take the drawer or the form down with it. Model output
// is rendered as text nodes only (never innerHTML).
import { useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, btn, card } from '../tasks/theme';
import { formatDateTime } from '../lib/datetime';
import { Spinner } from '../components/AsyncState';

export const SUGGEST_MIN_CHARS = 12;
export const SUGGEST_DEBOUNCE_MS = 700;

// The server's switch: { summaries, suggestions, aiRanking }. null until known.
export function useTicketAiStatus() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.getTicketAiStatus())
      .then((r) => { if (alive) setSt(r || {}); })
      .catch(() => { if (alive) setSt({}); });
    return () => { alive = false; };
  }, []);
  return st;
}

const plainText = (html) => {
  if (!html) return '';
  const s = String(html).replace(/<[^>]*>/g, ' ');
  return s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
};

const friendly = (e, fallback) => {
  if (e?.status === 429) return 'Too many requests - try again in a minute.';
  if (e?.status === 424 && e?.message) return e.message;
  return fallback;
};

const ROWS = [
  ['issue', 'Issue'],
  ['tried', 'What Has Been Tried'],
  ['state', 'Current State'],
  ['next_step', 'Next Step'],
];

// ── AI Summary ───────────────────────────────────────────────────────────────
export function TicketAiSummary({ ticketId, canWorkQueue }) {
  const status = useTicketAiStatus();
  const on = !!(canWorkQueue && status?.summaries);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!on || !ticketId) return undefined;
    let alive = true;
    setData(null); setErr('');
    api.getTicketAiSummary(ticketId)
      .then((r) => { if (alive) setData(r || null); })
      .catch(() => { if (alive) setData({ available: false }); });
    return () => { alive = false; };
  }, [on, ticketId]);

  if (!on || !data || data.available === false) return null;

  const run = (refresh) => {
    setBusy(true); setErr('');
    api.makeTicketAiSummary(ticketId, refresh)
      .then((r) => setData(r || data))
      .catch((e) => setErr(friendly(e, 'The AI summary could not be made right now - try again in a minute.')))
      .finally(() => setBusy(false));
  };

  const s = data.summary;
  return (
    <div data-testid="ticket-ai-summary" style={{ ...card, padding: '12px 14px', marginTop: 12, fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Sparkles size={15} style={{ color: NX.purple, flexShrink: 0 }} />
        <div style={{ fontSize: 13.5, fontWeight: 700, color: NX.ink }}>AI Summary</div>
        {s && data.generatedAt && (
          <span style={{ fontSize: 11.5, color: NX.faint }}>Updated {formatDateTime(data.generatedAt)}</span>
        )}
        <span style={{ flex: 1 }} />
        {s ? (
          <button type="button" onClick={() => run(true)} disabled={busy}
            style={{ ...btn('outline'), padding: '5px 10px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
            {busy ? <Spinner size="inline" label="Summarizing" style={{ width: 14, height: 14 }} /> : <RefreshCw size={13} />}
            {busy ? 'Summarizing…' : 'Refresh'}
          </button>
        ) : (
          <button type="button" onClick={() => run(false)} disabled={busy}
            style={{ ...btn('primary'), padding: '6px 11px', fontSize: 12.5, opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Summarizing…' : <><Sparkles size={13} /> Summarize</>}
          </button>
        )}
      </div>
      {!s && !busy && !err && (
        <div style={{ fontSize: 12, color: NX.faint, marginTop: 6, lineHeight: 1.5 }}>
          A short summary of the issue, what has been tried, where it stands and the next step.
        </div>
      )}
      {s && (
        <dl style={{ margin: '10px 0 0', display: 'grid', gap: 8 }}>
          {ROWS.map(([k, label]) => (
            <div key={k}>
              <dt style={{ fontSize: 11.5, fontWeight: 700, color: NX.dim }}>{label}</dt>
              <dd style={{ margin: '2px 0 0', fontSize: 13, color: NX.ink, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{s[k] || '-'}</dd>
            </div>
          ))}
        </dl>
      )}
      {s && data.stale && !busy && (
        <div style={{ fontSize: 11.5, color: NX.amber, fontWeight: 600, marginTop: 8 }}>
          This ticket has changed since this summary was made - Refresh to update it.
        </div>
      )}
      {s && (
        <div style={{ fontSize: 11, color: NX.faint, marginTop: 8, lineHeight: 1.5 }}>
          Made by AI from {data.includesInternal ? 'the description, replies and internal notes' : 'the description and replies'}
          {data.generatedBy ? ` for ${data.generatedBy}` : ''}. Check it against the conversation before acting on it.
        </div>
      )}
      {err && <div role="alert" style={{ fontSize: 12, color: NX.red, fontWeight: 600, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// ── Suggested Help Topic chips ──────────────────────────────────────────────
function TopicChips({ suggestions, onPick, value, label = 'Suggested Help Topic' }) {
  const shown = (suggestions || []).filter((s) => (s.topic || '').toLowerCase() !== (value || '').trim().toLowerCase());
  if (!shown.length) return null;
  return (
    <div data-testid="suggested-topics" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6, fontFamily: FONT }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: NX.dim }}>
        <Sparkles size={12} style={{ color: NX.purple }} />{label}:
      </span>
      {shown.map((s) => (
        <button key={s.topic} type="button" title={s.reason || ''} onClick={() => onPick(s.topic)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 999,
            border: `1px solid ${NX.border}`, background: NX.surface, color: NX.ink, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', fontFamily: FONT, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
          {s.topic}
        </button>
      ))}
    </div>
  );
}

// Create form: subject + description typed so far, the department picked.
export function SuggestedTopicChips({ subject, description, departmentId, value, onPick }) {
  const status = useTicketAiStatus();
  const on = !!status?.suggestions;
  const [suggestions, setSuggestions] = useState([]);
  const seq = useRef(0);
  const text = `${subject || ''} ${plainText(description)}`.trim();

  useEffect(() => {
    if (!on || !departmentId || text.length < SUGGEST_MIN_CHARS) { setSuggestions([]); return undefined; }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api.suggestTicketTopics({ subject: (subject || '').slice(0, 1200), description: plainText(description).slice(0, 20000), department_id: departmentId })
        .then((r) => { if (mine === seq.current) setSuggestions(Array.isArray(r?.suggestions) ? r.suggestions : []); })
        .catch(() => { if (mine === seq.current) setSuggestions([]); });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, departmentId, text]);

  if (!on) return null;
  return <TopicChips suggestions={suggestions} onPick={onPick} value={value} />;
}

// Drawer: a ticket with no help topic yet. `onApply(topic)` is the drawer's
// own edit path for the Help With field.
export function DrawerSuggestedTopic({ ticketId, hasTopic, canWorkQueue, onApply }) {
  const status = useTicketAiStatus();
  const on = !!(canWorkQueue && status?.suggestions && !hasTopic);
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    if (!on || !ticketId) { setSuggestions([]); return undefined; }
    let alive = true;
    api.getTicketSuggestedTopic(ticketId)
      .then((r) => { if (alive) setSuggestions(Array.isArray(r?.suggestions) ? r.suggestions : []); })
      .catch(() => { if (alive) setSuggestions([]); });
    return () => { alive = false; };
  }, [on, ticketId]);
  if (!on) return null;
  return <TopicChips suggestions={suggestions} onPick={onApply} value="" />;
}
