// Help Signals (Help Center, Oct 2026) - for administrators, in Knowledge Base
// > Manage > Health beside the searches with no good answer: the guide pages
// and Ask Nexus answers people said did not help (with what was missing),
// the Help searches that found nothing, and how many people searched the
// ticket form and filed anyway. GET /help-center/signals.
import { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp, Search, Ticket } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { openDoc } from './openDoc';

import { SOURCE_NAMES } from './helpLog';

const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 14 };
const h = { margin: '0 0 2px', fontSize: 14, fontWeight: 700, color: 'var(--ink)' };
const meta = { fontSize: 12, color: 'var(--muted)' };

export default function HelpSignals() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api.helpSignals().then((r) => { if (alive) setData(r); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  if (failed) return <section style={card}><h3 style={h}>Help Signals</h3><div style={meta}>Help Signals could not load right now.</div></section>;
  if (!data) return <section style={card} aria-busy="true"><h3 style={h}>Help Signals</h3><div style={meta}>Loading...</div></section>;
  const { votes = { yes: 0, no: 0 }, not_helpful: notHelpful = [], failed_searches: misses = [], ticketed_after_search: ticketed = 0 } = data;
  return (
    <section style={card} aria-label="Help Signals">
      <h3 style={h}>Help Signals</h3>
      <div style={{ ...meta, marginBottom: 10 }}>What people could not find in the Help Center. Last 90 days of votes, 30 days of searches.</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--ink)', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ThumbsUp size={13} /> {votes.yes} Helpful</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ThumbsDown size={13} /> {votes.no} Not Helpful</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ticket size={13} /> {ticketed} Searched, Then Filed a Ticket</span>
      </div>

      {notHelpful.length > 0 && (
        <>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '6px 0' }}>Not Helpful</div>
          {notHelpful.map((a) => (
            <div key={`${a.kind}:${a.id}`} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                {a.kind === 'guide'
                  ? <button type="button" onClick={() => { const [d, an = null] = a.id.split('#'); openDoc(d, an); }}
                      style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', textAlign: 'left' }}>
                      {a.title || a.id}
                    </button>
                  : <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Ask Nexus: "{a.question}"</span>}
                <span style={{ ...meta, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{a.no} No · {a.yes} Yes</span>
              </div>
              {a.notes.map((n) => (
                <div key={n.at + n.note} style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 3 }}>"{n.note}" <span style={meta}>{formatDate(n.at)}</span></div>
              ))}
            </div>
          ))}
        </>
      )}

      {misses.length > 0 && (
        <>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 0 6px' }}>Searches With No Answer</div>
          {misses.map((m) => (
            <div key={`${m.source}:${m.query}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <Search size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--ink)', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>"{m.query}"</span>
              <span style={{ ...meta, whiteSpace: 'nowrap' }}>{SOURCE_NAMES[m.source] || m.source} · {m.count} {m.count === 1 ? 'search' : 'searches'}</span>
            </div>
          ))}
        </>
      )}
      {!notHelpful.length && !misses.length && <div style={meta}>Nothing to look at yet.</div>}
    </section>
  );
}
