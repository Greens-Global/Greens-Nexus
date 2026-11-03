import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import PolicyDoc from './PolicyDoc';
import { api, API_BASE } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';

// The Privacy Policy (11/02/2026, the legal compliance pass). The text, the
// data categories, every outside service and the live AI status come from ONE
// server inventory (backend/privacy_inventory.py) - nothing about what Nexus
// collects or who it shares with is typed here, so the page cannot drift from
// the code (backend/test_privacy_inventory.py fails on an outbound host the
// inventory does not list).
//
//  - Public (/privacy, before sign-in): GET /policy/privacy-notice with a plain
//    fetch, never MSAL.
//  - Embedded (Legal > Privacy Policy): GET /policy/privacy-notice/me, which
//    adds the person's HR contact, the services in use on this Nexus, and for
//    administrators the counsel-review note and what they still need to fill.
//
// Never blank: a skeleton while loading, and if the server cannot be reached
// a short summary with Try Again.

async function fetchPublic() {
  const res = await fetch(`${API_BASE}/policy/privacy-notice`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const FALLBACK_SECTIONS = [
  { h: 'Privacy Policy', p: [
    'The full Privacy Policy could not be loaded right now. In short: Nexus collects the personal information your organization needs to run your employment (identity, HR, pay, time, location when a punch asks for it, work monitoring on company-managed computers while you are clocked in, and what you create or upload), shares it only with the service providers that run Nexus, does not sell it, and keeps it as long as the law and your organization’s records schedule require. AI features are off unless your organization turns them on.',
    'For questions or to use your privacy rights, contact your HR team or use Ask HR.',
  ] },
];

function ProcessorTable({ rows, groupTitles, embedded }) {
  const groups = Object.keys(groupTitles || {});
  const line = embedded ? 'var(--line, #e5e7eb)' : '#e5e7eb';
  const muted = embedded ? 'var(--muted, #6b7280)' : '#6b7280';
  const showUse = rows.some((r) => 'inUse' in r);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 6 }}>
      {groups.map((g) => {
        const list = rows.filter((r) => r.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div style={{ fontSize: 13, fontWeight: 700, margin: '0 0 6px' }}>{groupTitles[g]}</div>
            <div style={{ overflowX: 'auto', border: `1px solid ${line}`, borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, lineHeight: 1.5, minWidth: 520 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: muted }}>
                    <th style={{ padding: '8px 10px', fontWeight: 600 }}>Service</th>
                    <th style={{ padding: '8px 10px', fontWeight: 600 }}>Why</th>
                    <th style={{ padding: '8px 10px', fontWeight: 600 }}>What It Receives</th>
                    {showUse && <th style={{ padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>In Use</th>}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.key} style={{ borderTop: `1px solid ${line}`, verticalAlign: 'top' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.name}</td>
                      <td style={{ padding: '8px 10px' }}>{r.purpose}</td>
                      <td style={{ padding: '8px 10px' }}>{r.data}</td>
                      {showUse && (
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: r.inUse ? 'inherit' : muted }}>
                          {r.adminConfigured ? 'If Set Up' : r.inUse ? 'Yes' : 'No'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AiStatus({ ai, embedded }) {
  const on = !!ai?.enabled;
  return (
    <div role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999,
      fontSize: 13, fontWeight: 600, margin: '2px 0 10px',
      border: `1px solid ${embedded ? 'var(--line, #e5e7eb)' : '#e5e7eb'}`,
      background: on ? 'rgba(217,119,6,0.10)' : 'rgba(22,163,74,0.10)' }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: on ? '#d97706' : '#16a34a' }} />
      {on ? 'AI Features: On' : 'AI Features: Off'}
    </div>
  );
}

function AdminNotes({ admin }) {
  if (!admin) return null;
  const box = { border: '1px solid hsl(var(--color-amber, 38 92% 50%))', background: 'hsla(var(--color-amber, 38 92% 50%), 0.08)',
    borderRadius: 10, padding: '10px 14px', fontSize: 13, lineHeight: 1.55, marginBottom: 14 };
  return (
    <div>
      <div role="note" style={box}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, marginBottom: 2 }}>
          <AlertTriangle size={14} aria-hidden="true" /> Draft for Counsel Review
        </div>
        Only administrators see this note. This notice is a draft built from what Nexus actually collects and
        the services it actually calls. It is not legal advice: have your counsel review it, and the sign-in
        policy, before you rely on them.
      </div>
      {admin.needsInput?.length > 0 && (
        <div role="note" style={box}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Needs Your Input</div>
          People use the company&apos;s HR contact to make privacy requests. These companies have none:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {admin.needsInput.map((n) => <li key={n.company}>{n.company}: add the {n.field} under {n.where}.</li>)}
          </ul>
        </div>
      )}
      {admin.signInPolicyOutOfDate && (
        <div role="note" style={box}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Sign-In Policy Out of Date</div>
          The published sign-in policy is missing: {admin.signInPolicyOutOfDate.missing.join(', ')}. Open
          Settings &gt; Security &gt; Sign-In Policy to start a draft from the new default.
        </div>
      )}
    </div>
  );
}

export default function PrivacyPolicy({ embedded = false }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false); setData(null);
    (embedded ? api.privacyNoticeMe() : fetchPublic())
      .then((d) => setData(d))
      .catch(() => setFailed(true));
  }, [embedded]);
  useEffect(() => { load(); }, [load]);

  if (failed) {
    return (
      <div>
        <PolicyDoc title="Privacy Policy" updated="" sections={FALLBACK_SECTIONS} embedded={embedded} />
        <div style={{ maxWidth: 720, margin: '-20px auto 0', padding: embedded ? 0 : '0 24px 40px' }}>
          <button type="button" className="secondary-btn" onClick={load} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RotateCcw size={14} /> Try Again
          </button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label="Loading the Privacy Policy" style={{ maxWidth: 720, margin: '0 auto', padding: embedded ? 0 : '48px 24px' }}>
        <SkeletonBlocks count={4} height={80} borderRadius={10} />
      </div>
    );
  }
  const sections = (data.sections || []).map((s) => ({
    ...s,
    extra: s.processors ? <ProcessorTable rows={s.processors} groupTitles={s.groupTitles} embedded={embedded} />
      : s.aiStatus ? <AiStatus ai={s.aiStatus} embedded={embedded} /> : null,
    extraFirst: !!s.aiStatus,
  }));
  return (
    <PolicyDoc title={data.title || 'Privacy Policy'} updated={data.updated} sections={sections} embedded={embedded}
      before={<AdminNotes admin={data.admin} />} />
  );
}
