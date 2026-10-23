// Tasks Home's widgets (Neil, Oct 23 2026 Home pass). One header for every
// card - a soft icon chip, a Title Case title, a count and a View All in the
// same place - so the page reads as one set instead of eleven hand-styled
// boxes. Colors are the theme's accents as soft tints (never a solid chip),
// and every chart cell filters something when clicked. The rules behind the
// numbers are homeRules.js.
import { useState } from 'react';
import {
  AlertCircle, ArrowRight, CalendarClock, CalendarDays, CheckCircle2, Circle, Flag, Loader, Repeat,
  Sun, Users, Bell,
} from 'lucide-react';
import { NX, FONT, btn, card, PRIORITY_META, PRIORITY_ORDER } from './theme';
import { Avatar } from './components';
import ProjectIcon from './ProjectIcon';
import { projectLook } from './projectLook';
import { myTasksFootnote } from '../dashboard/myTasksCount';
import { ago } from './updatesText';
import { dayTitle, twoLetterDay, versusLastWeek } from './homeRules';

const tint = (hex, a = '1f') => `${hex}${a}`;

/** Every Home card's frame - the padding phones need, the 16px radius. */
export function WidgetCard({ isMobile, style, children }) {
  return <div style={{ ...card, borderRadius: 16, padding: isMobile ? '14px 14px 12px' : 20, breakInside: 'avoid', ...style }}>{children}</div>;
}

