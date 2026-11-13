// New > From Hiring (Neil, 11/13/2026: "Add a means to add from hiring also
// in an intuitive way"). A person who comes through Hiring joins People when
// they are HIRED - their hiring packet's signature does it, or Mark Hired By
// Hand on their candidate card - so this sheet does not add anyone itself and
// is never a second hiring path. It lists the candidates closest to joining
// (At Offer, then At Decision) and a pick opens that candidate's own card in
// Hiring, where Send Hiring Packet and Mark Hired By Hand already live.
// Someone not in Hiring yet starts there with Add Candidate.
import { useEffect, useState } from 'react';
import { ChevronRight, UserPlus } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { STAGE_META, candName } from '../components/HiringCandidateDetail';

const GROUPS = [
  { stage: 'offer', title: 'At Offer', hint: 'Send the hiring packet or mark them hired - they join People as Onboarding.' },
  { stage: 'decision', title: 'At Decision', hint: 'Still being decided - make the offer from their card.' },
];

export function hiringReady(candidates = []) {
  return GROUPS.map((g) => ({
    ...g,
    rows: candidates.filter((c) => c.stage === g.stage && !c.inactive && !c.employeeId)
      .sort((a, b) => candName(a).localeCompare(candName(b))),
  }));
}

export default function FromHiringSheet({ onOpenCandidate, onOpenHiring, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = () => {
    setError(''); setRows(null);
    api.getCandidates().then((r) => setRows(Array.isArray(r) ? r : [])).catch((e) => setError(e?.message || 'Could not load Hiring.'));
  };
  useEffect(load, []);
  const groups = rows ? hiringReady(rows) : [];
  const none = rows && groups.every((g) => !g.rows.length);

  return (
    <Modal title="Add From Hiring" onClose={onClose}
      footer={<button className="secondary-btn" onClick={onOpenHiring} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><UserPlus size={14} /> Open Hiring</button>}>
      <div style={{ fontFamily: 'var(--wk-font)' }}>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Pick who you are bringing on - their candidate card opens in Hiring, with Send Hiring Packet and Mark Hired By Hand.
        </p>
        {error && <ErrorBanner message={error} onRetry={load} />}
        {!rows && !error && <SkeletonBlocks count={4} height={48} />}
        {none && (
          <div className="fh-empty">
            <strong>No one is at Offer or Decision</strong>
            Someone new starts in Hiring as a candidate - Open Hiring, then Add Candidate.
          </div>
        )}
        {groups.filter((g) => g.rows.length).map((g) => (
          <section key={g.stage} className="fh-group" aria-label={g.title}>
            <div className="fh-head"><span>{g.title}</span><span className="fh-count">{g.rows.length}</span></div>
            <div className="fh-hint">{g.hint}</div>
            {g.rows.map((c) => (
              <button key={c.id} type="button" className="fh-row" onClick={() => onOpenCandidate(c.id)}>
                <span className="fh-avatar" aria-hidden="true">{(c.firstName || '?')[0]}{(c.lastName || '')[0] || ''}</span>
                <span className="fh-words">
                  <span className="fh-name">{candName(c) || 'Unnamed Candidate'}</span>
                  <span className="fh-sub">{[c.roleTitle, c.department].filter(Boolean).join(' - ') || 'No role yet'}</span>
                </span>
                <span className="fh-stage" style={{ '--fh-hue': STAGE_META[c.stage]?.hue }}>{STAGE_META[c.stage]?.label}</span>
                <ChevronRight size={15} className="fh-go" aria-hidden="true" />
              </button>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
