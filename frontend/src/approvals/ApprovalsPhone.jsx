// Approvals on a phone (Neil, 11/02/2026: "simple and actionable, tap tap
// tap and move on"). Under 760px ApprovalsCenter renders this instead of its
// rail, tiles, tools row and table: a count pill, the Waiting / History
// control, a chip strip by kind with the Filter chip at its end, and one
// ApprovalCard per request with two big decisions. Presentation only - every
// prop is ApprovalsCenter's existing state, every decision goes back through
// its `decide` (onAct) and so through lib/approvalActions.js and the Undo
// window exactly as on the desktop. Nothing here bulk-approves.
//
// Motion (lib/motion.js tokens, transform and opacity only):
//   - a decided card stays for one beat as a GHOST - lifted out of the flow
//     at the spot it held (drawn at list level, so a section whose last
//     card it was loses its label with it), flashing its action color at
//     12% for --dur-xs, then sliding on and fading over --dur-sm (the exit,
//     70% of the --dur-md the neighbors and section labels glide up in
//     through useFlip) - then unmounts. It leaves the way it was going: from
//     where a swipe let it go (--from-x), right for a yes, left for a no
//     (--dir);
//   - Undo brings the row back into the data at the same index, and useFlip
//     fades the returning card in while the neighbors glide down;
//   - the count pill bumps (scale 1 -> 1.08 -> 1, --dur-sm) when it changes;
//   - the empty check pops once (--dur-md, --ease-spring).
//   Reduced motion (or a test run) makes every wait 0: no ghost, no swipe,
//   the card is simply gone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, History, Inbox, ListChecks, SlidersHorizontal } from 'lucide-react';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { Modal } from '../tasks/components';
import { MOTION, motionWait, useChangeFlash, useFlip, useReducedMotion } from '../lib/motion';
import { runsInline } from '../lib/approvalActions';
import ApprovalCard from './ApprovalCard';
import FilterSheet from './FilterSheet';
import NoteSheet from './NoteSheet';
import { YES_KEYS, needsNote, sectionize } from './shared';

// The top header is sticky at 64px (under the New Feature bar while it
// shows); a section label sticks right under it.
const STICKY_TOP = 'calc(64px + var(--nx-announce-h, 0px))';
const GHOST_MS = MOTION.xs + MOTION.exit;
// After a decision the list ignores taps until the neighbors have glided up:
// a double tap must never decide the card that slid under the finger.
const LOCK_MS = Math.max(MOTION.md + 150, 350);

