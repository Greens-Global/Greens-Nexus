// The Training module's building blocks (Neil, 11/07/2026). No tile grid:
// a path is a ROW with its ladder (one segment per stage, filled as the
// stage is done - the module's one signature device) and a course is a row
// that reads like a catalog entry: title and description on the left, the
// facts in a column on the right. Levels and kinds are words, not badges.
import { ChevronRight, Check, MapPin, Rocket, BriefcaseBusiness, Building2, Layers } from 'lucide-react';
import ProgressTrack from '../../ui/ProgressTrack';
import { Chip } from '../components/Chips';
import { goKb, minutesText, plural, levelMeta, pathKindMeta, fmtDate } from '../lib';
import { courseAction, shelfOf, stagesOf } from './catalogModel';

export const KIND_ICONS = { onboarding: Rocket, role: BriefcaseBusiness, department: Building2, custom: Layers };

export function LevelChip({ level }) {
  const m = levelMeta(level);
  return m ? <span className="kb-level" style={{ color: m.color }}>{m.label}</span> : null;
}

export function KindChip({ kind }) {
  const m = pathKindMeta(kind);
  const Icon = KIND_ICONS[m.key] || Layers;
  return <Chip color={m.color} plain><Icon size={12} style={{ marginLeft: -2 }} />{m.label}</Chip>;
}

// What a path is for, in words: "Role path for Site Manager", "Department
// training for Accounting", "Onboarding for Operations".
export function pathWho(p) {
  const word = { onboarding: 'Onboarding', role: 'Role path', department: 'Department training', custom: 'Path' }[p.kind] || 'Path';
  return p.audience_text ? `${word} for ${p.audience_text}` : word;
}

// The ladder: one segment per stage (one segment when the path has none),
// filled by how much of the stage is done. The stage being worked on carries
// the live accent; a finished one is green; an untouched one is the track.
// `names` writes each stage's name under its segment.
export function PathLadder({ p, names = false, size = 'md' }) {
  const stages = stagesOf(p);
  const segs = stages.length ? stages : [{ index: -1, name: '', items: p.items || [] }];
  const overdue = !!p.days_overdue && !p.completed_at;
  let seenLive = false;
  return (
    <div className={`kb-ladder ${size}${names ? ' named' : ''}`} role="img" aria-label={`${p.done} of ${p.total} done${stages.length ? ` across ${plural(stages.length, 'stage')}` : ''}`}>
      {segs.map((s) => {
        const done = s.items.filter((i) => i.done).length;
        const pct = s.items.length ? done / s.items.length : 0;
        let state = pct >= 1 ? 'done' : pct > 0 || (!seenLive && p.enrolled && done === 0 && s.items.some((i) => i.status === 'In Progress')) ? 'live' : 'todo';
        if (state !== 'done' && !seenLive) { seenLive = true; if (state === 'todo' && p.enrolled) state = 'next'; }
        if (overdue && state !== 'done') state = 'overdue';
        return (
          <div key={s.index} className={`kb-ladder-seg ${state}`}>
            <i><b style={{ transform: `scaleX(${pct.toFixed(3)})` }} /></i>
            {names && <span className="kb-ladder-name"><span className="kb-ellipsis">{s.name || (segs.length === 1 ? `${plural(s.items.length, 'item')}` : 'Anytime')}</span><span className="kb-ladder-count">{done} of {s.items.length}</span></span>}
          </div>
        );
      })}
    </div>
  );
}

// A path in a list: the name and what it is for, the ladder, the count, one
// button. The whole row opens the path.
export function PathRow({ p, onOpen }) {
  const open = () => (onOpen ? onOpen(p) : goKb('path', p.id));
  const done = !!p.completed_at || (p.total > 0 && p.done >= p.total);
  const facts = [plural(p.total, 'item'), p.stages?.length ? plural(p.stages.length, 'stage') : '', p.est_minutes > 0 ? `about ${minutesText(p.est_minutes)}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="kb-prow" role="link" tabIndex={0} aria-label={`${p.name}, ${p.done} of ${p.total} done`} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <div className="kb-prow-text">
        <div className="kb-prow-title">{p.name}{p.for_me && !p.enrolled && <span className="kb-mark">For Your Role</span>}{done && <span className="kb-mark done"><Check size={12} />Completed</span>}{!!p.days_overdue && !done && <span className="kb-mark late">{plural(p.days_overdue, 'day')} overdue</span>}</div>
        <div className="kb-meta">{pathWho(p)} · {facts}{p.due_date && !done ? ` · due ${fmtDate(p.due_date)}` : ''}</div>
        {p.description && <div className="kb-prow-desc kb-clamp2">{p.description}</div>}
      </div>
      <div className="kb-prow-ladder"><PathLadder p={p} /><span className="kb-meta kb-prow-count">{p.done} of {p.total} done</span></div>
      <button type="button" className={`kb-btn sm${p.enrolled && !done ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{done ? 'Review' : p.enrolled ? (p.done ? 'Continue' : 'Start') : 'View'}<ChevronRight size={14} /></button>
    </div>
  );
}

// A course in the catalog: the entry on the left, the facts on the right.
export function CatalogCourseRow({ c, onOpen, showShelf = false }) {
  const open = () => (onOpen ? onOpen(c) : goKb('course', c.id));
  const overdue = !!c.days_overdue;
  const done = c.my_status === 'Completed';
  const started = c.my_status === 'In Progress' || overdue;
  const shelf = shelfOf(c);
  return (
    <div className="kb-crow" role="link" tabIndex={0} aria-label={`${c.title}, ${c.my_status}`} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>
      <div className="kb-crow-text">
        <div className="kb-prow-title">{c.title}{done && <span className="kb-mark done"><Check size={12} />Completed</span>}{overdue && <span className="kb-mark late">{plural(c.days_overdue, 'day')} overdue</span>}</div>
        {c.description && <div className="kb-prow-desc kb-clamp2">{c.description}</div>}
        <div className="kb-meta kb-crow-facts">
          <LevelChip level={c.level} />
          <span>{plural(c.lesson_count || 0, 'lesson')}</span>
          <span>{minutesText(c.est_minutes) || 'a few minutes'}</span>
          {c.delivery === 'in_person' && <span className="kb-inperson"><MapPin size={12} />In Person</span>}
          {showShelf && shelf !== 'General' && <span>{shelf}</span>}
          {c.code && <span>{c.code}</span>}
        </div>
      </div>
      <div className="kb-crow-side">
        {started
          ? <><ProgressTrack size="sm" value={(c.my_pct || 0) / 100} state={overdue ? 'overdue' : 'live'} label={`${c.title} progress`} valueText={`${c.my_pct || 0}% done`} style={{ width: 120 }} /><span className="kb-meta">{c.my_pct || 0}% done{c.due_date ? ` · due ${fmtDate(c.due_date)}` : ''}</span></>
          : <span className="kb-meta">{done ? `Completed ${fmtDate(c.completed_at)}` : c.due_date ? `Due ${fmtDate(c.due_date)}` : c.assigned ? 'Assigned to you' : ''}</span>}
        <button type="button" className={`kb-btn sm${overdue || (c.assigned && !done) ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }}>{courseAction(c)}<ChevronRight size={14} /></button>
      </div>
    </div>
  );
}
