// Under Approvals' Shifts filter (Team > Requests moved here, Neil
// 11/04/2026: "make sure that you are not losing any functionality"): the
// swaps and offers still waiting on the teammate - read only, they reach the
// manager once accepted - and the shift requests the manager's team had
// decided lately, by whoever decided them (History is only your own). One
// GET /shift-requests read when the filter opens; nothing on a refusal.
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { useNameResolver } from '../lib/useNameResolver';
import { INBOX_CHANGED } from '../components/shifts/useManagerInbox';
import { PersonMark } from './shared';

const WORD = { approved: ['Approved', 'hsl(var(--color-green))', CheckCircle2], declined: ['Declined', 'hsl(var(--color-red))', XCircle] };

export function useShiftInbox(enabled = true, tick = 0) {
  const [inbox, setInbox] = useState(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const on = () => setBump((n) => n + 1);
    window.addEventListener(INBOX_CHANGED, on);
    return () => window.removeEventListener(INBOX_CHANGED, on);
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    Promise.resolve().then(() => api.shiftRequestsInbox())
      .then((r) => { if (live) setInbox(r && typeof r === 'object' ? r : null); })
      .catch(() => { if (live) setInbox(null); });
    return () => { live = false; };
  }, [enabled, tick, bump]);
  return inbox;
}

export default function ShiftsAlso({ tick = 0 }) {
  const inbox = useShiftInbox(true, tick);
  const nameOf = useNameResolver();
  const who = (p) => (p ? nameOf(p.email, p.name) : 'a teammate');
  const waiting = inbox?.waitingOnPeer || [];
  const recent = inbox?.recent || [];
  if (!waiting.length && !recent.length) return null;
  return (
    <section className="apv-card apv-also" aria-label="More shift requests">
      {waiting.length > 0 && (
        <div data-waiting-peer="">
          <div className="apv-section-h is-static"><span>Waiting On A Teammate</span><b>{waiting.length}</b><em>They reach you once the teammate accepts.</em></div>
          {waiting.map((r) => (
            <div key={r.id} className="apv-hrow">
              <PersonMark person={r.requester} size={30} />
              <div className="apv-hwhat">
                <div className="apv-htitle">{r.summary}</div>
                <div className="apv-detail">{who(r.target)} has not answered yet.</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div data-recent-decided="">
          <div className="apv-section-h is-static"><span>Recently Decided</span><b>{recent.length}</b><em>By anyone on your team.</em></div>
          {recent.map((r) => {
            const [label, color, Icon] = WORD[r.status] || [r.status, 'var(--muted)', null];
            return (
              <div key={r.id} className="apv-hrow">
                <PersonMark person={r.requester} size={30} />
                <div className="apv-hwhat">
                  <div className="apv-htitle">{r.summary}</div>
                  <div className="apv-detail">{[r.decidedBy ? `by ${nameOf(r.decidedBy)}` : '', r.decisionNote ? `"${r.decisionNote}"` : ''].filter(Boolean).join(' · ')}</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>{Icon && <Icon size={12} />}{label}</span>
                <div className="apv-hwhen">{r.decidedAt ? formatDate(`${r.decidedAt}Z`) : ''}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
