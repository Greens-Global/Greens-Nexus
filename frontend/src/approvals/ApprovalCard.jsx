// One approval on a phone (Neil, 11/02/2026): who, what, how long, and two
// big decisions - the row's inline yes and no as 48px buttons, a third inline
// action (Send Back, Changes) behind "More", which opens Review. A row that
// cannot run in place shows Review and Open instead; a row with only a no
// shows Review beside it. Every button calls `onAct(row, action)` - what the
// action does is lib/approvalActions.js, exactly as on the desktop.
//
// Swipe (touch only, never with reduced motion): drag the card right past
// 40% of its width for the yes, left for the no; the colored backdrop and
// its glyph grow under the card as it moves; under 40% it springs back. The
// decision reads the drag ref, never the painted state (a move and its
// release can land in one render batch); a cancelled pointer (the browser
// took the gesture for a scroll or a zoom) only springs back. A fired swipe
// tells onAct where the card was let go (`{ fromX }`), so its ghost leaves
// from there.
import { useRef, useState } from 'react';
import { ArrowUpRight, Check, MoreHorizontal, X } from 'lucide-react';
import { PrioritySignal } from '../components/StatusLabel';
import { ForChip } from '../components/DelegateApprovals';
import { waited } from '../lib/approvalActions';
import { formatDateTime } from '../lib/datetime';
import { PersonMark, daysWaiting, fullName, layout } from './shared';

const SWIPE_START = 12;   // px of horizontal travel before a touch is a swipe, not a scroll
const SWIPE_FIRE = 0.4;   // of the card's width

export default function ApprovalCard({ row, own = false, ghost = false, swipe = false, onAct, onReview }) {
  const who = fullName(row.person);
  const name = `${row.title}${who ? ` (${who})` : ''}`;
  const { yes, no, open } = layout(row);
  const days = daysWaiting(row);
  const wait = waited(row.createdAt).replace(/ ago$/, '').replace(/^Just now$/, 'Now');
  const openLabel = open?.label && !/^(open|review)$/i.test(open.label) ? open.label : 'Open';

  // ── swipe ──
  const drag = useRef(null);
  const swallow = useRef(0);
  const [dx, setDx] = useState(0);
  const [dragW, setDragW] = useState(1);
  const [snap, setSnap] = useState(false);
  const canSwipe = swipe && !ghost && (yes || no);
  const onPointerDown = (e) => {
    if (!canSwipe || e.pointerType !== 'touch') return;
    drag.current = { x: e.clientX, y: e.clientY, w: e.currentTarget.offsetWidth || 1, on: false, id: e.pointerId, dx: 0 };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const ddx = e.clientX - d.x; const ddy = e.clientY - d.y;
    if (!d.on) {
      if (Math.abs(ddx) < SWIPE_START || Math.abs(ddx) < Math.abs(ddy)) return;
      d.on = true;
      setDragW(d.w);
      setSnap(false);
      try { e.currentTarget.setPointerCapture?.(d.id); } catch { /* not every browser */ }
    }
    const allowed = (ddx > 0 && yes) || (ddx < 0 && no);
    d.dx = allowed ? ddx : ddx * 0.15;   // the way with no action resists
    setDx(d.dx);
  };
  const onPointerEnd = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    swallow.current = Date.now() + 400;   // the tap that ends a swipe is not a tap on a button
    const far = Math.abs(d.dx) >= d.w * SWIPE_FIRE;
    if (far && d.dx > 0 && yes) onAct(row, yes, { fromX: d.dx });
    else if (far && d.dx < 0 && no) onAct(row, no, { fromX: d.dx });
    setSnap(true);
    setDx(0);
    try { e.currentTarget.releasePointerCapture?.(d.id); } catch { /* already released */ }
  };
  // The browser took the gesture (a scroll, a pinch, a call coming in):
  // spring back and decide nothing.
  const onPointerCancel = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    setSnap(true);
    setDx(0);
    try { e.currentTarget.releasePointerCapture?.(d.id); } catch { /* already released */ }
  };
  const onClickCapture = (e) => { if (Date.now() < swallow.current) { e.stopPropagation(); e.preventDefault(); } };
  const pull = Math.min(1, Math.abs(dx) / (dragW * SWIPE_FIRE));

  return (
    <div className="apv-ph-wrap" onClickCapture={onClickCapture}>
      {canSwipe && dx !== 0 && (
        <div aria-hidden="true" className={`apv-ph-swipe ${dx > 0 ? 'is-yes' : 'is-no'}`} style={{ opacity: pull }}>
          <span className="apv-ph-swipe-ic" style={{ transform: `scale(${0.6 + 0.4 * pull})` }}>{dx > 0 ? <Check size={22} /> : <X size={22} />}</span>
        </div>
      )}
      <article className="apv-ph-card" data-key={row.key} data-swipe={canSwipe || undefined} data-kind={row.kind} data-priority={row.priority || undefined} data-count={row.count || 1}
        aria-label={name} aria-hidden={ghost || undefined}
        style={dx || snap ? { transform: `translateX(${dx}px)`, transition: snap ? 'transform var(--dur-sm) var(--ease-spring)' : 'none' } : undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerCancel}
        onTransitionEnd={() => setSnap(false)}>
        <div className="apv-ph-top">
          <PersonMark person={row.person} size={36} />
          <div className="apv-ph-who">
            <div className="apv-ph-name">{who || (own ? 'You' : 'Your Team')}</div>
            <button type="button" className="apv-ph-ttl" onClick={onReview} tabIndex={ghost ? -1 : 0} title="Review the details">{row.title}</button>
          </div>
          <div className="apv-ph-side">
            {wait && <span className={`apv-ph-age${days >= 7 ? ' is-late' : days >= 3 ? ' is-slow' : ''}`} title={row.createdAt ? `Waiting since ${formatDateTime(row.createdAt)}` : ''}>{wait}</span>}
            {row.priority && <PrioritySignal priority={row.priority} />}
          </div>
        </div>
        {(row.detail || row.forName) && (
          <div className="apv-ph-detail">
            {row.detail && <span>{row.detail}</span>}
            {row.forName && <ForChip name={row.forName} />}
          </div>
        )}
        {ghost ? (
          <div className="apv-ph-acts" aria-hidden="true">
            <span className={`apv-ph-btn ${yes ? 'apv-ph-yes' : 'apv-ph-review'}`}>{yes ? <><Check size={18} />{yes.label}</> : 'Review'}</span>
            {no && <span className="apv-ph-btn apv-ph-no"><X size={18} />{no.label}</span>}
          </div>
        ) : (
          <div className="apv-ph-acts">
            {yes
              ? <button type="button" className="apv-ph-btn apv-ph-yes" aria-label={`${yes.label}: ${name}`} onClick={() => onAct(row, yes)}><Check size={18} />{yes.label}</button>
              : <button type="button" className="apv-ph-btn apv-ph-review" aria-label={`Review: ${name}`} onClick={onReview}>Review</button>}
            {no && <button type="button" className="apv-ph-btn apv-ph-no" aria-label={`${no.label}: ${name}`} onClick={() => onAct(row, no)}><X size={18} />{no.label}</button>}
            {!yes && !no && open && row.link?.view && (
              <button type="button" className="apv-ph-btn apv-ph-open" aria-label={`Open: ${name}`} onClick={() => onAct(row, open)}>{openLabel} <ArrowUpRight size={15} /></button>
            )}
            {yes && <button type="button" className="apv-ph-more" aria-label={`More: ${row.title}`} title="Review the whole request" onClick={onReview}><MoreHorizontal size={18} /></button>}
          </div>
        )}
      </article>
    </div>
  );
}
