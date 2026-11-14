// The Hiring board's pieces (Neil, 11/14/2026, the approved hiring screens):
//
//   nextStep(c)      - the ONE chip a card shows: its next step or what blocks
//                      it, from data the board already has (GET /hr/candidates)
//   boardSummary()   - the line over the board: in progress, interviews this
//                      week, how many need HR
//   CandidateCard    - one card: name in full, role, the chip; days in the
//                      stage live in its title, a dot at 7+ days
//   ClosedColumn     - Hired and Rejected folded into one narrow column of two
//                      count tiles, each opening the list of those candidates
//                      (Neil, Oct 14: they stay reachable on the board). A card
//                      dropped on a tile goes there the same way as before.
import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import AnchoredMenu from '../AnchoredMenu';
import { formatDate, formatTime } from '../../lib/datetime';
import { STAGE_META, candName } from '../HiringCandidateDetail';

const DAY = 86400000;
export const STALE_DAYS = 7;

function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((dayStart(now) - dayStart(t)) / DAY));
}
const dayWord = n => `${n} ${n === 1 ? 'Day' : 'Days'}`;

// { text, tone, needsYou } | null. Tones: gray, blue, purple, green, red, live.
export function nextStep(c, now = Date.now()) {
  switch (c.stage) {
    case 'applied': {
      const age = daysSince(c.createdAt, now);
      const when = age === 0 ? 'New Today' : `${dayWord(age)} Ago`;
      return { text: c.source ? `${c.source} - ${when}` : when, tone: age === 0 ? 'blue' : 'gray' };
    }
    case 'screening':
      if (c.interview && ['scheduled', 'live'].includes(c.interview.status)) return interviewChip(c.interview);
      return { text: 'Schedule Interview', tone: 'blue', needsYou: true };
    case 'interview':
      if (c.interview && ['scheduled', 'live'].includes(c.interview.status)) return interviewChip(c.interview);
      if (c.interview?.status === 'completed' || c.interview?.status === 'scored') return { text: 'Interviewed', tone: 'gray' };
      return { text: 'No Interview Booked', tone: 'gray' };
    case 'decision': {
      const n = c.decisionWaiting;
      if (c.decision || n === 0) return { text: 'Ready To Decide', tone: 'green', needsYou: true };
      if (n > 0) return { text: `Waiting On ${n} ${n === 1 ? 'Vote' : 'Votes'}`, tone: 'gray' };
      return { text: 'Waiting On The Votes', tone: 'gray' };
    }
    case 'offer':
      if (c.offerState === 'signed') return { text: 'Offer Signed', tone: 'green' };
      if (c.offerState === 'out') return { text: 'Offer Letter Out', tone: 'purple' };
      return { text: 'No Offer Letter Set Up', tone: 'red', needsYou: true };
    default:
      return null;
  }
}

function interviewChip(iv) {
  if (iv.status === 'live') return { text: 'Interview In Progress', tone: 'live', icon: true };
  return { text: `${formatDate(iv.at)} ${formatTime(iv.at)}`, tone: 'purple', icon: true,
           title: iv.interviewers?.length ? `With ${iv.interviewers.join(', ')}` : '' };
}

const TONE = {
  gray: ['var(--mist)', 'var(--muted)'],
  blue: ['hsla(var(--color-blue),0.1)', 'hsl(var(--color-blue))'],
  purple: ['hsla(var(--color-purple),0.1)', 'hsl(var(--color-purple))'],
  green: ['hsla(var(--color-green),0.12)', 'hsl(var(--color-green))'],
  red: ['hsla(var(--color-red),0.1)', 'hsl(var(--color-red))'],
  live: ['var(--wk-live-tint)', 'var(--wk-live-ink)'],
};

export function boardSummary(candidates, now = Date.now()) {
  const open = candidates.filter(c => !c.inactive && !['hired', 'rejected'].includes(c.stage));
  const week = now + 7 * DAY;
  const interviews = open.filter(c => c.interview?.status === 'scheduled' && (() => {
    const t = Date.parse(c.interview.at || '');
    return !Number.isNaN(t) && t >= dayStart(now) && t < week;
  })()).length;
  const needs = open.filter(c => nextStep(c, now)?.needsYou).length;
  return { inProgress: open.length, interviews, needs,
           text: `${open.length} in progress · ${interviews} ${interviews === 1 ? 'interview' : 'interviews'} this week · ${needs} ${needs === 1 ? 'needs' : 'need'} you` };
}

export function StepChip({ step }) {
  if (!step) return null;
  const [bg, fg] = TONE[step.tone] || TONE.gray;
  return (
    <span data-step-chip={step.tone} title={step.title || undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: bg, color: fg, lineHeight: 1.4 }}>
      {step.icon && <CalendarDays size={10} style={{ flexShrink: 0 }} />}
      <span style={{ overflowWrap: 'anywhere' }}>{step.text}</span>
    </span>
  );
}

