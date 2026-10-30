// Calibration (Neil, Oct 29 2026: "add all the bigger features"): HR lines
// up a cycle's finished reviews by Overall Rating, side by side, and moves
// one with a reason before it is shared. The manager's own rating is kept
// and they are told; the employee only ever sees the rating that was
// shared. backend/perf_reviews.py calibration_board / calibrate.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Star } from 'lucide-react';
import { api } from '../api';
import { Modal, Avatar } from '../tasks/components';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { useIsMobile } from '../lib/useIsMobile';
import { NX } from '../tasks/theme';
import { Segmented } from './MyNumbers';
import { LBL, muted } from './lib';

const RATING_COLOR = { exceeds: NX.green, meets: NX.blue, partly: NX.amber, below: NX.red };

function Person({ p, ratings, onMove, busy }) {
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState(p.rating);
  const [why, setWhy] = useState('');
  const g = p.goals || {};
  const goals = [g.met && `${g.met} Met`, g.partly && `${g.partly} Partly`, g.not && `${g.not} Not Met`].filter(Boolean).join(' · ');
  return (
    <div className="nx-cal-person">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Avatar email={p.employeeEmail} name={p.employeeName} size={26} card={false} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600 }}>
            {p.employeeName}{p.promotionReady && <Star size={12} aria-label="Ready for Promotion" color={NX.amber} />}
          </span>
          <span style={{ display: 'block', ...muted, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[p.department, p.managerName].filter(Boolean).join(' · ')}
          </span>
        </span>
        {p.canMove && !moving && (
          <button type="button" className="nx-perf-icon-btn" onClick={() => { setMoving(true); setTo(p.rating); }} aria-label={`Move ${p.employeeName}`} title="Move"><ArrowRightLeft size={14} /></button>
        )}
      </div>
      {(goals || p.calibratedFrom || !p.canMove) && (
        <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>
          {[goals && `Goals: ${goals}`, p.calibratedFrom && `Manager said ${p.calibratedFromLabel}`, !p.canMove && p.stageLabel].filter(Boolean).join(' · ')}
        </div>
      )}
      {moving && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <Segmented label={`Rating for ${p.employeeName}`} value={to} onChange={setTo} options={ratings} />
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={LBL}>Why (The Manager Sees This)</span>
            <input className="form-input" value={why} onChange={e => setWhy(e.target.value)} style={{ fontSize: 16 }} />
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" onClick={() => setMoving(false)}>Cancel</button>
            <button type="button" className="primary-btn" disabled={busy || to === p.rating || why.trim().length < 3}
              onClick={async () => { if (await onMove(p, to, why)) setMoving(false); }}>Move</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CalibrationModal({ cycleId, onClose, onChanged, toastOk, toastErr }) {
  const phone = useIsMobile('(max-width: 900px)');
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [dept, setDept] = useState('');
  const [mgr, setMgr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.perfCalibration(cycleId).then(setB).catch(e => setErr(e?.message || 'Could not load calibration.')), [cycleId]);
  useEffect(() => { load(); }, [load]);
  const people = useMemo(() => (b?.people || []).filter(p => (!dept || p.department === dept) && (!mgr || p.managerEmail === mgr)), [b, dept, mgr]);
  const move = async (p, rating, note) => {
    setBusy(true);
    try { setB(await api.perfCalibrate(p.id, rating, note)); toastOk?.(`${p.employeeName} moved - their manager has been told.`); onChanged?.(); return true; }
    catch (e) { toastErr?.(e?.message || 'Could not move the rating.'); return false; }
    finally { setBusy(false); }
  };
  const total = people.length;
  return (
    <Modal title={b ? `Calibrate - ${b.cycle.name}` : 'Calibrate'} onClose={onClose} width="85vw"
      footer={<button type="button" className="primary-btn" onClick={onClose}>Done</button>}>
      {err ? <ErrorBanner message={err} /> : !b ? <LoadingState size="section" label="Loading the ratings" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
          <div style={muted}>
            Every finished review, by its Overall Rating. Move one before it is shared - the manager&apos;s own rating is kept and they are told why.
            {b.stillWriting > 0 && ` ${b.stillWriting} still being written.`}
          </div>
          {(b.departments.length > 1 || b.managers.length > 1) && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {b.departments.length > 1 && (
                <label style={{ display: 'grid', gap: 4, flex: '0 1 220px' }}><span style={LBL}>Department</span>
                  <select className="form-input" value={dept} onChange={e => setDept(e.target.value)} style={{ fontSize: 16 }}>
                    <option value="">All Departments</option>{b.departments.map(d => <option key={d} value={d}>{d}</option>)}
                  </select></label>
              )}
              {b.managers.length > 1 && (
                <label style={{ display: 'grid', gap: 4, flex: '0 1 220px' }}><span style={LBL}>Manager</span>
                  <select className="form-input" value={mgr} onChange={e => setMgr(e.target.value)} style={{ fontSize: 16 }}>
                    <option value="">All Managers</option>{b.managers.map(([e, n]) => <option key={e || 'hr'} value={e}>{n}</option>)}
                  </select></label>
              )}
            </div>
          )}
          {!b.people.length ? <div style={muted}>No finished reviews yet - they show here once a manager submits theirs.</div> : (
            <div className="nx-fill" style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'repeat(4, minmax(0, 1fr))', gap: 12, flex: 1, minHeight: 0, alignItems: 'start' }}>
              {b.ratings.map(r => {
                const col = people.filter(p => p.rating === r.key);
                const share = total ? Math.round((col.length / total) * 100) : 0;
                return (
                  <section key={r.key} aria-label={r.label} className="nx-cal-col" style={{ '--rule': RATING_COLOR[r.key] }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, paddingBottom: 8 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{r.label}</span>
                      <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' }}>{col.length}</span>
                      <span style={{ ...muted, fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>{share}%</span>
                    </div>
                    {col.length ? col.map(p => <Person key={`${p.id}-${p.rating}`} p={p} ratings={b.ratings} onMove={move} busy={busy} />)
                      : <div style={{ ...muted, fontSize: 12, padding: '8px 0' }}>Nobody</div>}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