export default function ApprovalsPhone({
  tab, setTab, rows, ownRows, hiddenKeys, groupLabels, counts, kind, setKind,
  filters, setFilters, clearFilters, filtering, groupBy, setGroupBy, sortKey, setSortKey,
  deptCounts, companyCounts, seesAll, onAct, DetailView, loading, error, onRetry, errors = [], onReload, canApprove, history,
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [asking, setAsking] = useState(null);        // { row, action } waiting on its note
  const [reviewing, setReviewing] = useState(null);
  const [ghosts, setGhosts] = useState(() => new Map());   // key -> { row, tone, top, fromX, dir }
  const listRef = useRef(null);
  const cardEls = useRef(new Map());
  const timers = useRef(new Set());
  const lockUntil = useRef(0);
  const reduce = useReducedMotion();
  useFlip(listRef);
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);

  const visible = (r) => !hiddenKeys.has(r.key);
  const shown = useMemo(() => rows.filter((r) => !hiddenKeys.has(r.key)), [rows, hiddenKeys]);
  const shownOwn = useMemo(() => ownRows.filter((r) => !hiddenKeys.has(r.key)), [ownRows, hiddenKeys]);
  const sum = (rs) => rs.reduce((t, r) => t + (r.count || 1), 0);
  const waiting = counts.all + sum(shownOwn);
  const bump = useChangeFlash(waiting, MOTION.sm);
  const sections = useMemo(() => sectionize(rows, groupBy, groupLabels), [rows, groupBy, groupLabels]);
  const labelOf = (g) => groupLabels.find((x) => x.key === g)?.label || '';

  // ── acting ──
  // The card leaves the data at once (onAct -> decide -> hide); with motion
  // on, a ghost of it holds its spot for the beat so the eye sees it go.
  const fire = (row, action, note, meta) => {
    lockUntil.current = Date.now() + LOCK_MS;
    const wait = motionWait(GHOST_MS);
    const el = cardEls.current.get(row.key);
    const root = listRef.current;
    if (wait && el && root && runsInline(row, action.key)) {
      const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
      const tone = action.tone === 'primary' || YES_KEYS.has(action.key) ? 'yes' : 'no';
      const fromX = Math.round(meta?.fromX || 0);
      const dir = fromX ? Math.sign(fromX) : tone === 'yes' ? 1 : -1;
      setGhosts((g) => new Map(g).set(row.key, { row, tone, top, fromX, dir }));
      const t = setTimeout(() => {
        timers.current.delete(t);
        setGhosts((g) => { if (!g.has(row.key)) return g; const n = new Map(g); n.delete(row.key); return n; });
      }, wait);
      timers.current.add(t);
    }
    onAct(row, action, note);
  };
  const act = (row, action, meta) => {
    if (Date.now() < lockUntil.current) return;
    if (action.key === 'open' || !runsInline(row, action.key)) { onAct(row, action); return; }
    if (needsNote(action)) { setAsking({ row, action }); return; }
    fire(row, action, '', meta);
  };
  const review = (row) => setReviewing(row);

  const card = (r, own = false) => (
    <div key={r.key} data-flip={r.key} ref={(el) => { if (el) cardEls.current.set(r.key, el); else cardEls.current.delete(r.key); }}>
      <ApprovalCard row={r} own={own} swipe={!reduce} onAct={act} onReview={() => review(r)} />
    </div>
  );
  // The ghosts sit over the list, not inside a section: the section a ghost
  // came from is drawn from its visible cards alone.
  const ghostEls = [...ghosts].filter(([k]) => hiddenKeys.has(k)).map(([k, g]) => (
    <div key={`ghost:${k}`} className={`apv-ph-ghost is-${g.tone}`} style={{ top: g.top, '--from-x': `${g.fromX}px`, '--dir': g.dir }}>
      <ApprovalCard row={g.row} own={g.row.scope === 'act'} ghost onAct={() => {}} onReview={() => {}} />
    </div>
  ));

  const head = (
    <div className="apv-ph-head">
      <div className="apv-ph-title">
        <h2>Approvals</h2>
        {counts && <b key={bump} className={`apv-ph-pill${bump ? ' is-bump' : ''}`} aria-live="polite">{waiting} Waiting</b>}
      </div>
      <div className="apv-tabs" role="tablist" aria-label="Approvals views">
        <button type="button" role="tab" aria-selected={tab === 'waiting'} className={tab === 'waiting' ? 'is-on' : ''} onClick={() => setTab('waiting')}><Inbox size={15} /> Waiting</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'is-on' : ''} onClick={() => setTab('history')}><History size={15} /> History</button>
      </div>
    </div>
  );

  if (tab === 'history') return <div className="apv-phone">{head}{history}</div>;

  const empty = !shown.length && !shownOwn.length && !ghosts.size;
  return (
    <div className="apv-phone">
      {head}
      <div className="apv-ph-chips scroll-tabs" role="tablist" aria-label="Approval kinds">
        <button type="button" role="tab" aria-selected={kind === 'all'} className={`apv-ph-chip${kind === 'all' ? ' is-on' : ''}`} onClick={() => setKind('all')}>All <b>{counts.all}</b></button>
        {groupLabels.filter((g) => counts[g.key] || g.key === kind).map((g) => (
          <button key={g.key} type="button" role="tab" aria-selected={kind === g.key} className={`apv-ph-chip${kind === g.key ? ' is-on' : ''}`} onClick={() => setKind(kind === g.key ? 'all' : g.key)}>{g.label} <b>{counts[g.key] || 0}</b></button>
        ))}
        <button type="button" className={`apv-ph-chip apv-ph-filter${filtering ? ' has-dot' : ''}`} onClick={() => setFilterOpen(true)} aria-label={filtering ? 'Filter (filters on)' : 'Filter'} aria-haspopup="dialog">
          <SlidersHorizontal size={14} /> Filter{filtering && <span className="apv-ph-dot" aria-hidden="true" />}
        </button>
      </div>
      {errors.length > 0 && (
        <div role="status" className="apv-errors">
          {errors.map((e) => <span key={e.source}>{`Couldn't load ${e.label}.`}</span>)}
          <button type="button" className="apv-link" onClick={onReload}>Try Again</button>
        </div>
      )}
      <AsyncSection loading={loading} error={error} onRetry={onRetry}
        errorMessage="Your approvals couldn't be loaded right now - please try again."
        isEmpty={empty}
        skeleton={<SkeletonBlocks count={3} height={132} borderRadius={12} />}
        emptyContent={
          <div className="apv-ph-empty">
            <span className="apv-ph-empty-ic"><CheckCircle2 size={34} /></span>
            <div className="apv-empty-t">{filtering ? 'No approvals match your filters' : 'All caught up'}</div>
            <div className="apv-empty-d">{filtering ? 'Clear the search or the filters to see everything waiting on you.'
              : kind !== 'all' ? `Nothing in ${labelOf(kind)} waiting on you.`
                : canApprove ? 'Nothing waiting on you.' : 'Anything that needs your signature or acceptance will show up here.'}</div>
            {filtering && <button type="button" className="secondary-btn apv-ph-clear" onClick={clearFilters}>Clear Filters</button>}
          </div>
        }>
        <div className="apv-ph-list" ref={listRef}>
          {sections.map((s) => {
            const live = s.rows.filter(visible);
            if (!live.length) return null;
            return (
              <section key={s.key} className="apv-ph-sec" aria-label={s.label || 'Approvals'}>
                {groupBy !== 'none' && (
                  <div className="apv-ph-sec-h" data-flip={`sec:${s.key}`} style={{ position: 'sticky', top: STICKY_TOP }}>
                    <span className="apv-ph-sec-l">{s.label}</span><span className="apv-ph-sec-n">{` · ${sum(live)}`}</span>
                    {s.oldest >= 3 && <StatusLabel label={`Oldest ${s.oldest}d`} color={s.oldest >= 7 ? '#dc2626' : '#d97706'} size="sm" className="apv-ph-sec-old" />}
                  </div>
                )}
                {live.map((r) => card(r))}
              </section>
            );
          })}
          {shownOwn.length > 0 && (
            <section className="apv-ph-sec apv-ph-own" aria-label="Yours To Do">
              <div className="apv-ph-sec-h" data-flip="sec:own" style={{ position: 'sticky', top: STICKY_TOP }}>
                <ListChecks size={13} aria-hidden="true" /><span className="apv-ph-sec-l">Yours To Do</span><span className="apv-ph-sec-n">{` · ${sum(shownOwn)}`}</span>
              </div>
              {shownOwn.map((r) => card(r, true))}
            </section>
          )}
          {ghostEls}
        </div>
      </AsyncSection>
      {filterOpen && (
        <FilterSheet filters={filters} setFilters={setFilters} clearFilters={clearFilters} onClose={() => setFilterOpen(false)}
          sortKey={sortKey} setSortKey={setSortKey} groupBy={groupBy} setGroupBy={setGroupBy}
          deptCounts={deptCounts} companyCounts={companyCounts} seesAll={seesAll} />
      )}
      {asking && (
        <NoteSheet row={asking.row} action={asking.action} onClose={() => setAsking(null)}
          onSubmit={(note) => { const { row, action } = asking; setAsking(null); fire(row, action, note); }} />
      )}
      {reviewing && (
        <Modal title={reviewing.title} onClose={() => setReviewing(null)}>
          <DetailView row={reviewing} kindLabel={labelOf(reviewing.group)} inModal onClose={() => setReviewing(null)}
            onAct={(a) => { setReviewing(null); act(reviewing, a); }} />
        </Modal>
      )}
    </div>
  );
}