/** The one header: chip, title, count, and the card's way out. */
export function WidgetHeader({ Icon, tone = NX.blue, title, count, sub, action, onTitle, style }) {
  const Title = onTitle ? 'button' : 'h2';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, minWidth: 0, ...style }}>
      {Icon && (
        <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tint(tone), color: tone }}>
          <Icon size={15} />
        </span>
      )}
      <Title {...(onTitle ? { type: 'button', onClick: onTitle } : {})}
        style={{ margin: 0, padding: 0, border: 'none', background: 'transparent', cursor: onTitle ? 'pointer' : 'default', fontFamily: FONT, fontSize: 16, fontWeight: 700, color: NX.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
        {title}
      </Title>
      {count != null && <span style={{ fontSize: 12.5, color: NX.faint, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{count}</span>}
      {sub && <span style={{ fontSize: 12, color: NX.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{sub}</span>}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {action && (typeof action === 'object' && action.label
          ? <ViewAll label={action.label} onClick={action.onClick} />
          : action)}
      </span>
    </div>
  );
}

export function ViewAll({ label = 'View All', onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ ...btn('ghost'), padding: '2px 4px', fontSize: 12.5, fontWeight: 600, color: NX.blue, gap: 4 }}>
      {label} <ArrowRight size={13} />
    </button>
  );
}

const empty = (text) => <p style={{ margin: 0, padding: '12px 0 4px', fontSize: 13, color: NX.faint }}>{text}</p>;

// ── The four tiles ──────────────────────────────────────────────────────────
// Colors say what they mean: late is red, today is amber, the week ahead is
// blue, work under way is green - as tints, like every status label.
const TILES = [
  { key: 'overdue', label: 'Overdue', Icon: AlertCircle, tone: NX.red, title: 'Show overdue tasks' },
  { key: 'today', label: 'Due Today', Icon: CalendarClock, tone: NX.amber, title: 'Show tasks due today' },
  { key: 'week', label: 'This Week', Icon: CalendarDays, tone: NX.blue, title: 'Show tasks due in the next 7 days' },
  { key: 'inProgress', label: 'In Progress', Icon: Loader, tone: NX.green, title: 'Show tasks in progress' },
];

export function FocusTiles({ counts, focus, onPick, active }) {
  const note = myTasksFootnote({ my_open_tasks_undated: focus.undated, my_open_tasks_recurring: focus.recurring });
  return (
    <div style={{ ...card, borderRadius: 16, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {TILES.map(({ key, label, Icon, tone, title }) => {
          const on = active === key;
          return (
            <button key={key} type="button" onClick={() => onPick(key)} title={title} aria-pressed={on} className="nx-home-tile"
              style={{
                display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, textAlign: 'left', cursor: 'pointer',
                padding: '12px 14px', borderRadius: 12, fontFamily: FONT,
                background: tint(tone, '12'), border: `1px solid ${on ? tone : 'transparent'}`,
              }}>
              <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tint(tone, '24'), color: tone }}>
                <Icon size={18} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 24, fontWeight: 800, lineHeight: 1, color: counts[key] > 0 && key === 'overdue' ? tone : NX.ink, fontVariantNumeric: 'tabular-nums' }}>{counts[key]}</span>
                <span style={{ fontSize: 13, color: NX.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
              </span>
            </button>
          );
        })}
      </div>
      {/* The dashboard's number and its two footnotes - the same rule
          (homeRules.focusBucket = backend my_work.task_focus_bucket). */}
      <div style={{ marginTop: 10, fontSize: 12.5, color: NX.faint }} title="In progress, overdue, or due in the next 30 days">
        <strong style={{ color: NX.dim, fontWeight: 600 }}>{focus.focus} need you now</strong>
        {note ? ` · ${note}` : ''}
      </div>
    </div>
  );
}

// ── A task row (the Tasks card, My Day) ─────────────────────────────────────
export function TaskLine({ t, due, dueTone, projectName, project, parentTitle, recurring, compact, onOpen, onToggle }) {
  const prio = t.priority === 'urgent' || t.priority === 'high' ? PRIORITY_META[t.priority] : null;
  return (
    <div data-task-row onClick={() => onOpen(t.id)} className="nx-row-hover"
      style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${NX.border2}`, padding: '8px 6px', margin: '0 -6px', borderRadius: 6, fontSize: 13, cursor: 'pointer', minWidth: 0 }}>
      {onToggle && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(t); }} aria-label={t.completed ? 'Mark Incomplete' : 'Mark Complete'} title={t.completed ? 'Mark Incomplete' : 'Mark Complete'}
          style={{ ...btn('ghost'), padding: 0, color: t.completed ? NX.green : NX.faint, flexShrink: 0 }}>
          {t.completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
        </button>
      )}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none' }}>{t.title}</span>
        {parentTitle && <span style={{ fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>in {parentTitle}</span>}
      </span>
      {recurring && <Repeat size={13} aria-label="Repeats" style={{ color: NX.faint, flexShrink: 0 }} />}
      {prio && <Flag size={13} aria-label={`${prio.label} priority`} style={{ color: prio.color, flexShrink: 0 }} />}
      {project && (
        <span title={projectName} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: compact ? 'none' : 140, minWidth: 0, flexShrink: 1, fontSize: 12, color: NX.faint }}>
          <ProjectIcon project={project} size={12} fallbackColor={NX.purple} />
          {!compact && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectName}</span>}
        </span>
      )}
      {due && <span style={{ fontSize: 12, fontWeight: 600, color: dueTone || NX.dim, flexShrink: 0, whiteSpace: 'nowrap' }}>{due}</span>}
    </div>
  );
}

// ── Projects at Risk (key 'urgent', was "Urgent Tasks") ─────────────────────
export function ProjectsAtRiskWidget({ rows, onOpenProject, onViewAll, isMobile }) {
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={AlertCircle} tone={NX.red} title="Projects at Risk" count={rows.length || null} action={{ label: 'View All', onClick: onViewAll }} />
      {rows.length === 0 ? empty('None of your projects has overdue or due-soon work.') : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(({ p, overdue, dueWeek, total, done }) => {
            const pct = total ? Math.round((done / total) * 100) : 0;
            return (
              <button key={p.id} type="button" onClick={() => onOpenProject(p.id)} className="nx-menu-row"
                style={{ ...btn('ghost'), display: 'block', width: '100%', padding: '6px 6px', margin: '0 -6px', textAlign: 'left', borderRadius: 8, boxSizing: 'content-box' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13, minWidth: 0 }}>
                  <ProjectIcon project={p} size={14} fallbackColor={NX.purple} />
                  <span style={{ fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{p.name}</span>
                  {overdue > 0 && <span style={{ padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: tint(NX.red), color: NX.red, whiteSpace: 'nowrap' }}>{overdue} Overdue</span>}
                  {dueWeek > 0 && <span style={{ padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: tint(NX.amber), color: NX.amber, whiteSpace: 'nowrap' }}>{dueWeek} This Week</span>}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, height: 6, borderRadius: 99, background: NX.border2, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${pct}%`, borderRadius: 99, background: projectLook(p, NX.purple).color }} />
                  </span>
                  <span style={{ fontSize: 11.5, color: NX.faint, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{done}/{total} done</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}

// ── Completed This Week ─────────────────────────────────────────────────────
export function CompletedWeekWidget({ weeks, onOpen, isMobile }) {
  const max = Math.max(1, ...weeks.days.map((d) => d.n));
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={CheckCircle2} tone={NX.green} title="Completed This Week" count={`${weeks.total} task${weeks.total === 1 ? '' : 's'}`} />
      <div role="button" tabIndex={0} title="Show what you completed in the last 7 days" aria-label="Show what you completed in the last 7 days"
        onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
        style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 96, cursor: 'pointer' }}>
        {weeks.days.map((d) => (
          <div key={d.iso} title={`${dayTitle(d.iso)}: ${d.n} completed`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 5, height: '100%' }}>
            {d.n > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: NX.green, fontVariantNumeric: 'tabular-nums' }}>{d.n}</span>}
            <div style={{ width: '100%', maxWidth: 26, height: d.n === 0 ? 3 : Math.max(10, Math.round((d.n / max) * 66)), borderRadius: 99, background: d.n === 0 ? NX.border2 : tint(NX.green, 'b3') }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        {weeks.days.map((d) => <span key={d.iso} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: NX.faint }}>{twoLetterDay(d.iso)}</span>)}
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: NX.faint }}>{versusLastWeek(weeks.total, weeks.lastWeek)}</div>
    </WidgetCard>
  );
}

