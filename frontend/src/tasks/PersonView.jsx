// Task Module - a person's page. Who they are, the work they hold, and where
// they belong: the three things anyone opening a colleague's name wants.
//
// This replaced routing a person straight into the task workspace with an
// assignee filter. That answered "their tasks" and nothing else - no name, no
// role, no teams, and a 12-column grid where a reader wanted a summary. The
// workspace is still one click away ("View All Tasks"), which is the right home
// for filtering and bulk edits.
import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, FolderKanban, Users, AlertTriangle, Plus, Mail } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, btn, card, chip } from './theme';
import { Avatar, EmptyState, useIsMobile } from './components';
import AsyncSection from '../components/AsyncState';
import CreateTaskModal from './CreateTaskModal';
import TaskDetailDrawer from './TaskDetailDrawer';
import { formatDate } from '../lib/datetime';

// Two of these are relative to the VIEWER, not the person being looked at:
// "what did I give them" and "where do we overlap" are the questions you open
// somebody's page to answer, and neither is visible from their task list alone.
const TABS = [
  { key: 'assigned',             label: 'All' },
  { key: 'assignedByYou',        label: 'Assigned By You' },
  { key: 'created',              label: 'Assigned By Them' },
  { key: 'collaboratingWithYou', label: 'Collaborating With You' },
];

// A guest is a real distinction here, not decoration: Asana collaborators sync
// in as guests long before HR has a record, and "why does this person have no
// job title" is answered by the badge rather than by asking someone.
const IDENTITY_META = {
  guest:    { label: 'Guest',    color: NX.amber },
  external: { label: 'External', color: NX.dim },
};

