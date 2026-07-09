// Task Module — Home landing (my work at a glance). Ported from the export's
// nexus/home/HomePage.tsx, re-fitted to the Nexus store + inline-style idiom.
import { useMemo, useState } from 'react';
import { CircleDot, CalendarClock, AlertTriangle, CheckCircle2, Plus, Bell, ChevronRight, Circle } from 'lucide-react';
import { NX, FONT, card, btn, input as inputStyle } from './theme';
import { Avatar, StatusChip, EmptyState } from './components';
import { taskStats, topLevel } from './lib';
import { useTasks } from './TasksContext';

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

// Pretty due-date label ("Today" / "Tomorrow" / "Jul 12").
function dueLabel(iso) {
  if (!iso) return '';
  const t = todayISO();
  if (iso === t) return 'Today';
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  if (iso === tm.toISOString().slice(0, 10)) return 'Tomorrow';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('default', { month: 'short', day: 'numeric' });
}

export default function HomeView({ onNavigate }) {
  const { tasks, notifications, nameOf, myEmail, projectName, createTask } = useTasks();
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const today = todayISO();
  const weekAgo = daysAgoISO(7);

  // My top-level tasks (email is the person id).
  const myTasks = useMemo(
    () => topLevel(tasks).filter((t) => t.assigneeId && myEmail && t.assigneeId === myEmail),
    [tasks, myEmail],
  );
  const stats = useMemo(() => taskStats(myTasks), [myTasks]);

  const openCount = myTasks.filter((t) => !t.completed).length;
  const dueTodayCount = myTasks.filter((t) => !t.completed && t.dueOn === today).length;
  const completedThisWeek = myTasks.filter(
    (t) => t.completed && (t.completedAt ? String(t.completedAt).slice(0, 10) >= weekAgo : false),
  ).length;

  // Incomplete tasks, sorted by dueOn ascending, nulls last.
  const dueSoon = useMemo(
    () => myTasks
      .filter((t) => !t.completed)
      .sort((a, b) => (a.dueOn || '9999-99-99').localeCompare(b.dueOn || '9999-99-99'))
      .slice(0, 8),
    [myTasks],
  );

  // Unread first, then newest.
  const recentNotifs = useMemo(
    () => [...(notifications || [])]
      .sort((a, b) => (a.read === b.read ? String(b.createdAt || '').localeCompare(String(a.createdAt || '')) : a.read ? 1 : -1))
      .slice(0, 5),
    [notifications],
  );

  const firstName = useMemo(() => {
    const n = (nameOf?.(myEmail) || '').trim();
    if (!n || n.includes('@')) return 'there';
    return n.split(/\s+/)[0];
  }, [nameOf, myEmail]);

  const goMine = () => onNavigate?.('tasks', 'mine');

  const submitNew = async () => {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await createTask({ title, assigneeId: myEmail, status: 'not_started', priority: 'medium', type: 'task' });
      setNewTitle('');
    } catch { /* surfaced by store refetch */ }
    setBusy(false);
  };

  const tiles = [
    { key: 'open', label: 'Open', value: openCount, icon: CircleDot, color: NX.blue },
    { key: 'today', label: 'Due today', value: dueTodayCount, icon: CalendarClock, color: NX.amber },
    { key: 'overdue', label: 'Overdue', value: stats.overdue, icon: AlertTriangle, color: NX.red },
    { key: 'done', label: 'Completed this week', value: completedThisWeek, icon: CheckCircle2, color: NX.green },
  ];

  return (
    <div className="nx-scroll" style={{ fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto', background: NX.canvas }}>
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '28px 20px 40px' }}>
        {/* Greeting */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
          <Avatar email={myEmail} name={nameOf?.(myEmail)} size={46} />
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.2 }}>
              Good {greetingWord()}, {firstName}
            </div>
            <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 2 }}>
              {new Date().toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
          </div>
        </div>

        {/* Stat tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
          {tiles.map((s) => (
            <div key={s.key} style={{ ...card, padding: '15px 16px', display: 'flex', alignItems: 'center', gap: 13 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: s.color + '17', color: s.color }}>
                <s.icon size={19} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.05, color: NX.ink }}>{s.value}</div>
                <div style={{ fontSize: 12, color: NX.dim, fontWeight: 600, marginTop: 3 }}>{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Quick add */}
        <div style={{ ...card, padding: 12, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Circle size={17} style={{ color: NX.faint, flexShrink: 0 }} />
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); }}
            placeholder="Add a task for yourself…"
            style={{ ...inputStyle, border: 'none', padding: '6px 2px', fontSize: 14, background: 'transparent' }}
          />
          <button onClick={submitNew} disabled={!newTitle.trim() || busy} style={{ ...btn('primary'), flexShrink: 0, opacity: !newTitle.trim() || busy ? 0.5 : 1 }}>
            <Plus size={15} />Add task
          </button>
        </div>

        {/* Two-column body */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          {/* My tasks due soon */}
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${NX.border2}` }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>My tasks due soon</div>
              <button onClick={goMine} style={{ ...btn('ghost'), padding: '4px 6px', fontSize: 12.5, color: NX.blue }}>
                View all <ChevronRight size={14} />
              </button>
            </div>
            {myTasks.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing assigned to you yet" hint="Add a task above to get started." />
            ) : dueSoon.length === 0 ? (
              <div style={{ padding: '34px 20px', textAlign: 'center', fontSize: 13, color: NX.faint }}>You're all caught up.</div>
            ) : (
              <div>
                {dueSoon.map((t) => {
                  const overdue = t.dueOn && t.dueOn < today;
                  const dueToday = t.dueOn === today;
                  const dueColor = overdue ? NX.red : dueToday ? NX.amber : NX.dim;
                  return (
                    <div key={t.id} onClick={goMine} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderTop: `1px solid ${NX.border2}`, cursor: 'pointer' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = NX.surface2; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 500, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                        {t.projectId && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 600, color: NX.purple, background: NX.purple + '15', padding: '1px 8px', borderRadius: 999 }}>
                              {projectName(t.projectId) || 'Project'}
                            </span>
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize: 12, fontWeight: overdue || dueToday ? 700 : 500, color: dueColor, minWidth: 66, textAlign: 'right' }}>
                        {t.dueOn ? dueLabel(t.dueOn) : 'No date'}
                      </span>
                      <StatusChip status={t.status} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent notifications */}
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: `1px solid ${NX.border2}` }}>
              <Bell size={16} style={{ color: NX.faint }} />
              <div style={{ fontSize: 15, fontWeight: 700 }}>Recent notifications</div>
            </div>
            {recentNotifs.length === 0 ? (
              <div style={{ padding: '34px 20px', textAlign: 'center', fontSize: 13, color: NX.faint }}>You're all caught up.</div>
            ) : (
              <div>
                {recentNotifs.map((n) => (
                  <div key={n.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', borderTop: `1px solid ${NX.border2}` }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: n.read ? 'transparent' : NX.blue, border: n.read ? `1px solid ${NX.border}` : 'none' }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: n.read ? 500 : 700, color: NX.ink }}>{n.title || 'Update'}</div>
                      {n.body && <div style={{ fontSize: 12, color: NX.dim, marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