// ── Week Ahead ──────────────────────────────────────────────────────────────
export function WeekAheadWidget({ days, onPickDay, isMobile }) {
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={CalendarDays} tone={NX.blue} title="Week Ahead" sub="Open tasks due each day" />
      <div style={{ display: 'flex', gap: 8 }}>
        {days.map((d) => (
          <button key={d.iso} type="button" onClick={() => onPickDay(d.iso)} title={`${dayTitle(d.iso)}: ${d.n} due - show them`}
            aria-label={`${dayTitle(d.iso)}: ${d.n} due`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 4px', borderRadius: 12, border: 'none', fontFamily: FONT, background: d.today ? NX.primary : NX.hover, minWidth: 0, cursor: 'pointer' }}>
            <span style={{ fontSize: 11, color: d.today ? 'rgba(255,255,255,.75)' : NX.faint }}>{twoLetterDay(d.iso)}</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: d.today ? '#fff' : NX.ink, fontVariantNumeric: 'tabular-nums' }}>{Number(d.iso.slice(8, 10))}</span>
            <span style={{ minWidth: 20, textAlign: 'center', padding: '1px 6px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: d.n > 0 ? (d.today ? 'rgba(255,255,255,.22)' : tint(NX.blue)) : 'transparent', color: d.n > 0 ? (d.today ? '#fff' : NX.blue) : (d.today ? 'rgba(255,255,255,.45)' : NX.faint) }}>
              {d.n > 0 ? d.n : '·'}
            </span>
          </button>
        ))}
      </div>
    </WidgetCard>
  );
}