export function CandidateCard({ c, draggable, onOpen, scoreChip = null, now = Date.now() }) {
  const closed = ['hired', 'rejected'].includes(c.stage);
  const days = daysSince(c.stageSince || c.updatedAt, now);
  const stale = !closed && days >= STALE_DAYS;
  const stage = STAGE_META[c.stage]?.label || c.stage;
  const title = `In ${stage} ${dayWord(days).toLowerCase()}${draggable ? ' - drag to another stage' : ''}`;
  const step = nextStep(c, now);
  return (
    <button type="button" onClick={() => onOpen(c)} draggable={draggable} title={title} aria-label={`${candName(c)} - ${title}`}
      onDragStart={e => { e.dataTransfer.setData('text/x-candidate', c.id); e.dataTransfer.effectAllowed = 'move'; }}
      data-candidate={c.id}
      style={{ position: 'relative', display: 'block', width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
        padding: '10px 11px', marginBottom: 8, boxShadow: 'var(--shadow-sm)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
      {stale && <span data-stale="" aria-hidden="true" title={`${dayWord(days)} in ${stage}`}
        style={{ position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: '50%', background: 'var(--warn-fg)' }} />}
      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', lineHeight: 1.3, paddingRight: stale ? 10 : 0, overflowWrap: 'anywhere' }}>{candName(c)}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.roleTitle || c.department || '-'}</div>
      {(step || scoreChip) && (
        <div style={{ marginTop: 7, display: 'flex', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
          <StepChip step={step} />
          {scoreChip}
        </div>
      )}
    </button>
  );
}

function ClosedTile({ stage, count, sub, rows, dragOver, onDragState, onDrop, onOpen, emptyText }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  const hue = STAGE_META[stage].hue;
  const label = STAGE_META[stage].label;
  const over = dragOver === stage;
  return (
    <>
      <button ref={btn} type="button" data-tile={stage} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${count} ${label}${sub ? ` - ${sub}` : ''}`} onClick={() => setOpen(o => !o)}
        onDragOver={e => { if (e.dataTransfer.types.includes('text/x-candidate')) { e.preventDefault(); if (!over) onDragState(stage); } }}
        onDragLeave={() => onDragState('')}
        onDrop={e => { e.preventDefault(); onDrop(e.dataTransfer.getData('text/x-candidate'), stage); }}
        style={{ width: '100%', textAlign: 'left', borderRadius: 12, padding: '12px 12px', cursor: 'pointer', fontFamily: 'Inter,sans-serif',
          background: over ? `hsla(${hue},0.08)` : 'var(--card)', border: over ? `1.5px dashed hsl(${hue})` : '1px solid var(--line)', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${hue})`, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{label}</span>
        </div>
        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--ink)', marginTop: 6, lineHeight: 1 }}>{count}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end" role="dialog" aria-label={`${label} candidates`}
        minWidth={260} style={{ maxWidth: 320, maxHeight: 420, overflowY: 'auto', padding: 6, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', padding: '6px 8px' }}>{label}{sub ? ` - ${sub}` : ''}</div>
        {rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 8px 10px' }}>{emptyText}</div>}
        {rows.map(c => (
          <button key={c.id} type="button" onClick={() => { setOpen(false); onOpen(c); }}
            style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', borderRadius: 8, padding: '7px 8px', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{candName(c)}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.roleTitle || c.department || '-'}</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDate(c.stageSince || c.updatedAt)}</span>
          </button>
        ))}
      </AnchoredMenu>
    </>
  );
}

// Hired in the last 30 days and the rejected still on the board.
export function closedGroups(candidates, now = Date.now()) {
  const recent = now - 30 * DAY;
  const hired = candidates.filter(c => c.stage === 'hired' && !c.inactive)
    .sort((a, b) => String(b.stageSince || b.updatedAt).localeCompare(String(a.stageSince || a.updatedAt)));
  const hiredRecent = hired.filter(c => Date.parse(c.stageSince || c.updatedAt || '') >= recent);
  const rejected = candidates.filter(c => c.stage === 'rejected' && !c.inactive)
    .sort((a, b) => String(b.stageSince || b.updatedAt).localeCompare(String(a.stageSince || a.updatedAt)));
  return { hired, hiredRecent, rejected };
}

export function ClosedColumn({ candidates, dragOver, onDragState, onDrop, onOpen, now = Date.now() }) {
  const { hired, hiredRecent, rejected } = closedGroups(candidates, now);
  // The tile counts the last 30 days; its list also keeps the earlier hires reachable.
  return (
    <div role="group" aria-label="Hired and Rejected" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <ClosedTile stage="hired" count={hiredRecent.length} sub="Last 30 Days" rows={hired} dragOver={dragOver}
        onDragState={onDragState} onDrop={onDrop} onOpen={onOpen} emptyText="Nobody hired yet." />
      <ClosedTile stage="rejected" count={rejected.length} rows={rejected} dragOver={dragOver}
        onDragState={onDragState} onDrop={onDrop} onOpen={onOpen} emptyText="Nobody rejected." />
    </div>
  );
}