export default function PersonView({ email, name, onBack, onOpenProject, onViewAllTasks }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState('assigned');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(null);

  useEffect(() => {
    let live = true;
    setData(null); setErr('');
    api.getPersonProfile(email)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message || 'Could not load this person.'); });
    return () => { live = false; };
  }, [email, reload]);

  const person = data?.person;
  const identity = IDENTITY_META[person?.identityType];
  const rows = data?.tasks?.[tab] || [];
  const title = person?.displayName || person?.name || name || email;

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, height: '100%', overflow: 'auto', background: NX.canvas }}>
      {/* Header - avatar, name, the facts underneath, actions right */}
      <div style={{ background: NX.surface, borderBottom: `1px solid ${NX.border}`, padding: isMobile ? '14px 14px 16px' : '20px 28px 22px' }}>
        <button onClick={onBack} style={{ ...btn('ghost'), padding: '4px 8px', marginBottom: 10, color: NX.dim }}>
          <ArrowLeft size={15} /> Back
        </button>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: isMobile ? 14 : 18, flexWrap: 'wrap' }}>
          <Avatar email={email} name={title} size={isMobile ? 56 : 76} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: isMobile ? 22 : 28, fontWeight: 800, letterSpacing: '-0.02em' }}>{title}</h1>
              {identity && <span style={chip(identity.color, `${identity.color}1a`)}>{identity.label}</span>}
              {person?.status && person.status !== 'active' && (
                <span style={chip(NX.dim, NX.border2)}>{person.status}</span>
              )}
            </div>
            {person?.jobTitle && (
              <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 3 }}>
                {person.jobTitle}{person.department ? ` · ${person.department}` : ''}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: NX.faint, marginTop: 6 }}>
              <Mail size={13} />
              <a href={`mailto:${email}`} style={{ color: NX.faint }}>{email}</a>
              {person?.location && <span>· {person.location}</span>}
            </div>
            {person && !person.inDirectory && (
              <div style={{ fontSize: 12, color: NX.faint, marginTop: 6 }}>
                Not in the Nexus people directory - their work still shows below.
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button style={btn('primary')} onClick={() => setCreating({ assigneeId: email })}>
              <Plus size={15} /> Assign Task
            </button>
          </div>
        </div>

        {/* Rollup - open / overdue / done, the shape of their load at a glance */}
        {data && (
          <div style={{ display: 'flex', gap: isMobile ? 14 : 26, marginTop: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Open', value: data.stats.open, color: NX.ink },
              { label: 'Overdue', value: data.stats.overdue, color: data.stats.overdue ? NX.red : NX.ink },
              { label: 'Completed', value: data.stats.completed, color: NX.ink },
            ].map((s) => (
              <div key={s.label}>
                <div style={{ fontSize: 20, fontWeight: 800, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
                <div style={{ fontSize: 11, color: NX.faint, textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AsyncSection loading={!data && !err} error={!!err} errorMessage={err}
        onRetry={() => setReload((n) => n + 1)}>
        <div style={{
          display: 'grid', gap: 14, padding: isMobile ? 12 : 18,
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 2fr) minmax(240px, 1fr)',
          alignItems: 'start',
        }}>
          {/* Tasks */}
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 16px 0', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Tasks</div>
              <button style={{ ...btn('ghost'), fontSize: 12.5, color: NX.dim }} onClick={onViewAllTasks}>View All Tasks</button>
            </div>
            <div className="scroll-tabs" style={{ display: 'flex', gap: 2, padding: '8px 12px 0', overflowX: 'auto' }}>
              {TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)} style={{
                  ...btn('ghost'), padding: '6px 10px', borderRadius: 0, whiteSpace: 'nowrap', fontSize: 13,
                  color: tab === t.key ? NX.ink : NX.dim, fontWeight: tab === t.key ? 700 : 500,
                  borderBottom: `2px solid ${tab === t.key ? NX.ink : 'transparent'}`,
                }}>
                  {t.label}
                  <span style={{ marginLeft: 6, fontSize: 11.5, color: NX.faint }}>{data?.tasks?.[t.key]?.length ?? 0}</span>
                </button>
              ))}
            </div>
            <div style={{ borderTop: `1px solid ${NX.border}` }}>
              {rows.length === 0 ? (
                <div style={{ padding: '26px 16px', textAlign: 'center', fontSize: 13, color: NX.faint }}>
                  Nothing here.
                </div>
              ) : rows.map((t) => {
                const overdue = !t.completed && t.dueOn && t.dueOn < new Date().toISOString().slice(0, 10);
                return (
                  <div key={t.id} onClick={() => setOpenId(t.id)} className="stack-table-row"
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${NX.border2}`, cursor: 'pointer' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    {t.completed
                      ? <CheckCircle2 size={16} style={{ color: NX.green, flexShrink: 0 }} />
                      : <Circle size={16} style={{ color: NX.faint, flexShrink: 0 }} />}
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: t.completed ? NX.faint : NX.ink, textDecoration: t.completed ? 'line-through' : 'none',
                    }}>{t.title}</span>
                    {t.projectName && !isMobile && (
                      <span style={{ ...chip(NX.dim, NX.border2), flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.projectName}</span>
                    )}
                    {t.dueOn && (
                      <span style={{ fontSize: 12, color: overdue ? NX.red : NX.faint, flexShrink: 0, fontWeight: overdue ? 700 : 500 }}>
                        {formatDate(t.dueOn)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Projects + Teams */}
          <div style={{ display: 'grid', gap: 14 }}>
            <SideCard title="Projects" icon={FolderKanban} empty="No projects yet."
              items={data?.projects || []}
              onPick={(p) => onOpenProject?.(p.id)} />
            <SideCard title="Teams" icon={Users} empty="Not on a team."
              items={data?.teams || []} />
          </div>
        </div>
      </AsyncSection>

      {openId && <TaskDetailDrawer taskId={openId} onClose={() => setOpenId(null)} />}
      {creating && <CreateTaskModal defaults={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

function SideCard({ title, icon: Icon, items, empty, onPick }) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '12px 16px 10px', fontSize: 15, fontWeight: 700 }}>
        <Icon size={15} style={{ color: NX.dim }} /> {title}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: NX.faint, fontWeight: 600 }}>{items.length}</span>
      </div>
      <div style={{ borderTop: `1px solid ${NX.border}` }}>
        {items.length === 0 ? (
          <div style={{ padding: '16px', fontSize: 12.5, color: NX.faint, textAlign: 'center' }}>{empty}</div>
        ) : items.map((it) => (
          <div key={it.id} onClick={() => onPick?.(it)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 16px', borderBottom: `1px solid ${NX.border2}`, cursor: onPick ? 'pointer' : 'default' }}
            onMouseEnter={(e) => { if (onPick) e.currentTarget.style.background = NX.hover; }}
            onMouseLeave={(e) => { if (onPick) e.currentTarget.style.background = 'transparent'; }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: it.color || NX.blue, flexShrink: 0 }} />
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