// ── By Priority ─────────────────────────────────────────────────────────────
// Priority is a signal (Neil, Oct 14 2026): Urgent red, High amber, the rest slate.
export function ByPriorityWidget({ counts, open, onPick, isMobile }) {
  const max = Math.max(1, ...PRIORITY_ORDER.map((p) => counts[p] || 0));
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={Flag} tone={NX.amber} title="By Priority" count={`${open} open`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {PRIORITY_ORDER.map((p) => {
          const n = counts[p] || 0;
          const m = PRIORITY_META[p];
          return (
            <button key={p} type="button" onClick={() => onPick(p)} title={`Show your open ${m.label} priority tasks`}
              style={{ ...btn('ghost'), display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '2px 0', width: '100%' }}>
              <span style={{ width: 62, color: NX.dim, textAlign: 'left', flexShrink: 0 }}>{m.label}</span>
              <span style={{ flex: 1, height: 9, borderRadius: 6, background: NX.border2, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.round((n / max) * 100)}%`, minWidth: n > 0 ? 10 : 0, borderRadius: 6, background: m.color }} />
              </span>
              <span style={{ fontWeight: 700, color: NX.ink, fontVariantNumeric: 'tabular-nums', width: 22, textAlign: 'right' }}>{n}</span>
            </button>
          );
        })}
      </div>
    </WidgetCard>
  );
}

// ── My Day ──────────────────────────────────────────────────────────────────
export function MyDayWidget({ myDay, onOpenTask, onToggle, onOpenMyDay, isMobile }) {
  const total = myDay.total || 0;
  const done = myDay.done?.length || 0;
  const next = (myDay.open || []).slice(0, 3);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={Sun} tone={NX.amber} title="My Day" count={total ? `${done} of ${total} done` : null} action={{ label: 'Open My Day', onClick: onOpenMyDay }} />
      {myDay.status === 'loading' && !total ? <span className="skel" style={{ display: 'block', height: 40 }} /> : !total ? (
        empty('Nothing on My Day yet. Add tasks from any list\'s More Actions menu, or pick from the suggestions on the My Day tab.')
      ) : (
        <>
          <div role="progressbar" aria-label="My Day progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
            style={{ height: 6, borderRadius: 99, background: NX.border2, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ height: '100%', width: `${pct}%`, borderRadius: 99, background: pct === 100 ? NX.green : NX.amber }} />
          </div>
          {next.length === 0 ? empty('All done for today.') : next.map((t) => (
            <TaskLine key={t.id} t={t} onOpen={onOpenTask} onToggle={onToggle} compact />
          ))}
        </>
      )}
    </WidgetCard>
  );
}

// ── Team Workload (key 'team_members', was "Team Members") ─────────────────
const WORKLOAD_SHOWN = 8;
export function TeamWorkloadWidget({ rows, nameOf, me, onOpenPerson, isMobile }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, WORKLOAD_SHOWN);
  const max = Math.max(1, ...rows.map((r) => r.open));
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={Users} tone={NX.teal} title="Team Workload" count={rows.length || null} />
      {rows.length === 0 ? empty('No teammates yet. Join a team under Teams to see its workload here.') : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map((r) => (
            <button key={r.email} type="button" onClick={() => onOpenPerson(r.email)} className="nx-menu-row"
              title={`${r.open} open, ${r.overdue} overdue, ${r.week} due this week - open their tasks`}
              style={{ ...btn('ghost'), display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '6px', margin: '0 -6px', borderRadius: 8, textAlign: 'left', boxSizing: 'content-box' }}>
              <Avatar email={r.email} name={nameOf(r.email)} size={28} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nameOf(r.email) || r.email}{r.email === me ? ' (You)' : ''}
                </span>
                <span style={{ height: 5, borderRadius: 99, background: NX.border2, overflow: 'hidden', display: 'flex' }}>
                  <span style={{ width: `${(r.overdue / max) * 100}%`, background: NX.red }} />
                  <span style={{ width: `${(r.week / max) * 100}%`, background: NX.amber }} />
                  <span style={{ width: `${((r.open - r.overdue - r.week) / max) * 100}%`, background: tint(NX.teal, '80') }} />
                </span>
              </span>
              <span style={{ fontSize: 12, color: NX.faint, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {r.open} open{r.overdue > 0 && <span style={{ color: NX.red, fontWeight: 600 }}> · {r.overdue} overdue</span>}
              </span>
            </button>
          ))}
          {rows.length > WORKLOAD_SHOWN && (
            <button type="button" onClick={() => setAll((v) => !v)} style={{ ...btn('ghost'), alignSelf: 'flex-start', fontSize: 12.5, color: NX.blue, padding: '4px 0' }}>
              {all ? 'Show Fewer' : `Show All (${rows.length})`}
            </button>
          )}
        </div>
      )}
    </WidgetCard>
  );
}

// ── Teams ───────────────────────────────────────────────────────────────────
export function TeamsWidget({ teams, projects, onViewAll, isMobile }) {
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={Users} tone={NX.purple} title="Teams" count={teams.length || null} action={{ label: 'View All', onClick: onViewAll }} />
      {teams.length === 0 ? empty('You\'re not part of any team yet.') : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {teams.map((d) => {
            const proj = d.projectId ? projects.find((p) => p.id === d.projectId) : null;
            const n = (d.memberIds || []).length;
            const tone = d.color || NX.purple;
            return (
              <button key={d.id} type="button" onClick={onViewAll} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${NX.border}`, borderRadius: 12, padding: 10, cursor: 'pointer', background: NX.surface, textAlign: 'left', fontFamily: FONT }}>
                <span aria-hidden="true" style={{ display: 'flex', width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: tint(tone), color: tone, flexShrink: 0 }}><Users size={16} /></span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: NX.faint }}>{n} member{n === 1 ? '' : 's'}{proj ? ` · ${proj.name}` : ''}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}

// ── Notifications (no longer offered in Add Widgets; kept for those who have it)
export function NotificationsWidget({ notifications, onOpen, isMobile }) {
  const rows = (notifications || []).slice(0, 6);
  const unread = (notifications || []).filter((n) => !n.read).length;
  return (
    <WidgetCard isMobile={isMobile}>
      <WidgetHeader Icon={Bell} tone={NX.blue} title="Notifications" count={unread ? `${unread} unread` : null} />
      {rows.length === 0 ? empty('You\'re all caught up.') : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map((n) => (
            <button key={n.id} type="button" onClick={() => onOpen(n)} className="nx-menu-row"
              style={{ ...btn('ghost'), display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '6px', margin: '0 -6px', borderRadius: 8, textAlign: 'left', boxSizing: 'content-box' }}>
              <span aria-label={n.read ? undefined : 'Unread'} style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: n.read ? 'transparent' : NX.blue }} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, fontWeight: n.read ? 500 : 600, color: NX.ink }}>{n.title}</span>
                {/* pre-line: a grouped notice (a followed project's day) is one line per event. */}
                {n.body && <span style={{ fontSize: 12, color: NX.dim, whiteSpace: 'pre-line' }}>{n.body}</span>}
              </span>
              {n.createdAt && <span style={{ fontSize: 11.5, color: NX.faint, whiteSpace: 'nowrap', flexShrink: 0 }}>{ago(n.createdAt)}</span>}
            </button>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

