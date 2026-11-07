// The catalog's tiles (Neil, 11/07/2026): a course as a card with its
// department color, level, time and the person's progress; a path as a card
// with its kind, stages and how far along the person is. Both open with a
// click or Enter and carry one clear button.
import { BookOpen, Clock, MapPin, Rocket, BriefcaseBusiness, Building2, Layers, ChevronRight, Check } from 'lucide-react';
import ProgressTrack from '../../ui/ProgressTrack';
import { Chip } from '../components/Chips';
import { goKb, colorFor, initials, minutesText, plural, levelMeta, pathKindMeta, fmtDate, trainingColor } from '../lib';
import { shelfOf, courseAction } from './catalogModel';

export const KIND_ICONS = { onboarding: Rocket, role: BriefcaseBusiness, department: Building2, custom: Layers };

export function LevelChip({ level }) {
  const m = levelMeta(level);
  return m ? <Chip color={m.color}>{m.label}</Chip> : null;
}

export function KindChip({ kind }) {
  const m = pathKindMeta(kind);
  const Icon = KIND_ICONS[m.key] || Layers;
  return <Chip color={m.color} plain><Icon size={12} style={{ marginLeft: -2 }} />{m.label}</Chip>;
}

function trackState(c) {
  if (c.days_overdue) return 'overdue';
  if (c.my_status === 'Completed') return 'done';
  return c.my_status === 'In Progress' ? 'live' : 'idle';
}

export function CourseTile({ c, onOpen }) {
  const open = () => (onOpen ? onOpen(c) : goKb('course', c.id));
  const shelf = shelfOf(c);
  const color = colorFor(shelf);
  const overdue = !!c.days_overdue;
  return (
    <article className={`kb-tile${c.my_status === 'Completed' ? ' done' : ''}`} role="link" tabIndex={0} aria-label={`${c.title}, ${c.my_status}`}
             onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }} style={{ '--tile': color }}>
      <div className="kb-tile-top">
        <span className="kb-ico" style={{ background: color }} aria-hidden="true">{initials(shelf).slice(0, 1)}</span>
        <span className="kb-tile-chips">
          <LevelChip level={c.level} />
          {c.delivery === 'in_person' && <Chip color="#0f766e"><MapPin size={11} style={{ marginLeft: -2 }} />In Person</Chip>}
          {c.my_status === 'Completed' && <Chip color="#1e7b4e"><Check size={11} style={{ marginLeft: -2 }} />Done</Chip>}
          {overdue && <Chip color="#dc2626">{plural(c.days_overdue, 'day')} overdue</Chip>}
        </span>
      </div>
      <div className="kb-tile-title">{c.title}</div>
      {c.description && <div className="kb-tile-desc kb-clamp2">{c.description}</div>}
      <div className="kb-meta kb-tile-meta">
        <span><BookOpen size={13} />{plural(c.lesson_count || 0, 'lesson')}</span>
        <span><Clock size={13} />{minutesText(c.est_minutes) || 'a few minutes'}</span>
        {shelf !== 'General' && <span>{shelf}</span>}
      </div>
      <div className="kb-tile-foot">
        {c.my_status === 'In Progress' || overdue
          ? <ProgressTrack size="sm" value={(c.my_pct || 0) / 100} state={trackState(c)} label={`${c.title} progress`} valueText={`${c.my_pct || 0}% done`} style={{ flex: '1 1 auto' }} />
          : <span className="kb-meta kb-grow">{c.my_status === 'Completed' ? `Completed ${fmtDate(c.completed_at)}` : c.due_date ? `Due ${fmtDate(c.due_date)}` : c.assigned ? 'Assigned to you' : 'Open to everyone'}</span>}
        <button type="button" className={`kb-btn sm${overdue || (c.assigned && c.my_status !== 'Completed') ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{courseAction(c)}<ChevronRight size={14} /></button>
      </div>
    </article>
  );
}

export function PathTile({ p, onOpen, compact = false }) {
  const open = () => (onOpen ? onOpen(p) : goKb('path', p.id));
  const m = pathKindMeta(p.kind);
  const Icon = KIND_ICONS[m.key] || Layers;
  const done = p.completed_at || (p.total > 0 && p.done >= p.total);
  const pct = p.total ? p.done / p.total : 0;
  const overdue = !!p.days_overdue;
  return (
    <article className={`kb-tile kb-path${done ? ' done' : ''}`} role="link" tabIndex={0} aria-label={`${p.name}, ${p.done} of ${p.total} done`}
             onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }} style={{ '--tile': m.color }}>
      <div className="kb-tile-top">
        <span className="kb-ico" style={{ background: m.color }} aria-hidden="true"><Icon size={17} /></span>
        <span className="kb-tile-chips">
          <Chip color={m.color} plain>{m.label}</Chip>
          {p.for_me && !p.enrolled && <Chip color="#2b6cb0">For Your Role</Chip>}
          {p.enrolled && !done && <Chip color="#1e7b4e">On Your List</Chip>}
          {done && <Chip color="#1e7b4e"><Check size={11} style={{ marginLeft: -2 }} />Completed</Chip>}
          {overdue && <Chip color="#dc2626">{plural(p.days_overdue, 'day')} overdue</Chip>}
        </span>
      </div>
      <div className="kb-tile-title">{p.name}</div>
      {!compact && p.description && <div className="kb-tile-desc kb-clamp2">{p.description}</div>}
      <div className="kb-meta kb-tile-meta">
        <span><Layers size={13} />{plural(p.total, 'item')}{p.stages?.length ? ` in ${plural(p.stages.length, 'stage')}` : ''}</span>
        {p.est_minutes > 0 && <span><Clock size={13} />{minutesText(p.est_minutes)}</span>}
        {p.audience_text && <span className="kb-ellipsis" style={{ maxWidth: 180 }}>{p.audience_text}</span>}
      </div>
      {p.stages?.length > 0 && <StageDots p={p} />}
      <div className="kb-tile-foot">
        <ProgressTrack size="sm" value={pct} state={done ? 'done' : overdue ? 'overdue' : p.done ? 'live' : 'idle'} label={`${p.name} progress`} valueText={`${p.done} of ${p.total} done`} style={{ flex: '1 1 auto' }} />
        <span className="kb-meta" style={{ whiteSpace: 'nowrap' }}>{p.done} of {p.total}</span>
        <button type="button" className={`kb-btn sm${p.enrolled && !done ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{done ? 'Review' : p.enrolled ? (p.done ? 'Continue' : 'Start') : 'View Path'}<ChevronRight size={14} /></button>
      </div>
    </article>
  );
}

// One dot per stage: filled when every item in it is done, half when started.
export function StageDots({ p }) {
  const names = p.stages || [];
  const state = names.map((_, i) => {
    const items = (p.items || []).filter((it) => it.stage === i);
    if (!items.length) return 'empty';
    if (items.every((it) => it.done)) return 'done';
    return items.some((it) => it.done || it.status === 'In Progress') ? 'live' : 'todo';
  });
  return (
    <ol className="kb-stage-dots" aria-label="Stages">
      {names.map((n, i) => <li key={i} className={state[i]} title={n}><span /><span className="kb-ellipsis">{n}</span></li>)}
    </ol>
  );
}

// A small status word with the training color, for lists.
export function StatusDot({ status }) {
  return <span className="kb-chip" style={{ '--c': trainingColor(status) }}>{status}</span>;
}
